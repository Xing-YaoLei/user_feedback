# 纸卷检测机 JSONL 日志采集器

采集纸卷检测机写到固定路径的 UTF-8 JSONL 日志，处理文件轮转、半行写入、
坏行隔离与进程重启，保证每条有效记录在本地结果目录中**恰好一份**。

## 运行方式

```bash
# 单元测试（11 个）
python3 -I run_tests.py

# 可重复的端到端演示：轮转 / 半行 / 坏行 / 崩溃 / 重启，自动校验
python3 -I demo.py

# 实际运行采集器
python3 -I run_collector.py \
    --watch-dir  /var/log/inspection \
    --active-name inspection.log \
    --result-dir ./result
```

所有 Python 均以 `-I`（隔离模式）运行，不读取当前目录与 `PYTHONPATH` 中
可能被投毒的模块。

## 目录结构

```
collector/
  line_reader.py   增量字节行读取器（半行滞留、多字节切分还原、绝对偏移）
  checkpoint.py    检查点：临时文件 + fsync + os.replace 原子落盘
  collector.py     采集器主体（目录扫描、轮转跟踪、输出、主循环）
simulator/
  machine_sim.py   设备模拟器（固定路径写入、改名轮转、完成标记）
tests/             单元测试
demo.py            8 阶段可重复演示，末尾自动断言全部正确性要求
run_collector.py   命令行入口
run_tests.py       测试入口
```

结果目录布局：

```
result/
  checkpoint.json        每个被跟踪文件一条状态（偏移、输出长度、完成标志）
  good/<src>.jsonl       解析成功的原始记录，按源文件分别追加
  bad/<src>.jsonl        有换行但无法解析的行，封装为带身份与偏移的信封
  tails/<src>.json       完成标记到达时仍缺换行的残缺尾行（一次性写入）
```

## 关键设计

### 1. 字节级切行，半行与被切开的汉字

`LineReader` 在 `bytes` 上查找 `b"\n"`，不做字符解码。UTF-8 多字节序列的
每个字节都大于 `0x7F`，换行符 `0x0A` 不可能落在汉字内部，因此切下来的
完整行必然终止在字符边界，可以安全解码。没有换行结尾的尾部留在缓冲里，
即使它恰好终止在某个汉字的一半，等后续字节补齐后也能完整还原
（见 `tests/test_line_reader.py` 的逐字节喂入测试）。每行同时报告
在源文件中的绝对字节偏移 `[line_start, line_end)`。

### 2. 同时跟踪新旧文件（轮转）

目录扫描按 `(st_dev, st_ino)` 识别文件身份而不是路径：

- 活动文件被改名后，同一 inode 的状态只更新 `path`，继续跟踪，
  改名后追加的记录照常读取；
- 原路径出现的新 inode 登记为新的源文件，与旧文件并行采集；
- 发现非活动路径的完成标记 `<旧文件名>.done` 时，先读完旧文件剩余字节，
  把仍缺换行的残缺尾行写入 `tails/`，再标记 `finished` 结束跟踪。

### 3. 坏行不阻断后续

有换行结尾但 UTF-8 解码或 JSON 解析失败的行，不进入 `good/`，而是连同
`source_id`、当前路径、行首/行尾字节偏移、原始字节（base64）和错误原因
写入 `bad/<src>.jsonl`，后续行继续正常采集。

### 4. 重启续读与精确一次

每行的处理顺序固定为：

1. 输出（`good/` 或 `bad/`）追加并 `fsync`；
2. 检查点原子写入新偏移和输出文件长度。

检查点通过同目录临时文件 + `fsync` + `os.replace` 落盘，写入要么是旧版
要么是新版，不会出现半截 JSON。重启时：

- 打开源文件并 `seek` 到检查点偏移；
- 先把输出文件 `truncate` 到检查点记录的长度——若崩溃发生在
  “记录已输出、检查点未保存”的窗口，多写的那一行被截掉；
- 从旧偏移重读，该行只重新输出一次，结果目录中恰好一份。

`demo.py` 阶段 6/7 用内置故障注入（`--crash-source/--crash-offset`，
在输出 fsync 之后、检查点保存之前 `os._exit(9)`）真实复现该窗口并验证。

### 5. 停止方式

- SIGTERM / SIGINT：主循环在当前轮处理完后退出；
- 结果目录下放 `.stop` 文件：当一轮扫描没有读到任何新字节时退出，
  保证退出前在盘数据全部处理完（演示与测试使用，重启前自动清除）。
