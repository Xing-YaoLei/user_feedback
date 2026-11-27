/**
 * Mesh traffic planner: exact integer throughput maximisation, then minimum
 * cost, then lexicographic tie-breaking.
 *
 * Pipeline
 * --------
 * 1. Validate the input and normalise every quantity to bigint.
 * 2. Build the transport network
 *
 *        SS --demand_i--> source_i --cost_ij--> cluster_j --capacity_j--> TT
 *
 *    and run bigint min-cost max-flow. This returns the maximum total number
 *    of accepted requests and, among all maximum-throughput plans, one of
 *    minimum total cost.
 * 3. On the zero-reduced-cost residual graph of that optimum, walk the
 *    allowed routes in (source id, cluster id) order and lower each route's
 *    flow as far as possible without changing throughput or cost. The result
 *    is the lexicographically smallest share vector among optimal plans.
 *    Every shift is a bulk circulation; no per-request node is ever created.
 * 4. If some demand is left unaccepted, read the residual min cut and report
 *    it as a re-checkable capacity certificate.
 */

import {
  addEdge,
  computePotentials,
  createNetwork,
  filteredMaxFlow,
  flowOn,
  minCostMaxFlow,
  residualReachable,
} from './flow.ts';
import type { EdgeFilter, FlowEdge, FlowNetwork } from './flow.ts';
import type {
  CapacityCut,
  ClusterSpec,
  FlowAssignment,
  IntegerInput,
  PlanInput,
  PlanResult,
  PlanSummary,
  SourceSpec,
} from './types.ts';

/** UTF-16 code-unit comparison, deterministic across platforms. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toNonNegativeBigInt(value: IntegerInput, label: string): bigint {
  let result: bigint;
  if (typeof value === 'bigint') {
    result = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new RangeError(`${label} must be an integer, received ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${label} exceeds Number.MAX_SAFE_INTEGER; pass it as bigint or a decimal string`,
      );
    }
    result = BigInt(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:0|[1-9]\d*)$/.test(text)) {
      throw new RangeError(`${label} must be a non-negative decimal integer, received "${value}"`);
    }
    result = BigInt(text);
  } else {
    throw new TypeError(`${label} must be a bigint, number, or decimal string`);
  }
  if (result < 0n) {
    throw new RangeError(`${label} must be non-negative, received ${result}`);
  }
  return result;
}

function assertUnique(items: readonly { id: string }[], kind: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new Error(`${kind} id must be a non-empty string`);
    }
    if (seen.has(item.id)) {
      throw new Error(`duplicate ${kind} id "${item.id}"`);
    }
    seen.add(item.id);
  }
}

interface NormalisedSource {
  id: string;
  demand: bigint;
}

interface NormalisedCluster {
  id: string;
  capacity: bigint;
}

interface NormalisedRoute {
  sourceIndex: number;
  clusterIndex: number;
  sourceId: string;
  clusterId: string;
  cost: bigint;
}

interface NormalisedInput {
  sources: NormalisedSource[];
  clusters: NormalisedCluster[];
  routes: NormalisedRoute[];
}

/** Validates a plan input and converts every quantity to bigint. */
export function normaliseInput(input: PlanInput): NormalisedInput {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('plan input must be an object');
  }
  if (!Array.isArray(input.sources)) throw new TypeError('input.sources must be an array');
  if (!Array.isArray(input.clusters)) throw new TypeError('input.clusters must be an array');
  if (!Array.isArray(input.edges)) throw new TypeError('input.edges must be an array');

  assertUnique(input.sources as readonly SourceSpec[], 'source');
  assertUnique(input.clusters as readonly ClusterSpec[], 'cluster');

  const sources: NormalisedSource[] = input.sources.map((source, index) => ({
    id: source.id,
    demand: toNonNegativeBigInt(source.demand, `sources[${index}].demand`),
  }));
  const clusters: NormalisedCluster[] = input.clusters.map((cluster, index) => ({
    id: cluster.id,
    capacity: toNonNegativeBigInt(cluster.capacity, `clusters[${index}].capacity`),
  }));

  const sourceIndex = new Map<string, number>();
  sources.forEach((s, i) => sourceIndex.set(s.id, i));
  const clusterIndex = new Map<string, number>();
  clusters.forEach((c, i) => clusterIndex.set(c.id, i));

  const seenRoutes = new Set<string>();
  const routes: NormalisedRoute[] = input.edges.map((edge, index) => {
    if (typeof edge.source !== 'string' || typeof edge.cluster !== 'string') {
      throw new TypeError(`edges[${index}] must have string source and cluster ids`);
    }
    const si = sourceIndex.get(edge.source);
    if (si === undefined) {
      throw new Error(`edges[${index}] references unknown source "${edge.source}"`);
    }
    const ci = clusterIndex.get(edge.cluster);
    if (ci === undefined) {
      throw new Error(`edges[${index}] references unknown cluster "${edge.cluster}"`);
    }
    const key = `${si}\u0000${ci}`;
    if (seenRoutes.has(key)) {
      throw new Error(`duplicate edge ${edge.source} -> ${edge.cluster}`);
    }
    seenRoutes.add(key);
    return {
      sourceIndex: si,
      clusterIndex: ci,
      sourceId: edge.source,
      clusterId: edge.cluster,
      cost: toNonNegativeBigInt(edge.cost, `edges[${index}].cost`),
    };
  });

  return { sources, clusters, routes };
}

