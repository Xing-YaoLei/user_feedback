# nested2arrow

把嵌套 NDJSON 流式转换为 Arrow / Parquet，并在回读后**恢复原始结构与缺失语义**的项目。
它不是“能把文件写出来就行”的转换器：字段缺失、显式 `null`、空数组、数组中的 `null`
被明确区分；精确小数不经过二进制浮点；带时区时间按统一时刻存储；跨批次的类型升级与
冲突由可配置契约处理，绝不静默转字符串或丢精度。

## 它解决的语义问题

普通 `json -> parquet` 工具会把下面四件事混为一谈，本项目逐项区分：

| 源 JSON 情形 | 普通工具的后果 | 本项目的处理 |
| --- | --- | --- |
| 字段缺失 `{}` | 变成 `null`，无法与显式 null 区分 | 不写入 struct，且路径不进 `__present__` |
| 显式 `{"x": null}` | 与缺失无法区分 | Arrow null，路径**进入** `__present__` |
| 空数组 `[]` | 与 null 数组混淆 | 长度 0 的 list，无元素路径 |
| 数组里的 null `[1,null]` | null 元素被吞 | list child 上的真实 Arrow null |

回读时以 `__present__` 辅助列剪枝：只有源 JSON 中真实存在的路径才会被还原成 key，
因此“缺失”不会被物化成 `null`。

### 精确小数

* JSON 用 `parse_float=Decimal` 解析，`19.90` 保留两位 scale，不经过 `float`。
* 同一列按 schema 统一的 `decimal128(p,s)`（或 `decimal256`）存储，scale 只增不减。
* 每条 decimal 的**原始文本 token** 以 `$.path#d=19.90` 形式保存在 presence 项里，
  回读时还原逐值的原始 trailing scale（`1.20` 不会变成 `1.2`）。
* 超精度（默认 decimal128 的 38 位）产生带路径的契约冲突，而不是库层面的隐式报错。

### 带时区时间

* ISO-8601 带偏移量的字符串识别为 `timestamp[us, tz=UTC]`，不同偏移量按**同一时刻**归一化。
* 无时区的 naive 时间串默认按普通字符串保存（不擅自假定 UTC）；
  可通过 `allow_naive_datetime` 或路径级 `timestamp` override 改变行为。
* 纳秒精度超出 `timestamp[us]` 时直接报错，不静默截断。

## 可配置契约与冲突矩阵

`contract.json` 为每一类类型相遇定义策略（`fail` / `promote` / `quarantine`）：

* `int_to_int`：整数位宽升级 `int8 → int16 → int32 → int64`（精确、可逆）。
* `int_to_decimal` / `decimal_widen`：整数并入 decimal、precision/scale 放宽，均为精确推广。
* `int_to_float` / `decimal_to_float`：**默认 fail**，因为会丢失精确性。
* `bool_number`、`scalar_string`、`struct_shape`：布尔/字符串/对象与数组的形状冲突，默认 fail。
* `new_field_after_first_batch`：首批之后出现的新字段，默认 fail（schema 漂移可被显式放行）。
* `string_timestamp`：时间戳列收到非时间戳字符串。

`fail` 在写出任何数据前中止并定位冲突；`quarantine` 保留好记录、把冲突记录连同
**原始字节**写入 `errors.parquet` / `errors.jsonl`；`promote` 只允许走明确的精确推广规则，
任何策略都不会把数字静默转成字符串。

## 架构（两遍流式）

```
NDJSON 字节流
  │  read_batches() 按 batch_max_records 切分，内存有界
  ├─ Pass 1  逐行 parse_float=Decimal 解析 → infer_node 类型格 → merge 合并矩阵
  │          产出最终 schema、每批快照、merge/conflict 事件、解析错误（保留 raw bytes）
  ├─ 契约校验：fail 冲突在此中止；precision ceiling 在此定位
  └─ Pass 2  按最终 schema 编码 → 每个 batch 一个 Parquet row group
             encode 失败的记录隔离进 errors.*，不影响同批其他记录
Parquet: data.parquet(record struct, __present__ list<string>)
         errors.parquet(source, line, batch, path, reason, raw_bytes)
report.html: 契约预览 / schema 演化时间线 / 冲突定位（自包含，离线可开）
```

关键模块：

* `typesystem.py` — 类型节点、合并矩阵、Arrow 类型映射。
* `contract.py` — 契约数据类与加载/序列化。
* `inference.py` — 精确解析、时间戳识别、类型推断、精度越界扫描。
* `encoder.py` / `decoder.py` — 双向转换与 presence 语义、decimal 侧车。
* `runner.py` — 两遍流水线、row group、隔离与 fail-fast。
* `errors.py` — 带原始字节与字段路径的错误记录。
* `verify.py` — 结构/值/缺失语义的深度断言（不止检查文件能打开）。
* `report.py` — 自包含 HTML 契约与冲突页面。
* `samples.py` — 确定性、可重复的样本生成器。

## 安装

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'
```

## CLI 用法

```bash
# 1. 生成可重复样本（5 个批次 + 1 个损坏文件 + 契约）
nested2arrow generate-samples ./demo/samples

# 2. 流式转换（多文件共享一个 schema）
nested2arrow convert ./demo/samples/batch_*.ndjson \
  --out-dir ./demo/out --contract ./demo/samples/contract.json

# 3. 深度语义往返验证
nested2arrow verify ./demo/out/data.parquet \
  --inputs ./demo/samples/batch_*.ndjson \
  --contract ./demo/samples/contract.json

# 4. 回读为 JSON lines
nested2arrow decode ./demo/out/data.parquet \
  --inputs ./demo/samples/batch_*.ndjson \
  --contract ./demo/samples/contract.json
```

输出：

* `data.parquet` — `record` struct 列 + `__present__` 辅助列，每批一个 row group。
* `errors.parquet` / `errors.jsonl` — 仅在有错误/隔离记录时生成，含原始字节。
* `report.html` — 浏览器直接打开，含契约、schema 演化、合并事件与冲突定位。

退出码：`0` 成功；`1` 有记录被隔离/解析失败（当 `fail_on_error=true`）；`2` 契约 fail 中止。

## 测试

```bash
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

46 个测试覆盖：类型格合并矩阵、缺失/null/空数组/数组 null 的往返、精确小数 scale 保持、
时区时刻归一、整数升级链、decimal 精度变化、fail-fast 与 quarantine、错误原始字节保留、
row group 流式切分、precision/int64/纳秒边界，以及端到端样本语义验证。
