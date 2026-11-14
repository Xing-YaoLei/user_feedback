# power-ledger — 车间用电按业务日归集与规则变更影响清单

按**北京时间业务日**把电表用电量归到**车间**，算出用电量与费用，并记录**所用规则版本**。
规则（电表归属、电价）变更时，先出一份**影响清单**给财务确认；确认前已发布结果不动，
确认后只重算清单中的日期。

## 安装与运行

```sh
python3 -m power_ledger.cli --help     # 或 pip install -e . 后使用 power-ledger
```

无第三方依赖，Python ≥ 3.9。

## 输入文件

### 电表用电 CSV（`--readings`）

两选一的两种模式（整表二选一，不能在同一个文件里混用两列）：

| 模式 | 必需列 | 增量算法 |
| --- | --- | --- |
| 累计读数 | `meter_id, reading_time, meter_reading` | 同表同表计按时间排序，`本次读数 - 上次读数` |
| 增量 | `meter_id, reading_time, consumption_kwh` | 直接使用 |

* `reading_time` 为用户侧时间戳；不带时区时按北京时间解释，带 `+08:00`/`Z` 等偏移时换算到北京时间。
* 读数只在其**发生时刻**取一次归属与电价，归属于该时刻所在的北京日历日（业务日）。
* 同一表计同一时刻出现两条读数视为输入错误，加载时直接拒绝。
* 累计模式下：首条读数没有基线、读数回退（本次小于上次）都进异常清单且**不推进基线**；
  增量模式下负值进异常清单。

示例数据由 `examples/make_example_data.py` 生成：增量表 `examples/readings.csv`
与累计表 `examples/readings_cumulative.csv` 分开存放。

### 电表归属表（`--attr`）

```csv
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A-M101-01,M-101,WS-A,冲压车间,2026-02-01 00:00:00,
```

### 电价表（`--tariff`）

```csv
rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T-WS-A-01,WS-A,2026-02-01 00:00:00,,0.82
```

* `workshop_id` 留空表示对所有车间生效。
* 区间为 **`[valid_from, valid_to)`：含起点、不含终点**；`valid_to` 留空表示长期有效。
* `rule_id` 可选，缺省时按内容生成；显式给出时全表内必须唯一（用于版本间的「修改」识别）。

## 规则匹配与异常

每条读数在**发生时刻**分别匹配归属与电价：

| 情况 | 处理 |
| --- | --- |
| 归属匹配到 0 条 | `no_attribution`，进异常清单，不计入汇总 |
| 归属匹配到多条 | `multiple_attribution`，进异常清单 |
| 电价匹配到 0 条 | `no_tariff`，进异常清单 |
| 电价匹配到多条 | `multiple_tariff`，进异常清单 |
| 增量无法计算（首条累计读数、累计读数回退、负增量） | 对应提示，进异常清单 |

异常读数**单独列出**，不混入车间汇总。匹配到多条时按 `valid_from`、`rule_id` 排序后列出全部命中规则。

## 首次运行

```sh
python3 -m power_ledger.cli init --store ./ledger \
  --readings examples/readings.csv \
  --attr examples/attr.csv \
  --tariff examples/tariff.csv
```

读取三张表 → 生成规则版本 `1` → 按业务日逐日发布 `ledger/<YYYY-MM-DD>.json`
（含车间汇总、逐条读数的匹配结果、异常清单、`rules_version` 与 `rules_hash`）。

## 规则变更：先出影响清单

```sh
python3 -m power_ledger.cli preview --store ./ledger \
  --attr examples/attr_v2.csv --tariff examples/tariff.csv
```

预览输出：

1. **规则差异** — 新增 / 修改 / 删除（逐字段 before → after）。
2. **影响清单** — 按电表列出：
   * `自 <日期> 起受影响`（首次受影响的业务日）
   * 原因来自 **电表归属** 还是 **电价**（比较的是读数的**实际解析结果**：
     归属看解析到的车间，电价看命中的规则与单价；只收紧区间终点、不改变
     区间内命中结果的修改，不会给区间内读数打原因；归属修复连带的电价
     命中变化归为归属原因）
   * 每个受影响日期的读数条数、归属与费用的 before → after
3. **逐日变化** — 车间汇总 before → after；只列有变化的日期，其余进入「未变化日期」。
4. **异常清单变化** — 新增异常、**原本异常恢复正常**（如新规则补上了缺失的电价）、异常类型变化。
5. 候选规则版本与确认命令。

输入类异常（首条无基线、回退、负增量、重复时刻）不参与规则解析，
不会被打上归属/电价原因。

**预览期间不会修改任何已发布结果**（`ledger/` 目录保持原样）。

## 确认发布

```sh
python3 -m power_ledger.cli confirm --store ./ledger --preview 1
```

* 只重算并替换**预览清单中的日期**，其余日期（含未变化日期）保持原样。
* 重算使用已存的原始读数与预览时的候选规则版本，结果与预览一致。
* 并发保护：若这些日期的已发布结果或原始读数在预览后发生变化，整次确认被拒绝且不写入任何日期。
* 同一预览不能重复确认。

## 查询

```sh
python3 -m power_ledger.cli show --store ./ledger --day 2026-03-03
python3 -m power_ledger.cli versions --store ./ledger
python3 -m power_ledger.cli previews --store ./ledger
```

## 账本目录

```
ledger/
  meta.json            当前规则版本、计数器、数据源摘要
  versions/<id>.json   不可变规则版本（含 content_hash）
  readings/<day>.json  该业务日的原始读数（预览/确认的比较基线）
  ledger/<day>.json    已发布结果（确认后才替换）
  previews/<id>.json   预览（pending / confirmed / rejected，拒绝时带原因）
```

所有写入都是「临时文件 + 原子替换」，中断不会留下半个结果文件。
确认前会复核受影响日期的原始读数与已发布结果的字节哈希；
任何一个在预览后发生变化，整次确认被拒绝、不写入任何日期，
该预览同时标记为 `rejected`，不能重复确认。

## 测试

```sh
python3 -m pytest tests -q     # 25 个单元/集成测试（需安装 pytest）
python3 -I scripts/smoke.py    # 无第三方依赖的端到端冒烟（含并发保护）
```

重新生成示例数据：

```sh
python3 -I examples/make_example_data.py
```
