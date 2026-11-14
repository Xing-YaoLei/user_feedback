# 分馆抽样与总馆合并（audit-sampling）

按分馆扫描报纸版面记录，分馆各自生成可合并摘要，总馆汇总后得到复核名单。
用同一个种子时，**分馆分别抽样再合并的结果，与总馆一次读完全部记录直接抽样完全一致**。

## 快速开始

分馆侧（每个分馆跑一次，单次顺序扫描）：

```bash
python3 -m audit_sampling.cli summarize \
    --seed 2026Q4 \
    --quota quota.json \
    --reviewed reviewed.json \
    --input branch-01-part-1.jsonl.gz \
    --input branch-01-part-2.jsonl.gz \
    --out branch-01.summary.json \
    --label branch-01
```

总馆侧（读取所有摘要，输出复核名单和分层报表）：

```bash
python3 -m audit_sampling.cli merge \
    --summary branch-01.summary.json \
    --summary branch-02.summary.json \
    --summary branch-03.summary.json \
    --quota quota.json \
    --selection selection.json \
    --report report.json
```

终端上同时打印每层的合格数量、抽中数量和缺额：

```
language  tier      quota  eligible  selected  shortfall
-------------------------------------------------------
en        low           4       812        4          0
en        high          3      1904        3          0
ja        low           2        77        2          0
zh        low           7      1233        7          0
zh        high          5      2601        5          0
-------------------------------------------------------
TOTAL                  21      6627       21          0
```

`direct` 子命令走一遍总馆直接抽样的参考实现，用于核对：

```bash
python3 -m audit_sampling.cli direct --seed 2026Q4 --quota quota.json \
    --reviewed reviewed.json --input all.jsonl.gz --out direct.json
```

## 输入

版面记录为 gzip 或纯文本 JSONL，每行一条：

```json
{"page_id": "NLC-2026-0417-0032", "language": "zh", "confidence": 0.91}
```

* `page_id`：全局唯一（分馆之间不重复）。
* `language`：语种，任意字符串。
* `confidence`：OCR 置信度，`0..1` 的有限数值。

字段别名也接受 `id`/`pageId`、`lang`、`ocr_confidence`/`ocr_conf`。

配额表（JSON）：

```json
{
  "zh": {"low": 7, "high": 5},
  "en": {"low": 4, "high": 3},
  "ja": {"low": 2}
}
```

未写出的层按 0 配额处理；数据里出现但配额表没有的语种/层照常统计，配额为 0，
因此抽中 0 条、缺额也是 0。

已复核清单支持 JSON 数组、`{"ids": [...]}`、`{"page_id": "..."}`、JSONL 或每行一个 ID 的纯文本。

## 算法与保证

1. **排除**：先剔除已复核版面，之后不再计入任何统计。
2. **分层**：`(language, confidence < 0.8 ? "low" : "high")`，阈值恰好 0.8 归入 `high`。
3. **优先级**：`priority = sha256("audit-sampling/priority/v1" \0 seed \0 page_id)`。
   它只依赖种子和版面 ID，与记录顺序、文件划分、机器都无关。
4. **各层 bottom-k**：每层保留 `(priority, page_id)` 最小的 `quota` 条记录。
   * 分馆摘要：每层只保存 `eligible` 计数和 ≤ quota 条候选（`priority`, `page_id`），
     单次扫描即可生成，内存与输入规模无关。
   * 合并：各分馆候选取并集后再取该层最小的 quota 条。
   * 因为 `∪ 各分区的 bottom-k = 全量的 bottom-k`，合并结果与总馆直接抽样逐 ID 相同。

由此得到要求的三个不变性，测试中逐一覆盖：

* 打乱记录顺序 → 名单不变；
* 改变分馆之间的文件划分 → 名单不变；
* 改变摘要合并顺序 → 名单不变。

同时校验：种子/阈值/配额表不一致、摘要中优先级被篡改、候选数不等于
`min(quota, eligible)`、同一版面 ID 出现在两份摘要的候选中、非法置信度，都会报错而不是静默产出错误名单。

## 摘要格式

```json
{
  "schema": "audit-sampling/summary/v1",
  "seed": "2026Q4",
  "threshold": 0.8,
  "quota": {"zh": {"low": 7, "high": 5}, ...},
  "strata": {
    "zh": {
      "low": {
        "eligible": 1233,
        "candidates": [{"page_id": "...", "priority": "..."}]
      }
    }
  },
  "label": "branch-01"
}
```

`report.json` 每层给出 `quota` / `eligible` / `selected_count` / `shortfall` /
`selected_page_ids`，以及 `totals`。`selection.json` 是平铺的复核名单，带语种、层和优先级。

## 测试

```bash
python3 -m unittest discover -s tests -t . -v
```

测试覆盖合并等价性（多种划分、乱序、乱序合并）、底 k 截断、已复核排除、
阈值边界、缺额统计、摘要 JSON 往返与篡改检测、CLI 端到端（gzip 输入）。