function routeOrder(a: NormalisedRoute, b: NormalisedRoute): number {
  const bySource = compareIds(a.sourceId, b.sourceId);
  return bySource !== 0 ? bySource : compareIds(a.clusterId, b.clusterId);
}

interface RouteEdge {
  route: NormalisedRoute;
  edge: FlowEdge;
}

interface BuiltNetwork {
  network: FlowNetwork;
  ss: number;
  tt: number;
  sourceNodes: number[];
  clusterNodes: number[];
  /** Forward route edges, aligned with the routes array order. */
  routeEdges: FlowEdge[];
  /** Finite per-route capacity: total demand is always a safe upper bound. */
  bigCapacity: bigint;
}

function buildNetwork(input: NormalisedInput, totalDemand: bigint): BuiltNetwork {
  const sourceCount = input.sources.length;
  const clusterCount = input.clusters.length;
  const ss = 0;
  const sourceNodes = input.sources.map((_, i) => 1 + i);
  const clusterNodes = input.clusters.map((_, j) => 1 + sourceCount + j);
  const tt = 1 + sourceCount + clusterCount;
  const network = createNetwork(tt + 1);

  input.sources.forEach((source, i) => {
    addEdge(network, ss, sourceNodes[i], source.demand, 0n);
  });
  input.clusters.forEach((cluster, j) => {
    addEdge(network, clusterNodes[j], tt, cluster.capacity, 0n);
  });

  // No route can carry more than the total demand; a finite bound keeps the
  // min cut well defined without introducing literal infinities.
  const bigCapacity = totalDemand;
  const routeEdges: FlowEdge[] = input.routes.map((route) =>
    addEdge(
      network,
      sourceNodes[route.sourceIndex],
      clusterNodes[route.clusterIndex],
      bigCapacity,
      route.cost,
    ),
  );

  return { network, ss, tt, sourceNodes, clusterNodes, routeEdges, bigCapacity };
}

/**
 * Lexicographically minimises the share vector, ordered by
 * (source id, cluster id), over all maximum-throughput minimum-cost plans.
 *
 * The network already holds such a plan and `potentials` are feasible for its
 * residual graph, so every residual arc has non-negative reduced cost. The
 * alternative optimal plans are exactly the flows obtained by adding a
 * circulation confined to residual arcs of reduced cost 0. (The difference of
 * two equal-cost, equal-value flows is a circulation of cost 0; with all
 * reduced costs non-negative, every arc it uses must have reduced cost 0.)
 *
 * For each route in order we lower its flow as far as possible. Lowering by
 * `delta` sends `delta` along the route's residual reverse arc (cluster ->
 * source); a zero-cost circulation also needs `delta` from the source back to
 * the cluster through zero-reduced-cost residual arcs, which is a max-flow
 * computation with the route's own arcs excluded. Once a route is lowered to
 * its minimum we freeze its arcs: any two plans agreeing on all earlier shares
 * differ by a circulation that is zero on those frozen arcs, so freezing never
 * hides a reachable plan.
 */
