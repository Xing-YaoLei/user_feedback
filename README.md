# 校准回算工具（backcalc）

面向"校准记录事后补录、质控需复现历史结果"场景的双时态回算与增量重算工具。
纯 Python 标准库实现（SQLite 存储），无第三方依赖。

## 解决的问题

校准记录经常事后补录，但质控需要复现"当时看到的结果"。本工具把两条时间轴分开：

| 时间轴 | 字段 | 含义 |
| --- | --- | --- |
| 登记时间 | `registered_at` | 记录什么时候录入系统，决定它在哪个截止时间之后才"可见" |
| 生效区间 | `[valid_from, valid_to)` | 业务上覆盖哪些测量时刻，左闭右开，`valid_to` 空表示至今 |

## 核心规则

### 1. 按登记截止时间回算

对每条测量，在 `registered_at <= cutoff` 且生效区间覆盖 `measured_at`
的记录中，取**登记时间最晚**的一条，输出回算值与所用校准编号；
找不到任何有效系数时标记为 `uncalibrated`（未校准）。

### 2. 同登记时刻区间重叠 → 指出冲突并保留上次有效结果

同一仪器、同一登记时刻有多条记录在测量时刻同时生效时，该登记组判为冲突，
回退到上一个登记时刻的唯一有效记录：

- 回退命中：结果仍为 `calibrated`，采用更早的校准编号，
  同时在 `conflict_cal_ids` 中保留冲突编号；
- 不存在更早的有效记录：状态为 `conflict`（冲突未决），无回算值。

`conflicts` 命令可在数据层面直接列出所有同仪器、同登记时刻的区间重叠对。

### 3. 快照可复现

每个截止时间的第一次查询会冻结一份快照（`run` / `result` 表）。
之后无论补录多少记录，**用同一截止时间再次查询直接返回旧快照**，
保证"当时的结果"逐值可复现。新记录的登记时间必然更晚，
只影响其登记时间之后的查询。

### 4. 增量重算

一次补录通常只影响一小段。新建快照时以上一快照为基线整体复制，
只重算两类测量：

1. 在两个截止时间之间有新登记校准的仪器的全部测量；
2. 新导入、尚未进入快照的测量。

只有**校准来源实际变化**（状态、校准编号或冲突集合不同）才写入变更清单，
列出测量编号、变更前后的状态/校准编号/回算值。来源未变的测量不重算、不列变更。

> 设计取舍：变更判定以"校准来源"为准。同一校准编号被重新导入且只改了系数
> （编号不变）视为同一来源，不触发变更；系数修订应使用新的校准编号。

## 输入文件格式

支持 CSV（`.csv`）和 JSON Lines（`.jsonl`），可按批次多次导入；
时间为 ISO-8601，带时区偏移时统一归一化为 UTC。

校准记录字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `cal_id` | 是 | 校准编号，全局唯一，重复导入即覆盖 |
| `instrument` | 是 | 仪器标识 |
| `registered_at` | 是 | 登记时间 |
| `valid_from` | 是 | 生效区间起点（闭） |
| `valid_to` | 否 | 生效区间终点（开），空表示开放区间 |
| `coefficient` | 是 | 纯数字表示乘数（回算值 = 读数 × 系数）；含 `x` 的公式如 `x*1.05+0.2` |

测量明细字段：`measurement_id, instrument, measured_at, raw_reading`。

## 命令

```bash
# 分批导入
python -m backcalc --db data.db import-cal  --file examples/cal_batch1.csv
python -m backcalc --db data.db import-meas --file examples/meas_batch1.csv

# 按登记截止时间查询（同截止时间重查复用冻结快照）
python -m backcalc --db data.db query --cutoff 2026-08-01T00:00:00Z
python -m backcalc --db data.db query --cutoff 2026-08-01T00:00:00Z --format json

# 区间重叠冲突清单
python -m backcalc --db data.db conflicts

# 历次查询快照与变更统计
python -m backcalc --db data.db runs

# 导出某次已冻结查询的结果 CSV
python -m backcalc --db data.db export --cutoff 2026-08-01T00:00:00Z
```

查询文本输出中的 `⚠ 同登记时刻冲突 ... 已保留上次有效结果` 即冲突回退标记。

## 存储模型（SQLite）

- `calibration` / `measurement`：按编号 upsert 的明细主表；
- `run`：一次按截止时间的查询，`cutoff` 唯一；
- `result`：每个 run 冻结的逐测量结果（状态、校准编号、回算值、冲突集合）；
- `run_change`：增量重算的前后变更清单；
- `batch`：导入批次审计记录。

## 测试

```bash
python -I -m unittest discover -s tests -t . -v
```

覆盖：最晚登记优先与左闭右开边界、未校准、系数公式、冲突回退、
冲突未决、增量变更清单与仪器隔离、快照复现、新记录不影响更早截止时间、
新测量批次增量纳入、未校准→已校准转换等 12 个场景。
