/**
 * 联邦路径向量路由模块 —— 公共入口
 *
 * 典型用法：
 *   import { Federation } from './federation.ts';
 *   const fed = new Federation({ seed: 42 });
 *   const a = fed.addDomain('A');
 *   a.addOwnedDestination('dest-x');
 *   fed.connect('A', 'B', 2);
 *   fed.runUntilIdle();
 */
export { RoutingDomain } from './router.ts';
export type { RoutingDomainOptions } from './router.ts';
export { Federation } from './federation.ts';
export type { FederationOptions } from './federation.ts';
export { SimNetwork, mulberry32 } from './network.ts';
export type {
  Transport,
  DeliveryHandler,
  LinkFaultPolicy,
} from './network.ts';
export { TraceLog } from './trace.ts';
export type { TraceEvent } from './trace.ts';
export {
  compareDomainIdSequence,
  compareRanked,
  isAcceptablePath,
  sameSelectedRoute,
  assertNonNegativeIntCost,
} from './path-utils.ts';
export type { RankedCandidate } from './path-utils.ts';
export {
  referenceShortestPaths,
  buildAdjacency,
} from './reference.ts';
export type { Topology, TopologyEdge, ReferenceRoute } from './reference.ts';
export type {
  Announcement,
  Withdrawal,
  Summary,
  SummaryEntry,
  Request,
  RouteMessage,
  SessionEnvelope,
  SourceId,
  Candidate,
  SelectedRoute,
  NeighborSession,
  ForwardResult,
} from './types.ts';
