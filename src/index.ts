/**
 * 副本分配与迁移规划模块的公共入口。
 *
 * 使用流程：
 * 1. planAllocation(topology) 求最优目标分配（或获得可核对的不可行依据）；
 * 2. buildMigrationPlan(...) 在静态条件下生成完整动作轨迹用于审计/预检；
 * 3. MigrationExecutor + ReplicationAdapter 在真实异步环境中执行，
 *    支持 Broker 退出、重新规划与迟到复制结果的处理。
 */

export {
  planAllocation,
  bruteForceAllocation,
} from './allocator.ts';
export {
  MigrationPlanner,
  buildMigrationPlan,
  type MigrationAction,
  type MigrationPlanResult,
  type MigrationSnapshot,
  type BlockedReport,
  type PlannerInput,
  type ActionType,
} from './migration.ts';
export {
  MigrationExecutor,
  type ExecutorEvent,
  type ExecutorOptions,
} from './executor.ts';
export {
  ManualReplicationAdapter,
  AutoReplicationAdapter,
  type ReplicationAdapter,
  type ReplicationHandle,
} from './adapters.ts';
export type {
  Topology,
  BrokerSpec,
  PartitionSpec,
  Assignment,
  AllocationResult,
  InfeasibleReason,
} from './types.ts';
