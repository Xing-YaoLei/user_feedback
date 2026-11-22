# 事件总线分区副本分配与迁移规划模块

在 Broker 槽位容量与故障域约束下，为分区计算最优副本目标分配，并把目标转换为
可安全执行的复制 / 追平 / 删除动作序列；通过可控异步适配器执行，支持
Broker 退出、迁移途中重新规划、迟到复制结果对账等运行时情形。

## 运行环境

- Node.js（开发验证于 v26.8.1，要求 >= 22，原生支持 TypeScript 类型擦除）
- 无需安装编译器或第三方依赖，仅使用 Node 内置 `node:test` 与 `node:assert`

## 快速开始

```bash
npm test
```

`npm test` 是唯一的可重复本地验证入口，运行真实断言，覆盖故障域约束、
迁移成环、重新规划、迟到结果、容量阻塞等交错/崩溃场景；断言失败时以非零码退出。

## 模块结构

```
src/
  types.ts      公共类型：Broker/分区/副本/动作/阻塞依据
  flow.ts       Dinic 最大流，用于不可行时给出 Hall 容量阻塞见证
  state.ts      集群状态归一化：实际副本 + 进行中副本的槽位占用语义
  allocator.ts  最优目标分配：DFS 穷举 + 成本最优 + 确定性平局 + 朴素穷举器
  planner.ts    迁移规划：复制/追平/删除动作、删除安全护栏、临时副本破环
  adapter.ts    可控异步复制适配器（手工决定成功/失败/Broker 退出）
  executor.ts   执行器：异步推进、重新规划、Broker 退出、迟到结果接纳/清理
  index.ts      统一入口
test/
  allocator.test.ts   分配器：故障域改方案、平局、阻塞依据、50 组穷举交叉核对
  planner.test.ts     规划器：迁移成环、临时副本腾挪、逐步轨迹容量/护栏核对
  executor.test.ts    执行器：异步、Broker 退出、重规划、迟到结果、失败重试
  integration.test.ts 端到端：四 Broker 集群上的交错事件综合场景
```

## 核心语义

### 目标分配（`planAllocation`）

- 每个分区最终达到 `replicas` 个副本，同分区副本分布在不同 Broker 与不同故障域；
- 每个 Broker 的目标占用不超过其槽位容量；
- 优化目标：最终目标中**新落点**（当前实际副本与进行中副本之外的落点）
  的复制成本之和最小；沿用基线落点零新增成本；
- 平局：在所有最小成本方案中，取按分区 ID 升序、分区内 Broker ID 字典序
  排列后字典序最小的方案，等价输入必得确定结果；
- 不可行时返回可核对的阻塞依据：
  - `rf-exceeds-live-brokers` / `not-enough-failure-domains`：数量或故障域不足；
  - `capacity`：二部 b-匹配最大流求出的 Hall 见证，给出受阻分区集合、
    所需槽位数与可达 Broker 的可用槽位数。

### 迁移规划（`MigrationPlanner`）

动作推进顺序：

1. 直接复制缺失的目标副本（复制中即占用目标槽位）；
2. 安全删除多余的非目标副本；
3. 无空闲槽位且存在缺失落点时，用**临时副本**在空闲 Broker 腾挪打破迁移成环；
4. 没有可立即推进的实体动作时，`await` 一个进行中复制追平；
5. 无法推进则返回 `BlockedReport`，列出受阻复制、满 Broker 占用者与
   需要释放槽位的位置（`mustRelease`）。

删除安全护栏（每次主动删除后必须同时满足）：

- 实际副本数 `>= min(删除前副本数, 目标副本数)`；
- 覆盖故障域数 `>= min(删除前故障域数, 目标副本数)`；
- 新副本确认追平（inflight 转 actual）后，旧副本才可能通过护栏被删除。

### 异步执行（`MigrationExecutor` + `ManualReplicationAdapter`）

- 进行中副本与实际副本一样占槽位，但不计入可用副本数/故障域数；
- `brokerDown(broker)`：剔除该 Broker 上全部实际/进行中副本，相关复制失败，
  基于剩余真实副本重新求最优目标；
- `replan(target?)`：以当前真实状态（含 inflight 占用）为基线重新规划；
- 迟到的复制结果：先确认其是否仍占槽位，计入占用核对后，按
  “复制成功且当前目标仍需要该落点且 Broker 存活”决定接纳，否则清理释放槽位。

## 编程接口示例

```ts
import {
  planAllocation,
  MigrationPlanner,
  MigrationExecutor,
  ManualReplicationAdapter,
} from './src/index.ts';

const input = {
  brokers: [
    { id: 'b1', domain: 'd1', capacity: 2 },
    { id: 'b2', domain: 'd2', capacity: 2 },
  ],
  partitions: [
    { id: 'p1', replicas: 2, costs: { b1: 0, b2: 5 } },
  ],
  current: { p1: ['b1'] },
};

// 1) 最优目标分配
const result = planAllocation(input);
if (!result.ok) {
  console.error(result.reason);   // 可核对的阻塞依据
} else {
  // 2) 离线动作序列（理想模型：复制立即追平）
  const plan = MigrationPlanner.computePlan(
    input.brokers, input.partitions, input.current, result.assignment,
  );

  // 3) 或用可控异步适配器逐步执行
  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers, input.partitions, input.current, result.assignment, adapter,
  );
  const step = exec.tick();       // replicate / await / delete / done / blocked
}
```

## 验证覆盖说明

- **故障域约束改变最小成本方案**：同域便宜落点不可同时选用，被迫采用昂贵落点；
- **目标可行但迁移成环**：满载轮换场景，静态规划返回 blocked，
  提供一个临时槽位后由临时副本腾挪收敛；
- **旧复制未结束就重新规划**：inflight 计入占用影响新分配，迟到结果按目标去留；
- **小规模穷举核对**：50 组随机输入上 DFS 最优解与朴素穷举器的成本、方案完全一致；
- **动作轨迹逐步核对**：独立模拟器复播每个动作，校验容量上限与删除安全下限。
