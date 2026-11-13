# 按日期计算指标（metriccalc）

一个小工具，解决"按日期汇总指标、补录数据后只重算受影响部分"的问题。

* **使用者定义计算节点**：每个节点要么读取某个源序列，要么把若干上游节点在
  指定日期偏移区间内的值加起来（支持 `from="start"` 的累计指标、负权重）。
* **源数值按日期记录**：导入后仅实际变化的记录会推进版本。
* **首次运行**：按目标节点与日期范围计算，每个节点每天产出一个汇总值；为
  满足上游滚动窗口，目标范围之外必要的历史日期也会一并计算并持久化。
* **补录/更正后**：先**预览**——哪些节点、哪些日期要重算，哪些结果能复用，
  以及每个判断的原因；确认后**执行**。滚动指标按"该分区实际读取的日期范围"
  判断影响，而不是粗暴地重算整条时间线。
* **预览过期保护**：预览之后源数据或计算规则又变了，执行时会被拒绝并提示
  重新预览。
* **中断可续**：中途退出后重跑，已算完且输入未变的分区直接复用。

## 安装与运行

只依赖 Python 3.8+ 标准库（SQLite 持久化），无需第三方包。

```bash
python -m metriccalc --help
```

## 节点配置

```json
{
  "anchor": "2026-01-01",
  "nodes": [
    {"name": "orders",       "type": "source", "source": "orders"},
    {"name": "orders_7d",    "type": "sum", "inputs": [{"node": "orders", "from": -6, "to": 0}]},
    {"name": "orders_7d_prev","type": "sum", "inputs": [{"node": "orders_7d", "from": -7, "to": -7}]},
    {"name": "orders_7d_wow", "type": "sum",
     "inputs": [{"node": "orders_7d"}, {"node": "orders_7d_prev", "weight": -1}]},
    {"name": "cum_orders",    "type": "sum", "inputs": [{"node": "orders", "from": "start", "to": 0}]}
  ]
}
```

* `source` 节点：读取源序列 `source`；`"missing": "zero"`（默认）缺失日期按 0，
  `"error"` 则该分区记为阻塞。
* `sum` 节点：把每个输入在其日期区间内的上游节点值加权求和。
  * `offset: -3` 等价于 `from: -3, to: -3`；
  * `from`/`to` 是相对当天的天数偏移（≤ 0，不能指向未来）；
  * `from: "start"` 表示从 `anchor` 锚点到当天（累计指标），需要配置 `anchor`；
  * 区间可以互相重叠，同一输入可以按不同权重重复引用。
* 节点间自动做拓扑排序；循环依赖、未知引用、非法字段都会报错。

完整示例见 `examples/metrics.json`。

## 使用流程

```bash
# 1. 导入源数值（CSV: source,date,value；或 JSON）
python -m metriccalc --db metrics.db import examples/sources.csv

# 2. 首次运行（还没有可复用结果，直接执行）
python -m metriccalc --db metrics.db run \
    --config examples/metrics.json --target orders_7d_wow \
    --start 2026-01-08 --end 2026-01-12

# 3. 补录/更正某天
python -m metriccalc --db metrics.db import corrected.csv

# 4. 预览影响（不写结果）
python -m metriccalc --db metrics.db preview \
    --config examples/metrics.json --target orders_7d_wow \
    --start 2026-01-08 --end 2026-01-12

# 5. 确认后执行
python -m metriccalc --db metrics.db apply <预览ID>

# 6. 查看结果与状态
python -m metriccalc --db metrics.db show \
    --config examples/metrics.json --target orders_7d_wow \
    --start 2026-01-08 --end 2026-01-12
python -m metriccalc --db metrics.db status
python -m metriccalc --db metrics.db sources --source orders
```

预览会输出类似：

```
预览 3f9a1c02b77e
目标节点：orders_7d_wow（汇总节点 = orders_7d（+0 天） + orders_7d_prev（-7 天 × -1））
日期范围：2026-01-08 .. 2026-01-12
锚点日期：2026-01-01（本次未使用）

结论：需重算 6 个分区，可复用 25 个分区
  orders_7d_wow    [sum]     5 个分区  需要日期 2026-01-08..2026-01-12   重算 1、复用 4
  ...

  ▶ orders_7d_wow 需要重算 1 个分区
     • 读取的源值或上游值变了  涉及 1 天：2026-01-10
     逐日示例（实际读取范围）：
       2026-01-10  orders_7d_wow   依赖：orders_7d（2026-01-04..2026-01-10）；…
```

## 设计要点（为什么只重算该重算的）

每个分区（节点 × 日期）在计算时会记录：

1. **自身规则签名**：该节点的配置内容（规范化 JSON 后的哈希）；
2. **依赖签名**：所有祖先节点规则签名（用到 `from=start` 时还含锚点）；
3. **实际读取的输入**：源节点记录 `(源, 当天, 当时的值)`；汇总节点记录它读到的
   每个上游 `(节点, 日期, 当时的值)`。缺失的源值也按 `空` 记录。

复用条件是这三者都一致，且本轮计划里没有任何上游输入会被重算。由此：

* 滚动窗口 `-6..0` 的指标，只有真正读到被改日期的分区失效，**其余日期原样
  复用**——这正是"按实际读取的日期范围判断影响"。
* 只看"读到的值"而不是"上游算过没有"：上游重算后值恰好没变，下游仍可复用。
* 周对比、累计指标也只在它们读取的日期上传播，不做"整条时间线重算"。
  例如目标只有 01-20 时，周对比只需要 01-20 与 01-13 两个 `orders_7d`
  分区（以及它们各自的 7 天源窗口），不会把 12 月的历史全算一遍。
* 规则变化按节点粒度处理：只有改动的节点及其下游会失效；仅调整书写顺序、
  显式写出默认值等语义等价的修改不算规则变化。
* 预览会把本次计划会读取的全部源值快照存库，执行前重新计算指纹；不同则拒绝
  执行并指出具体是哪个源、哪天、从什么变到什么。配置文件内容变化同理。

## 中断与续跑

执行时 pending 标记在即将计算某个分区前才写入，因此进程中断后：

* 已完成的分区保持 `done`；
* 最多一个分区停在 `pending`（会重新计算）；
* 重新预览时，输入未变的分区全部可复用，只补算剩余部分。

`status` 子命令可查看遗留的 pending 分区与最近运行记录。

## 局限

* 源值只支持"按日期一个数值"，不做多列/多实体维度。
* 重算判定以"上次实际读取的输入"为准；如果某个分区在旧版本工具下没有保存
  输入快照，它会被当作"需要重算"，这只会多做一次计算，不会算错。
* 并发写同一存储时，SQLite 会串行化写入；建议单进程使用。
