# 移交对账工具（reconcile）

把**移交清单（JSONL）**与**目标库存快照（TSV）**按对象键对账，输出按键排序的
差异明细（JSONL）和按结果类型统计的汇总（JSON）。两份输入都可以是乱序的；
打乱任意一侧的输入行，明细与计数完全相同。

## 运行方式

仅依赖 Python 3.10+ 标准库，无需安装第三方包：

```bash
python3 -m reconcile \
  --manifest manifest.jsonl \
  --target   snapshot.tsv \
  --detail   detail.jsonl \
  --summary  summary.json
```

常用选项：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--memory-limit-mib` | `128` | 峰值内存预算；排序分块大小由它推导 |
| `--max-line-bytes` | `4096` | 单行最大字节数，超出即报错退出 |
| `--fan-in` | 由文件描述符上限推导 | 每轮归并最多合并的运行文件数 |
| `--workdir` | 系统临时目录 | 外部排序临时文件目录，结束时整体删除 |
| `--only-differences` | 关 | 明细中省略 `consistent` 行（汇总仍统计） |

输入格式错误、字段缺失、值非法时，以 `reconcile: error: ...` 输出带行号的
诊断信息并以状态码 2 退出，不会产生半截结果。

## 输入格式

### 移交清单（JSONL，每行一个 JSON 对象）

必需字段：`key`、`size`、`sha256`；可选字段：`source`（缺省记为 `default`）。
常见别名（`object_key`/`path`、`bytes`/`length`、`hash`/`checksum` 等）也可识别。
空行被跳过，CRLF 与 BOM 均可处理，`sha256` 比较大小写不敏感。

### 目标库存快照（TSV）

首行必须是表头，包含 `key`、`size`、`sha256` 三列（列序任意、支持别名），
其后每行一条库存记录；允许存在额外列。

## 对账规则（每个对象键在明细中恰好出现一次）

1. **同键同来源的完全相同记录先合并**；合并掉的重复条数计入汇总的
   `identical_records_merged`。
2. **同一来源对同一键给出不同的 `size` 或 `sha256`** →
   `manifest_conflict`（`reason: same_source_conflicting_values`），该键
   **不再参与跨来源比较，也不与目标比较**，无论目标内容是什么。
3. 同一键的各来源内部都一致、但彼此给出的值不同 →
   `manifest_conflict`（`reason: cross_source_disagreement`），同样退出跨来源比较。
4. 无清单冲突的键按四象限分类：

| 结果 | 含义 |
| --- | --- |
| `consistent` | 两边都有且 `size`、`sha256` 完全一致 |
| `missing_in_target` | 清单有、目标无（目标缺件） |
| `extra_in_target` | 目标有、清单无（目标多件） |
| `content_mismatch` | 两边都有但内容不同，`differing_fields` 标明差异字段（`size` 和/或 `sha256`） |

目标侧同键出现互相矛盾的多行时记为 `target_conflict` 并列出不同的值，
不会被静默折叠。冲突报告中来源/取值最多保留 8 项，超出时输出 `"truncated": true`，
但判定与计数不受影响——单键即使有数百万行，内存占用也是有界的。

## 汇总示例

```json
{
  "status_counts": {
    "consistent": 120,
    "missing_in_target": 3,
    "extra_in_target": 2,
    "content_mismatch": 5,
    "manifest_conflict": 1,
    "target_conflict": 0
  },
  "total_objects": 131,
  "input_lines": {"manifest": 134, "target": 128},
  "identical_records_merged": {"manifest": 4, "target": 1},
  "truncated_conflict_reports": 0
}
```

## 128 MiB 内存上限如何保证

- 输入逐行流式读取，单行超过 4 KiB 立即报错，绝不整文件载入；
- 两侧分别做**外部归并排序**：内存分块排序后落盘为运行文件，再按有界
  fan-in 多轮归并；每侧分块预算为内存上限的 25%，其余留给解释器、读取缓冲、
  归并文件句柄与输出缓冲；
- 归并阶段逐键处理，每个键只保留至多两个冲突取值与有界的来源列表，
  与重复记录条数无关；
- 明细与汇总均流式写出，不在内存中累积结果；
- 临时文件在结束（含报错）时清理。

在 30 万行、16 MiB 预算（强制多轮落盘归并）与 128 MiB 预算下实测输出逐字节一致，
峰值 RSS 分别约 29 MiB / 52 MiB；单键 40 万条冲突行仍只输出一行。

## 测试

```bash
python3 -m unittest discover -s tests -v
# 或 pytest（若已安装）
```

覆盖：六种结果分类、差异字段标注、同来源/跨来源冲突、重复合并、乱序确定性、
外部排序多轮归并、字段别名、CRLF/BOM、超长行与各类非法输入。
