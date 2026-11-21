# 关联订阅引擎 (Correlation Subscription Engine)

按**关联键 (key)** 订阅一段跨事件关系：每个 **A** 在之后 `T` 时间内选择一个 **B**，
A 与 B 之间不能有 **C**，且 A、B 各自至多参与一次匹配。来源尚未追平时先给出**暂定结果**，
迟到事件到达后再修正；当全局进度越过某个 A 的完整匹配期限后，其结果**终结**且此后保持稳定。

用 TypeScript 实现，运行在 Node.js（原生可擦除类型语法，无需编译步骤）。

## 快速开始

```bash
npm test     # 运行全部真实断言（含交错、迟到、崩溃恢复、背压场景）
npm run demo # 可读的端到端演示
```

要求 Node.js ≥ 22.6（本环境 Node v26）。仅使用内置 `node:test` / `node:assert`，无外部依赖。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| **事件身份** | 唯一 `id`；`source` 与不可变 `time` 也属于身份的一部分。同 id 同内容 = 去重；同 id 不同内容 = 冲突 |
| **来源集合** | 构造时给定的有限来源列表，每个来源维护一条单调不减水位 |
| **水位 (watermark)** | 承诺该来源后续事件时间 `< watermark` 不会再出现 |
| **全局进度 (progress)** | 所有来源水位的最小值 |
| **匹配期限** | 某个 A 的 `time + T`；当 `progress > a.time + T` 时结果终结 |
| **匹配地平线** | `progress - T`；`time` 低于此值的 B/C 不再影响任何未终结的 A，可回收 |

## 匹配规则（按关联键独立执行）

对同一关联键内的事件：

1. 按 **事件时间**、再按 **ID** 排序；
2. 依次为每个 A 选择**最早可用**的 B，满足：
   - `A.time <= B.time <= A.time + T`（闭区间）；
   - 区间 `[A.time, B.time]` 内没有任何 C 事件；
   - 该 B 尚未被其他 A 使用；
3. A 与 B 一旦匹配，各自不再参与其他匹配。

由于输入已排序、所有并列用 ID 决出，**最终结果只取决于事件集合，与到达顺序无关**。
引擎内部复用同一个纯函数 `matchKeyEvents`，因此暂定结果、终结结果与
`referenceMatches`（对完整输入排序后一次性执行规则）三者一致。

## API 概览

`src/index.ts` 导出全部入口：

```ts
import {
  CorrelationEngine,
  CorrelationSubscription,
  referenceMatches,
  type CorrelationEvent,
} from './src/index.ts';

const engine = new CorrelationEngine({
  sources: ['left', 'right'], // 有限来源集合
  windowMs: 10,               // T
  maxRecords: 100_000,        // 可选：工作记录容量上限（超出返回背压）
});

// 1) 摄入事件，返回本次的暂定匹配“整组撤销 + 新增”
const r = engine.ingest({ id: 'b1', source: 'right', key: 'k', type: 'B', time: 6 });
// r.status: 'accepted' | 'duplicate' | 'conflict' | 'late' | 'unknown-source' | 'invalid' | 'backpressure'
// r.delta:  { retracted: Match[]; added: Match[] }

// 2) 推进来源水位，返回本次终结的匹配与回收数量
const w = engine.advanceWatermark('right', 100);
// w.status / w.progress / w.finalized / w.delta / w.reclaimed

// 3) 只读视图
engine.snapshot(); // { provisional, final, all }
engine.stats();    // 水位、进度、地平线、记录数、各部分计数……

// 4) 流结束：把所有来源水位推到 +Infinity，全部终结
engine.end();
```

### 订阅封装

`CorrelationSubscription` 把引擎结果按单个关联键转成有序回调：

```ts
const { subscription, engine } = CorrelationSubscription.create(
  { sources: ['left', 'right'], windowMs: 10 },
  'orders',
  (update) => {
    if (update.kind === 'provisional') {
      // update.delta.retracted / update.delta.added（仅该 key）
    } else {
      // update.matches：该 key 本次终结的匹配
    }
  },
);
subscription.ingest(event);
subscription.advanceWatermark('right', 100);
subscription.end();
```

## 关键行为

### 暂定 → 修正 → 终结

- 每接收一个**合法**事件，`ingest` 返回相对“当前暂定匹配集”的整组 `retracted`/`added`。
- **迟到的较早 A** 可以重新分配已匹配的 B：旧匹配进入 `retracted`，新匹配进入 `added`。
- **迟到的 C** 若落在 `[A.time, B.time]` 内，会使匹配失效（`retracted`）。
- `progress > a.time + T` 时该 A 的结果终结，之后**冻结不再变化**。

### 拒绝与去重

- `time < 该来源水位` → `late`，统一拒绝（等于水位允许）。
- 同 id 同内容 → `duplicate`（静默去重，无 delta）。
- 同 id 不同内容（来源 / 键 / 类型 / 时间任一不同）→ `conflict`。

### 背压与回收

- `seen` 中的工作记录达到 `maxRecords` 时，新事件返回 `backpressure`，**状态完全不变**。
- 但**水位推进仍会触发终结与回收**，从而释放容量——被拒绝的只是新事件，不是进度。
- 去重记录仅在 `watermark(source) > event.time` **且** `event.time < 匹配地平线`、
  且未被任何活跃事件或终结匹配引用时才回收。B/C 活跃事件在地平线以下即回收。

### 崩溃恢复

引擎状态可经 `stats().watermarks` + 已接受事件集重建（见 `test/recovery.test.ts`）。
测试验证：中途“崩溃”后重建并继续摄入，最终结果与不中断运行完全一致；
每个事件重复投递两次（至少一次语义）也得到相同结果。

## 目录结构

```
src/
  types.ts        # 值类型、排序与相等语义
  matching.ts     # 纯函数匹配规则（无状态，所有结果的一致性来源）
  engine.ts       # 状态引擎：水位、去重、暂定/终结、回收、背压
  reference.ts    # 参考实现：对完整输入排序后一次性执行规则（验证用）
  subscription.ts # 按关联键的回调封装
  index.ts        # 公共导出
test/
  matching.test.ts      # 规则单测（窗口、C 阻断、最早 B、ID 破平）
  engine.test.ts        # 去重/冲突/迟到/水位/终结/背压
  scenarios.test.ts     # 题目要求场景：迟到 A 重分配、迟到 C 失效、水位推进对比
  reclamation.test.ts   # 回收边界：地平线两侧的 B/C
  finalization.test.ts  # 终结不扰动后续暂定匹配
  equivalence.test.ts   # 随机交错下“终结结果 = 完整输入规则”
  stress.test.ts        # 流中途推进水位的压力测试（60 组种子）
  recovery.test.ts      # 崩溃重建与重复投递幂等
  subscription.test.ts  # 订阅回调
examples/demo.ts        # 可运行演示
```

## 术语：终结果一致性

`test/equivalence.test.ts` 与 `test/stress.test.ts` 对随机生成的多来源流（合法交错、
流中途推进水位、含迟到与重复）断言：

> 引擎的 `snapshot().final` 恒等于 `referenceMatches(全部被接受事件, T).matches`。

这正是“终结结果应与完整输入按事件时间排序执行规则所得结果一致”的形式化验证。
