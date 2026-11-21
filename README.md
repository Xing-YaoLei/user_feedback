# 副本分配与迁移规划模块（replica-rebalance-planner）

事件总线扩容场景下的分区副本分配与迁移规划：给定分区副本数、复制成本、
Broker 槽位容量、故障域和当前实际副本位置，先求最优**目标分配**，再把
目标转换为带安全保证的**复制 / 追平 / 删除动作序列**，并通过可控异步
适配器执行，支持复制中途 Broker 退出、新规划请求与迟到复制结果。

仅依赖 Node.js 内置能力（内置测试框架 + 原生 TypeScript 类型擦除），
无需安装任何编译器或第三方包，要求 Node >= 23.6。

## 运行验证

```bash
npm test
```

`npm test` 运行真实断言，覆盖故障域约束改变最优方案、迁移成环、临时副本
腾挪、容量受阻依据、复制中途重新规划与迟到结果等交错场景；断言失败时
进程非零退出。所有数据均为测试内合成数据，不访问外部服务。

## 目录结构

```
src/
  types.ts       输入/输出类型（Topology、Assignment、AllocationResult 等）
  allocator.ts   最优目标分配（确定性 DFS + 分支限界，含穷举参照实现）
  migration.ts   迁移规划器（动作生成、安全不变量、成环检测与临时副本腾挪）
  executor.ts    异步执行器（适配器驱动、代次管理、Broker 退出/重新规划）
  adapters.ts    复制适配器接口 + 手动/自动两种测试适配器
  index.ts       公共入口
test/
  helpers.ts                断言工具（方案合法性、逐步容量/副本数不变量）
  allocator.test.ts         分配器测试（含 40 组随机输入与穷举逐一对照）
  migration.test.ts         迁移规划测试（成环、缩容、扩容、轨迹核对）
  executor.test.ts          异步执行器测试（退出、重新规划、迟到结果、重试）
```

## 核心语义

### 1. 目标分配（`planAllocation`）

硬约束：

- 每个分区达到 `replicationFactor` 个副本；
- 同一分区的副本分布在**不同 Broker、不同故障域**；
- 每个 Broker 的副本占用不超过其容量。

优化目标：在全部可行方案中，最小化目标方案内**新落点**的复制成本之和
（保留的既有副本不计费）；成本相同的等价方案按 `(分区 ID, Broker ID)`
字典序给出唯一确定结果。

不可行时返回结构化、可核对的阻塞依据：

- `insufficient-fault-domains` / `insufficient-brokers`：副本数超过域数/Broker 数；
- `insufficient-total-capacity`：总需求槽位超过总容量，附两边数值；
- `no-feasible-assignment`：总量够但组合约束冲突，附**最小阻塞分区子集**，
  调用方可对该子集独立穷举复核（测试中即如此验证）。

### 2. 迁移规划（`buildMigrationPlan` / `MigrationPlanner`）

动作类型：`replicate`（复制，复制中即占槽位）、`catchup`（确认追平，
成为真实可用副本）、`delete`（删除，确认完成前槽位仍占用）。

每次主动删除后必须同时满足：

- 可用副本数 ≥ min(删除前可用副本数, 目标副本数)；
- 覆盖故障域数 ≥ min(删除前覆盖故障域数, 目标副本数)；
- 删除迁移基线中的原始副本前，必须已有追平的替代者：所有新目标副本
  均已追平，或存在异域临时副本作为安全垫——即**新副本确认追平后才允许
  删除它所替代的旧副本**。

成环处理：当所有待启动复制都因目标槽位被占用而阻塞时，规划器构建
「分区 → 等待 Broker → 占用分区」的等待图并检测等待环，随后为阻塞
分区选择临时副本（优先未覆盖故障域、有空闲槽位的 Broker）腾挪。
若容量使迁移无法推进，返回 `BlockedReport`：等待关系、环上分区、
需要释放槽位的 Broker 及其占用者、全部临时副本候选与空闲情况。

### 3. 异步执行（`MigrationExecutor` + `ReplicationAdapter`）

- 复制由适配器异步执行，执行器在下发时即把副本计入 inflight 槽位；
- 追平只由复制成功回调驱动，调度循环不主动追平，避免"未完成先接纳"；
- `handleBrokerExit(brokerId)`：中止其上复制，以剩余**真实存在**的副本
  为基线重建规划并递增代次（epoch）；
- `replan(newTarget)`：同样只以真实副本为基线，在途复制不取消，
  其迟到结果到达时**先计入占用**，再按新目标决定接纳（追平）或清理
  （通知适配器删除并释放槽位）；
- 旧代次回调由 epoch 与当前状态双重过滤，不会污染新规划；
- 复制失败自动释放 inflight 槽位并由下一轮调度重试。

## 快速上手

```ts
import {
  planAllocation,
  buildMigrationPlan,
  MigrationExecutor,
  ManualReplicationAdapter,
  type Topology,
} from './src/index.ts';

const topology: Topology = {
  brokers: [
    { id: 'b1', capacity: 4, faultDomain: 'd1' },
    { id: 'b2', capacity: 4, faultDomain: 'd2' },
    { id: 'b3', capacity: 4, faultDomain: 'd3' },
  ],
  partitions: [
    {
      id: 'p1',
      replicationFactor: 2,
      cost: { b1: 1, b2: 10, b3: 20 },
      currentReplicas: ['b1'],
    },
  ],
};

// 1) 求最优目标分配
const allocation = planAllocation(topology);
if (!allocation.feasible) {
  console.log('不可行，阻塞依据：', allocation.reason);
} else {
  // 2) 静态生成完整动作轨迹（可用于审计/预检）
  const plan = buildMigrationPlan({
    brokers: topology.brokers,
    partitionIds: topology.partitions.map((p) => p.id),
    target: allocation.assignment,
    initial: { p1: topology.partitions[0]!.currentReplicas },
  });
  console.log(plan.status, plan.actions);

  // 3) 或通过可控适配器异步执行
  const adapter = new ManualReplicationAdapter();
  const executor = new MigrationExecutor({
    brokers: topology.brokers,
    partitionIds: ['p1'],
    target: allocation.assignment,
    initial: { p1: ['b1'] },
    adapter,
  });
  executor.onEvent((e) => console.log(e));
  executor.kick();
  // 测试中手动 adapter.succeed('p1', 'b3') 控制复制完成时机
}
```
