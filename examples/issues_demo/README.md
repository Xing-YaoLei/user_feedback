# 五类问题演示数据

这个目录在一套数据里同时制造五种问题，配合 `--report` 可以看到问题清单、
受影响批号与追溯链路，以及未受影响成品照常计算：

| 问题 | 位置 |
| --- | --- |
| 缺失批号 `missing-batch` | `GHOST` 没有任何来源，被 M-01 投入 |
| 重复来源 `duplicate-source` | 采购 CSV 中 `DUP` 出现两次（10 kg、20 kg） |
| 投入产出不平 `imbalance` | M-03 投入 50、产出 49、损耗 0 |
| 循环引用 `cycle` | M-06 与 M-07 互相领用对方产出 |
| 跨单累计超量 `over-withdrawal` | `F1` 只产出 4 kg，却被累计领用 10 kg |

运行：

```bash
python3 -m batch_trace --report \
  --purchases examples/issues_demo/purchases.csv \
  --orders examples/issues_demo/orders.jsonl
```

未受任何问题影响的成品 `E1`、`G1` 仍会正常给出采购批次贡献；
退出码为 1，表示报告中存在问题。
