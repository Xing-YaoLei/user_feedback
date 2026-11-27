/**
 * Public module entry point.
 *
 * A quota coordinator plus a node-side admission module for a fixed-window
 * global + per-tenant quota system with leased edge quota, conservative clock
 * skew handling, exactly-once return/consume accounting, generation fencing,
 * and deterministic network simulation for tests and the demo.
 */

export {
  ManualClock,
  OffsetClock,
  FixedClock,
  readingInterval,
  definitelyAtOrAfter,
  definitelyStarted,
  conservativeRemainingMs,
  insideConservativeInterval,
  windowIndexAt,
  windowStartAt,
  windowEndAt,
  nodeSafeWindow,
} from './clock.ts';
export type { Clock, TimeInterval } from './clock.ts';

export * from './protocol.ts';
export { Coordinator } from './coordinator.ts';
export type {
  CoordinatorConfig,
  CoordinatorRecord,
  BorrowRecord,
  ReturnRecord,
  ConsumeRecord,
  WindowSnapshot,
  HandleOptions,
} from './coordinator.ts';

export { QuotaNode } from './node.ts';
export type {
  NodeConfig,
  ClockLike,
  AdmissionRecord,
  AdmitResult,
  AdmitRejectReason,
  BorrowOutcome,
  CoordinatorClient,
  DurableReturn,
} from './node.ts';

export { DirectClient, SimulatedClient } from './client.ts';

export { SimulatedNetwork, uniformPolicy, mulberry32 } from './network.ts';
export type {
  DeliveryPolicy,
  NodeEndpoint,
  NetworkLogEntry,
  UniformNetworkOptions,
} from './network.ts';

export { Simulation, checkBudget } from './sim.ts';
export type { SimulationConfig, NodeHandle, Timed, BudgetReport } from './sim.ts';

export { auditConsumption } from './audit.ts';
export type { AuditedAdmission, WindowAudit, AuditResult } from './audit.ts';
