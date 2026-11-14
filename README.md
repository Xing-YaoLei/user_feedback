# 批次来源追溯（batch_trace）

按采购批次追溯成品：投入 60 kg 甲批 + 40 kg 乙批，产出批按 6:4 继承来源；后续只领用
其中一部分时，也按同一比例带走来源重量，多轮加工逐层传递。质检输入成品批号即可查到
每个采购批次贡献了多少千克。

## 规则

- **来源唯一**：每个批号要么来自一条采购记录（入库重量），要么来自某张加工单的一个产出。
- **按重量混合**：加工单把本单全部投入混在一起，每个产出按 `产出重量 / 本单总投入`
  继承混合比例。例：甲 60 + 乙 40 → 投入 100，产出批 A（30 kg）含甲 18、乙 12。
- **部分领用按比例**：从批号领用 w 千克，按该批号每千克的来源构成带走来源重量；
  同一加工单的全部产出、以及产出被领走一部分后剩余的部分，每千克构成相同。
- **精确计算**：内部用 `Fraction`，只在最终输出时四舍五入到 0.001 千克（四舍五入，非银行家舍入）。
- **顺序无关**：加工单在 JSONL 中的顺序不影响结果。

## 输入

采购批次 CSV：

```csv
batch_id,weight_kg
P001,100
P002,80
```

也接受中文表头 `批号,入库重量`。批号列名兼容 `batch_id / 批号 / batch / id`，
重量列名兼容 `weight_kg / 入库重量 / weight / 重量`。

加工单 JSONL，每行一张单：

```json
{"order_id": "M-01", "inputs": [{"batch_id": "P001", "weight_kg": 60}, {"batch_id": "P002", "weight_kg": 40}], "outputs": [{"batch_id": "A1", "weight_kg": 30}, {"batch_id": "A2", "weight_kg": 60}], "loss_kg": 10}
```

同样接受 `加工单号 / 投入 / 产出 / 损耗` 以及 `批号 / 重量`。

## 用法

```bash
# 查询成品批号（默认按产出时的完整重量计，贡献合计等于该批重量）
python3 -m batch_trace D1 --purchases examples/purchases.csv --orders examples/orders.jsonl

# 输出完整报告：问题清单、受影响批号与追溯链路、其余成品照常计算
python3 -m batch_trace --report --purchases examples/purchases.csv --orders examples/orders.jsonl

# 按当前剩余重量计（库存视角，扣除已被下游领走的部分）
python3 -m batch_trace --basis remaining --report --purchases examples/purchases.csv --orders examples/orders.jsonl
```

退出码：全部查询结果为 `ok` 且无问题时为 0；查询到受影响/未知批号，或 `--report`
存在问题时为 1；输入文件字段错误为 2。

两种基准的区别：`produced` 回答“这批成品由每个采购批次各贡献多少千克”，合计等于
产出重量；`remaining` 回答“这批成品现在还剩多少千克、其中各来自哪个采购批次”，
合计等于剩余重量。两者每千克的来源构成相同。

查询结果示例（按 `produced` 基准）：

```json
{
  "batch_id": "D1",
  "status": "ok",
  "basis": "produced",
  "produced_kg": 4.0,
  "withdrawn_kg": 0.0,
  "remaining_kg": 4.0,
  "accounted_kg": 4.0,
  "contributions": [
    {"purchase_batch_id": "P001", "weight_kg": 2.4},
    {"purchase_batch_id": "P002", "weight_kg": 1.6}
  ]
}
```

## 数据问题与传播

问题类型（每条有稳定编号如 `I001`）：

| type | 含义 | 起点 |
| --- | --- | --- |
| `missing-batch` | 投入批号既非采购批次也非任何产出 | 该批号 |
| `duplicate-source` | 同一批号有多个来源 | 该批号 |
| `imbalance` | 投入 ≠ 产出 + 损耗（容差 1e-9 kg） | 该加工单的全部产出 |
| `cycle` | 加工单循环引用 | 环内各加工单的全部产出 |
| `over-withdrawal` | 跨加工单累计领用超过可领用量 | 该批号 |

每个问题独立沿“批号 → 领用它的加工单 → 该单全部产出”向下游传播，得到受影响批号及
追溯链路（`chain`，同时给出中文 `chain_text`）。受影响批号不参与计算，其余成品照常计算；
一个批号可同时受影响于多个问题（`issue_ids`），但只列出排序最靠前的主问题。

报告中的 `tainted_batches` 列出每个受影响批号的主问题与链路，`issues[].affected_products`
列出该问题影响到的、仍有剩余重量的成品批及其剩余重量。

## 计算规则与口径

- 一张加工单若投入 60 kg 甲批 + 40 kg 乙批，则该单全部产出每千克都含
  0.6 kg 甲、0.4 kg 乙；30 kg 的产出批即含甲 18 kg、乙 12 kg。
- 从某批领走 10 kg 时，按该批每千克来源构成带走来源；剩余批次的每千克构成不变。
- 损耗按混合比例隐式分摊到来源（产出继承的是投入的比例，不是投入的绝对重量）。
- 各来源贡献在最终输出时分别四舍五入到 0.001 kg，因此四舍五入后的合计可能与该批重量
  有 ±0.001 kg 的差异。

## 测试

```bash
python3 -m unittest discover -s tests -v
```
