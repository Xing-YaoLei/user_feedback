/**
 * 模块统一入口。
 */

export { planAllocation, bruteForceAllocation, validateInput } from './allocator.ts';
export { MigrationPlanner } from './planner.ts';
export { ManualReplicationAdapter } from './adapter.ts';
export type { ReplicationAdapter, ReplicationRequest } from './adapter.ts';
export { MigrationExecutor } from './executor.ts';
export type { TickOutcome, ExecutorEvent } from './executor.ts';
export { buildClusterState, usageOf } from './state.ts';
export * from './types.ts';
