# SSE 事件采集服务 + 本地可控测试源

纯 Python 3 标准库实现(零第三方依赖)。包含:

- **采集器**(`sse_collect/collector.py`):断点续传、心跳/重连提示处理、缺口识别、崩溃注入;
- **SSE 解析器**(`sse_collect/sse_parser.py`):跨网络分块安全、多行 `data:`、注释心跳、`retry:`;
- **持久化**(`sse_collect/store.py`):SQLite,原始报文 + 结构化记录 + 恢复游标**同事务提交**;
- **测试源**(`sse_collect/source.py`):历史重放、重复事件、连接中途截断、保留期耗尽(410);
- **控制台**(`sse_collect/control.py`):运行控制页 + 事件时间线 + 缺口列表。

## 本机运行

```bash
cd pro5

# 1) 一体化启动:内置测试源 + 采集器 + 控制台
python3 -m sse_collect.app --db demo.db \
    --history 30 --live 100000 --interval-ms 200 --heartbeat-ms 3000 \
    --dups 1 --idless-every 7 --multiline-every 3 --chunk-bytes 8 \
    --no-sequence-check        # 源混发无 id 事件时关闭序号检查

# 2) 打开控制台
open http://127.0.0.1:8902/
```

控制台上可以:启动/停止采集器、重置游标(重放历史,演示去重统计)、
查看游标位置与连续性、缺口记录、实时事件时间线。

### 崩溃注入演练

```bash
# 在第 50 次提交后模拟进程崩溃;随后在控制页点「启动采集」重启,
# 观察 events 不丢不重(已确认事件全部保留,游标从 50 继续)
python3 -m sse_collect.app --db demo.db --crash-after-commit 50 ...

# 在第 50 次提交前崩溃(该事务回滚,事件由上游重传后靠唯一约束去重)
python3 -m sse_collect.app --db demo.db --crash-before-commit 50 ...

# 演练保留期耗尽:先跑到游标 >10,停掉后用保留期 10 重启源并预置旧游标
python3 -m sse_collect.app --db demo.db --history 100 --retention-from 10 ...
```

### 常用场景参数(测试源)

| 参数 | 作用 |
|---|---|
| `--history N` | 历史事件数(id `1..N`),连接时按 `Last-Event-ID` 重放 |
| `--retention-from K` | 最早保留 id;请求更早的历史返回 **410**(保留期耗尽) |
| `--dups N` | 每条事件额外重发 N 次(重复事件) |
| `--truncate-at K` | 第 K 号事件写到一半断开 TCP(仅一次,重连后正常) |
| `--skip K` | 完全跳过第 K 号(制造序号缺口) |
| `--idless-every N` | 每 N 条有 1 条不带 id |
| `--multiline-every N` | 每 N 条有 1 条多行 `data:` |
| `--chunk-bytes N` | 按 N 字节小块写入(模拟网络分块) |
| `--heartbeat-ms N` | 心跳间隔(注释行 `: hb`) |
| `--retry-ms N` | 事件中附带 `retry:` 重连提示 |

也可直连外部源:`--url https://example.com/events`。

## 自动测试

```bash
python3 -m unittest discover -s tests -t . -v
```

26 个用例,覆盖:

- 解析器:逐字节喂入 == 整体喂入、`\r`/`\r\n` 跨块、多行 data、心跳、retry、BOM、
  含 NUL 的 id、截断残余丢弃;
- 持久化:**游标只在提交后推进**(提交前崩溃回滚、提交后崩溃不丢)、重复 id 不回退游标、
  无 id 事件的哈希窗口去重、缺口标记不可自动愈合;
- 端到端:重放+重复去重、截断后续传补齐、410 → 记录缺口且**不跳到最新位置**、
  序号跳变检测、落库前/后崩溃恢复不丢已确认事件、无 id 事件边界、多行 data 与心跳。

## 设计说明

### 恢复游标与事务

每条事件的 **原始报文、结构化记录、游标推进在同一个 SQLite 事务** 中提交
(`Store.commit_event`)。采集器只有在 `commit` 返回后才更新内存状态,因此:

- 落库**前**崩溃 → 事务回滚,游标不动,上游重传后重新入库(唯一约束兜底);
- 落库**后**崩溃 → 事件与游标都已持久化,重启后从游标续传,已确认事件不丢不重。

### 可续传 vs 不可补齐缺口

- 连接断开/截断 → 从 `Last-Event-ID` 续传,属于**可续传**;
- 上游返回 **410**(请求的历史已被保留期淘汰)或检测到**序号跳变** →
  记录 `gaps` 表并把游标 `contiguous` 置 0。默认策略 `stop` 就地停止等待人工介入;
  即使配置 `--gap-policy jump` 从保留期起点重拉,`contiguous` 也**保持为 0**,
  绝不会跳到最新位置后声称连续。该标记一旦置 0 不会自动愈合,只能人工重置。

### 无 id 事件的去重边界(重要)

带 `id` 的事件靠 `UNIQUE(source, event_id)` 实现重放安全。**没有事件编号的消息没有
可靠的去重依据**,本服务只做有限承诺:

- 用 `sha256(event 类型 + data)` 做内容哈希,在每个源**最近 1000 条**无 id 事件的
  窗口内判重(`idless_dedup` 表,窗口会裁剪);
- 窗口之外的重复无法识别;内容恰好相同的两条合法事件也会被误删;
- 无 id 事件不推进恢复游标,重连后可能被重放。

因此对无 id 事件**不承诺 exactly-once**,只有"窗口内尽力去重 + 至少一次"。
需要严格语义的场景,应要求上游为每条事件分配 `id`。

### 心跳与重连提示

以 `:` 开头的注释行解析为心跳,原始记录入库(`raw_events.kind='heartbeat'`)但不推进
游标;`retry:` 字段即时更新采集器重连间隔。
