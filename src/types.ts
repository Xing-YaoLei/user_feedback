/**
 * Public data model for the mesh traffic planner.
 *
 * Quantities are integers. They may be supplied as `bigint`, as safe JS
 * integers (numbers), or as decimal strings (convenient for JSON round-trips
 * of values beyond 2^53). They are normalised to `bigint` internally so that
 * demands, capacities, flows and total cost stay exact far beyond
 * `Number.MAX_SAFE_INTEGER`.
 */

/** A quantity that may be supplied as bigint, integer number, or decimal string. */
export type IntegerInput = bigint | number | string;

/** One source region and how much traffic it wants to send this round. */
export interface SourceSpec {
  /** Unique, non-empty source region identifier. */
  id: string;
  /** Requests offered this round. Must be >= 0. */
  demand: IntegerInput;
}

/** One receiving cluster and how much traffic it can absorb this round. */
export interface ClusterSpec {
  /** Unique, non-empty cluster identifier. */
  id: string;
  /** Receiving capacity. Must be >= 0. */
  capacity: IntegerInput;
}

/**
 * An allowed source -> cluster route and its cost per unit routed.
 *
 * Local-region routes carry cost 0, cross-region routes carry a positive
 * cost. Routes that are not declared are forbidden and always receive zero
 * traffic; the planner never invents a route.
 */
export interface EdgeSpec {
  source: string;
  cluster: string;
  /** Cost per unit routed. Must be >= 0. */
  cost: IntegerInput;
}

/** Full input for one planning round. */
export interface PlanInput {
  sources: readonly SourceSpec[];
  clusters: readonly ClusterSpec[];
  edges: readonly EdgeSpec[];
}

/** A positive integer flow assignment for one allowed edge. */
export interface FlowAssignment {
  source: string;
  cluster: string;
  /** Routed requests, strictly positive. Zero flows are omitted. */
  requests: bigint;
  /** Cost per unit routed for this edge. */
  unitCost: bigint;
  /** requests * unitCost. */
  cost: bigint;
}

/**
 * A capacity cut that certifies the plan cannot accept one more request.
 *
 * `sourceRegion` S is a non-empty set of source regions, `clusterRegion` T a
 * set of receiving clusters. The certificate asserts two facts, both
 * re-checkable from the raw input alone:
 *
 *   1. Closure: every allowed edge whose source lies in S has its cluster
 *      in T. Therefore the sources in S can only ever place traffic on the
 *      clusters in T, so they can contribute at most `clusterCapacity`
 *      accepted requests in total, whatever the rest of the mesh does.
 *
 *   2. Bound: sources outside S contribute at most the sum of their demands.
 *      Hence no feasible plan can accept more than
 *
 *          (totalDemand - sourceDemand) + clusterCapacity = cutCapacity
 *
 *      requests. `cutCapacity` is the capacity of this cut in the
 *      max-flow network, and the returned plan accepts exactly that many
 *      (`tight` is true). When `unserved` is positive, this proves the
 *      plan is throughput-optimal under the currently allowed routes.
 */
export interface CapacityCut {
  /** S, sorted by UTF-16 code unit. */
  sourceRegion: string[];
  /** T, sorted by UTF-16 code unit. */
  clusterRegion: string[];
  /** Sum of demands of the sources in S. */
  sourceDemand: bigint;
  /** Sum of capacities of the clusters in T. */
  clusterCapacity: bigint;
  /** Network-cut capacity: an upper bound on served for every feasible plan. */
  cutCapacity: bigint;
  /** Unaccepted requests implied by the cut (= sourceDemand - clusterCapacity). */
  unserved: bigint;
  /** True when cutCapacity equals the served total of the returned plan. */
  tight: boolean;
}

/** Machine-checkable summary of a plan. */
export interface PlanSummary {
  /** Total requests accepted across all sources. */
  served: bigint;
  /** Total requests that could not be accepted. */
  unserved: bigint;
  /** Total routing cost of the plan (sum of edge unitCost * flow). */
  totalCost: bigint;
  /** Total demand across all sources. */
  totalDemand: bigint;
  /** Total capacity across all clusters. */
  totalCapacity: bigint;
}

/** Result of planning one round. */
export interface PlanResult {
  /** Positive flows, sorted by (source id, cluster id) by UTF-16 code unit. */
  assignments: FlowAssignment[];
  /** Per-source accepted totals, keyed by source id; includes every source. */
  servedBySource: Map<string, bigint>;
  /** Per-source unaccepted totals, keyed by source id; includes every source. */
  unservedBySource: Map<string, bigint>;
  /** Per-cluster used capacity, keyed by cluster id; includes every cluster. */
  usedByCluster: Map<string, bigint>;
  summary: PlanSummary;
  /**
   * Present exactly when not all demand could be accepted. An exhaustive
   * capacity cut whose bound the plan attains; see {@link CapacityCut}.
   */
  cut: CapacityCut | null;
}

/** Human-readable description of the deterministic tie-breaking chain. */
export interface TieBreakRule {
  readonly primary: 'maximise total served';
  readonly secondary: 'minimise total cost among maximum-throughput plans';
  readonly tertiary: 'lexicographically smallest share vector ordered by (source id, cluster id)';
}

export const TIE_BREAK: TieBreakRule = {
  primary: 'maximise total served',
  secondary: 'minimise total cost among maximum-throughput plans',
  tertiary: 'lexicographically smallest share vector ordered by (source id, cluster id)',
};