function lexicographicMinimise(
  network: FlowNetwork,
  sourceNodes: readonly number[],
  clusterNodes: readonly number[],
  ordered: readonly RouteEdge[],
  potentials: readonly bigint[],
): void {
  // Residual arcs belonging to routes whose share is already minimal. Removing
  // them from later searches is safe: a zero-cost circulation that changes the
  // share of a route sitting at its minimum either lowers it further (which
  // would contradict minimality, so no such circulation exists) or raises it
  // (which is exactly what lexicographic minimality forbids). Hence every
  // admissible circulation leaves that route untouched, and its arcs are never
  // needed.
  const frozen = new Set<FlowEdge>();

  for (const { route, edge } of ordered) {
    const reverse = network.adj[edge.to][edge.rev];
    const current = reverse.cap;

    if (current > 0n) {
      const sourceNode = sourceNodes[route.sourceIndex];
      const clusterNode = clusterNodes[route.clusterIndex];

      // A cost-neutral circulation that lowers this route must use the
      // route's reverse residual arc (cluster -> source), whose reduced cost
      // must therefore be zero. It is always non-negative (feasible
      // potentials), so a positive value means this share is already minimal.
      const reverseReduced =
        -edge.cost + potentials[clusterNode]! - potentials[sourceNode]!;

      if (reverseReduced === 0n) {
        const excluded = new Set<FlowEdge>([edge, reverse]);
        const filter: EdgeFilter = (u, e) => {
          if (frozen.has(e) || excluded.has(e)) return false;
          return e.cost + potentials[u] - potentials[e.to] === 0n;
        };

        // Sending `delta` along the route's reverse arc and returning it from
        // source to cluster over zero-reduced-cost residual arcs is a
        // zero-cost circulation that lowers this route's share by exactly
        // `delta`. The largest possible delta is a max-flow value.
        const delta = filteredMaxFlow(network, sourceNode, clusterNode, current, filter);
        if (delta > 0n) {
          reverse.cap -= delta;
          edge.cap += delta;
        }
      }
    }

    // This route's share is now minimal (possibly zero); freeze both arcs.
    frozen.add(edge);
    frozen.add(reverse);
  }
}

/**
 * Builds the residual min-cut certificate. `sourceRegion` is the set of
 * sources still reachable from SS and `clusterRegion` the reachable clusters.
 *
 * Closure holds because a route arc out of a reachable source with positive
 * residual capacity would make its cluster reachable too. When some demand is
 * unserved, every route arc still has residual capacity (each carries less
 * than the total demand), so no route crosses the cut and the cut consists
 * solely of source-demand and cluster-capacity arcs.
 */
function buildCut(
  built: BuiltNetwork,
  input: NormalisedInput,
  totalDemand: bigint,
  served: bigint,
): CapacityCut {
  const { network, ss, tt, sourceNodes, clusterNodes } = built;
  const reachable = residualReachable(network, ss);
  if (reachable[tt]) {
    throw new Error('internal: sink reachable although demand was only partly served');
  }

  const sourceRegion: string[] = [];
  let sourceDemand = 0n;
  input.sources.forEach((source, i) => {
    if (reachable[sourceNodes[i]]) {
      sourceRegion.push(source.id);
      sourceDemand += source.demand;
    }
  });

  const clusterRegion: string[] = [];
  let clusterCapacity = 0n;
  input.clusters.forEach((cluster, j) => {
    if (reachable[clusterNodes[j]]) {
      clusterRegion.push(cluster.id);
      clusterCapacity += cluster.capacity;
    }
  });

  // Closure re-check: no allowed edge may leave S for a cluster outside T
  // while retaining capacity, or it would be an uncounted cut edge.
  for (const route of input.routes) {
    if (!reachable[sourceNodes[route.sourceIndex]]) continue;
    if (!reachable[clusterNodes[route.clusterIndex]]) {
      throw new Error(`internal: cut not closed at ${route.sourceId} -> ${route.clusterId}`);
    }
  }

  const cutCapacity = totalDemand - sourceDemand + clusterCapacity;
  const unserved = sourceDemand - clusterCapacity;
  if (unserved < 0n) throw new Error('internal: capacity cut has negative unserved');
  return {
    sourceRegion: sourceRegion.sort(compareIds),
    clusterRegion: clusterRegion.sort(compareIds),
    sourceDemand,
    clusterCapacity,
    cutCapacity,
    unserved,
    tight: cutCapacity === served,
  };
}

