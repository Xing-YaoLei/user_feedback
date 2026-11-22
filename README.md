# Raft 协调状态机（TypeScript / Node.js）

一个零依赖、确定性的 Raft 协调状态机实现。调用方提供状态归约函数，每个节点拥有独立的
本地持久化目录；消息传输与选举/心跳时间全部由注入的**调度器**和**网络**驱动，因此同一种子
可以逐事件复现整个运行过程。

## 运行环境与验证入口

- Node.js ≥ 22.6（使用内置 TypeScript 类型擦除与内置测试框架，无需安装编译器或任何依赖）
- 验证入口（项目根目录）：

```bash
npm test
```

`npm test` 运行 `node --test`，执行真实断言并覆盖选举、日志复制、节点重启、线性一致读取、
联合共识成员变更、消息丢失/重复/延迟/乱序以及题目要求的联合阶段隔离+重启+滞留消息场景。
断言失败时进程以非零码退出。所有临时数据都写入系统临时目录下的独立工作区并在测试结束时删除。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 共享类型、线协议消息、仲裁/配置工具、`RaftError` |
| `src/scheduler.ts` | 虚拟时钟调度器与确定性 PRNG（mulberry32），所有定时器与投递都在此排队 |
| `src/network.ts` | 模拟网络：丢失、重复、延迟、乱序、链路分区、消息滞留（hold）/回放 |
| `src/persistence.ts` | 每节点持久化：`state.json`（任期/投票）、`log.json`（日志）、`snapshot.json`（提交/应用状态），临时文件+原子 rename |
| `src/raft.ts` | Raft 节点核心：选举、复制、提交/应用、ReadIndex 线性一致读、联合共识成员变更 |
| `src/cluster.ts` | 节点生命周期封装，支持对同一数据目录的崩溃重启 |
| `src/kv.ts` | 调用方状态机示例：确定性 SET/DELETE 键值归约 |
| `src/index.ts` | 统一可调用入口 |
| `test/` | 6 个测试文件、21 个测试用例及共享 harness |

## 核心设计要点

### 选举与日志复制（Raft §5）

- 任期（`currentTerm`）与投票（`votedFor`）在变化时同步落盘；日志追加与冲突截断采用
  原子替换写入，满足日志匹配特性（Log Matching Property）。
- 只有当前配置的成员可以发起选举或被授予选票；联合配置下须同时获得旧配置与新配置两个多数派。
- 提交仅推进当前任期的条目（§5.4.2），再按日志顺序应用；同一日志位置在各节点上是同一条命令。
- 领导者当选即追加一条 no-op，快速提交旧任期条目并为线性一致读建立提交点。

### 节点重启

`ClusterNode.restart()` 以全新进程方式重新打开同一数据目录：任期、投票、日志从磁盘恢复，
已提交未应用的条目按快照回放，未提交的本地分叉在后续 AppendEntries 冲突处理中被截断。

### 线性一致读取（ReadIndex，§6.4）

读取不能仅凭节点自认为领导者就成功。每次 `read()` 都会：

1. 开启一个**全新的确认轮次**（barrier round），只有该轮次之后收到的多数派
   AppendEntries 响应才计入——分区前积累的旧确认无法复用；
2. 在当前任期取得所需仲裁（联合阶段为新旧两套多数派）确认领导权；
3. 等待本地状态机应用到该次读取所需的提交位置后才返回。

无法取得仲裁的自封领导者读取必然超时失败。

### 在线成员替换（联合共识，§6）

`changeConfig(targetVoters)` 一次只处理一项变更：

1. 新成员先通过普通 AppendEntries 追平必要日志；
2. 追加联合配置 `C_old,new`，立即在本地生效，此后选举与提交都需要新旧配置**各自的多数派**；
3. 联合条目提交后（可选 `onJointCommitted` 回调，用于在该精确相位注入故障）追加目标配置
   `C_new`，其提交后切换完成；
4. 若当前领导者被移出目标集合，切换后自动下台；领导者中途故障时，新领导者依据持久化日志
   恢复未完成的联合过渡。

### 确定性与故障注入

- 调度器按 `(时间, 序号)` 触发事件，随机数来自种子化 PRNG；同种子的两次运行产生完全相同的
  日志历史（见 `test/5-chaos-determinism.test.ts`）。
- 网络支持按概率丢包/重复、可调延迟与宽抖动乱序，并可对任意双向链路分区、愈合，或先
  `hold()` 滞留消息、稍后按原序/洗牌 `releaseHeld()` 回放。
- 客户端操作（`write`/`read`/`changeConfig`）内部通过 `pumpUntil` 驱动注入的虚拟时钟，
  调用方可以直接 `await`，无需感知虚拟时间。

## 最小调用示例

```ts
import {
  Scheduler, Network, PersistentStore, RaftNode,
  bootstrapConfigFor, kvStateMachine,
} from './src/index.ts';

const scheduler = new Scheduler(42);
const network = new Network(scheduler, { lossRate: 0.1, reorder: true });
const config = bootstrapConfigFor(['n1', 'n2', 'n3']);
const store = new PersistentStore('/tmp/raft-n1', kvStateMachine.initial, config);
const node = new RaftNode('n1', kvStateMachine, scheduler, network, store, config);
node.start();
// 选主后：await leader.write({ op: 'SET', key: 'k', value: 'v' });
//        await leader.read();
//        await leader.changeConfig(['n2', 'n3', 'n4']);
```

## 测试场景索引

- `1-election-replication.test.ts`：选主稳定性、多数派复制、follower 拒绝写入、少数派分区不可提交
- `2-restart-persistence.test.ts`：重启保留任期/投票/日志、离线节点补日志、已确认命令跨领导者成立
- `3-linearizable-read.test.ts`：仲裁确认读取、分区自封领导者读取失败、恢复后读到完整历史
- `4-membership-joint.test.ts`：新节点追平→联合→目标配置、变更互斥，以及联合阶段隔离旧领导者+
  重启投票节点+回放滞留消息的完整仲裁边界核对
- `5-chaos-determinism.test.ts`：丢包/重复/延迟/乱序/重启下日志收敛、同种子可复现、异种子同构收敛
- `6-network.test.ts`：网络原语（滞留、分区、丢包、重复、乱序）的独立验证
