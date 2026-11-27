/**
 * Public entry point for the mesh traffic planner.
 *
 * ```ts
 * import { plan } from './src/index.ts';
 *
 * const result = plan({
 *   sources: [
 *     { id: 'us-east', demand: 1200n },
 *     { id: 'eu-west', demand: 800n },
 *   ],
 *   clusters: [
 *     { id: 'us-cluster', capacity: 1000n },
 *     { id: 'eu-cluster', capacity: 900n },
 *   ],
 *   edges: [
 *     { source: 'us-east', cluster: 'us-cluster', cost: 0n },
 *     { source: 'us-east', cluster: 'eu-cluster', cost: 5n },
 *     { source: 'eu-west', cluster: 'eu-cluster', cost: 0n },
 *   ],
 * });
 * ```
 */

export { plan, normaliseInput, compareIds } from './planner.ts';
export {
  verifyCut,
  verifyPlan,
  shareVector,
  compareShareVectors,
} from './verify.ts';
export type {
  CapacityCut,
  ClusterSpec,
  EdgeSpec,
  FlowAssignment,
  IntegerInput,
  PlanInput,
  PlanResult,
  PlanSummary,
  SourceSpec,
  TieBreakRule,
} from './types.ts';
export { TIE_BREAK } from './types.ts';
export { toJson, fromJson } from './json.ts';
export type { PlanJson, PlanResultJson } from './json.ts';