/**
 * Plans one round of mesh traffic.
 *
 * Objectives, in priority order:
 *   1. maximise the total number of accepted requests;
 *   2. minimise total routing cost among maximum-throughput plans;
 *   3. return the lexicographically smallest share vector, ordered by
 *      (source id, cluster id), among the plans meeting 1 and 2.
 *
 * Source demands and cluster capacities jointly constrain the whole plan.
 * Edges absent from the input are forbidden and always carry zero requests.
 * All arithmetic is exact bigint arithmetic, so totals stay correct past
 * `Number.MAX_SAFE_INTEGER`. Requests are never expanded into individual
 * nodes: every augmentation carries a whole bulk of units.
 *
 * When some demand cannot be accepted, `result.cut` holds a residual min cut
 * whose capacity equals the accepted total: a re-checkable proof that no
 * allowed route can carry one more request.
 */
export function plan(input: PlanInput): PlanResult {
  const normalised = normaliseInput(input);

  let totalDemand = 0n;
  for (const source of normalised.sources) totalDemand += source.demand;
  let totalCapacity = 0n;
  for (const cluster of normalised.clusters) totalCapacity += cluster.capacity;

  const built = buildNetwork(normalised, totalDemand);
  const { network, ss, tt, sourceNodes, clusterNodes, routeEdges } = built;

  const orderedRoutes = normalised.routes
    .map((route, index): RouteEdge => ({ route, edge: routeEdges[index] }))
    .sort((a, b) => routeOrder(a.route, b.route));

  let served = 0n;
  if (totalDemand > 0n && normalised.routes.length > 0) {
    const solution = minCostMaxFlow(network, ss, tt);
    served = solution.flow;

    if (served > 0n) {
      // Potentials must be recomputed after the flow so that the residual
      // graph is described correctly for zero-reduced-cost search.
      const potentials = computePotentials(network);
      lexicographicMinimise(
        network,
        sourceNodes,
        clusterNodes,
        orderedRoutes,
        potentials,
      );
    }
  }

  const servedBySource = new Map<string, bigint>();
  const unservedBySource = new Map<string, bigint>();
  const usedByCluster = new Map<string, bigint>();
  for (const source of normalised.sources) {
    servedBySource.set(source.id, 0n);
    unservedBySource.set(source.id, source.demand);
  }
  for (const cluster of normalised.clusters) {
    usedByCluster.set(cluster.id, 0n);
  }

  const assignments: FlowAssignment[] = [];
  let totalCost = 0n;
  let servedTotal = 0n;

  for (const { route, edge } of orderedRoutes) {
    const requests = flowOn(network, edge);
    if (requests === 0n) continue;
    const cost = requests * route.cost;
    totalCost += cost;
    servedTotal += requests;
    assignments.push({
      source: route.sourceId,
      cluster: route.clusterId,
      requests,
      unitCost: route.cost,
      cost,
    });
    servedBySource.set(route.sourceId, servedBySource.get(route.sourceId)! + requests);
    usedByCluster.set(route.clusterId, usedByCluster.get(route.clusterId)! + requests);
  }

  for (const source of normalised.sources) {
    unservedBySource.set(source.id, source.demand - servedBySource.get(source.id)!);
  }

  if (servedTotal !== served) {
    throw new Error(`internal: assignment total ${servedTotal} disagrees with flow ${served}`);
  }
  const unserved = totalDemand - servedTotal;

  const cut = unserved > 0n ? buildCut(built, normalised, totalDemand, servedTotal) : null;
  if (cut !== null && !cut.tight) {
    throw new Error('internal: capacity cut is not tight');
  }

  const summary: PlanSummary = {
    served: servedTotal,
    unserved,
    totalCost,
    totalDemand,
    totalCapacity,
  };

  return {
    assignments,
    servedBySource,
    unservedBySource,
    usedByCluster,
    summary,
    cut,
  };
}
