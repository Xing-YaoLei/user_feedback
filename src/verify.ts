/**
 * Independent, re-checkable verification helpers.
 *
 * These routines do not trust anything the planner reports: they re-derive
 * feasibility, totals and the capacity-cut argument directly from the raw
 * input. They are what the test-suite and the CLI use to audit a plan.
 */

import { compareIds } from './planner.ts';
import type {
  CapacityCut,
  FlowAssignment,
  PlanInput,
  PlanResult,
} from './types.ts';

/** A verification report: `ok` plus every problem found, in a stable order. */
export interface VerificationReport {
  ok: boolean;
  errors: string[];
}

/** One coordinate of the canonical share vector: an allowed route and its flow. */
export interface ShareEntry {
  source: string;
  cluster: string;
  requests: bigint;
}

/** Normalises integer-like input to bigint for verification arithmetic. */
function asBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`unsafe integer ${value}; use bigint or decimal string`);
    }
    return BigInt(value);
  }
  return BigInt(value.trim());
}

/**
 * Canonical share vector: one entry per allowed route, in (source id,
 * cluster id) order, including zero flows. This is the vector whose
 * lexicographic minimum the planner promises among optimal plans.
 */
export function shareVector(input: PlanInput, result: PlanResult): ShareEntry[] {
  const flow = new Map<string, bigint>();
  for (const assignment of result.assignments) {
    flow.set(`${assignment.source}\u0000${assignment.cluster}`, asBigInt(assignment.requests));
  }
  const entries: ShareEntry[] = input.edges.map((edge) => ({
    source: edge.source,
    cluster: edge.cluster,
    requests: flow.get(`${edge.source}\u0000${edge.cluster}`) ?? 0n,
  }));
  entries.sort((a, b) => {
    const bySource = compareIds(a.source, b.source);
    return bySource !== 0 ? bySource : compareIds(a.cluster, b.cluster);
  });
  return entries;
}

/**
 * Lexicographic comparison of two share vectors (which must cover the same
 * routes in the same order). Negative when `a` is lexicographically smaller.
 */
export function compareShareVectors(a: readonly ShareEntry[], b: readonly ShareEntry[]): number {
  if (a.length !== b.length) {
    throw new Error('share vectors cover different route sets');
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.source !== b[i]!.source || a[i]!.cluster !== b[i]!.cluster) {
      throw new Error('share vectors are not aligned on the same route order');
    }
    if (a[i]!.requests < b[i]!.requests) return -1;
    if (a[i]!.requests > b[i]!.requests) return 1;
  }
  return 0;
}

/** Checks that a cut's sets and its arithmetic are internally consistent. */
export function verifyCut(
  input: PlanInput,
  cut: CapacityCut,
  expectedServed?: bigint,
): VerificationReport {
  const errors: string[] = [];

  const demandById = new Map<string, bigint>();
  for (const source of input.sources) demandById.set(source.id, asBigInt(source.demand));
  const capacityById = new Map<string, bigint>();
  for (const cluster of input.clusters) capacityById.set(cluster.id, asBigInt(cluster.capacity));

  if (cut.sourceRegion.length === 0) {
    errors.push('cut source region must be non-empty');
  }
  const inSource = new Set(cut.sourceRegion);
  const inCluster = new Set(cut.clusterRegion);
  if (inSource.size !== cut.sourceRegion.length) errors.push('cut source region has duplicates');
  if (inCluster.size !== cut.clusterRegion.length) errors.push('cut cluster region has duplicates');
  for (const id of cut.sourceRegion) {
    if (!demandById.has(id)) errors.push(`cut references unknown source "${id}"`);
  }
  for (const id of cut.clusterRegion) {
    if (!capacityById.has(id)) errors.push(`cut references unknown cluster "${id}"`);
  }

  // Closure: every allowed edge leaving the source region must land inside
  // the cluster region. Otherwise the cut would have uncounted capacity.
  for (const edge of input.edges) {
    if (!inSource.has(edge.source)) continue;
    if (!inCluster.has(edge.cluster)) {
      errors.push(
        `cut is not closed: allowed edge ${edge.source} -> ${edge.cluster} leaves the source region for a cluster outside the cluster region`,
      );
    }
  }

  let sourceDemand = 0n;
  for (const id of cut.sourceRegion) sourceDemand += demandById.get(id) ?? 0n;
  let clusterCapacity = 0n;
  for (const id of cut.clusterRegion) clusterCapacity += capacityById.get(id) ?? 0n;

  if (cut.sourceDemand !== sourceDemand) {
    errors.push(`cut sourceDemand ${cut.sourceDemand} != recomputed ${sourceDemand}`);
  }
  if (cut.clusterCapacity !== clusterCapacity) {
    errors.push(`cut clusterCapacity ${cut.clusterCapacity} != recomputed ${clusterCapacity}`);
  }

  const totalDemand = [...demandById.values()].reduce((a, b) => a + b, 0n);
  const expectedCut = totalDemand - sourceDemand + clusterCapacity;
  if (cut.cutCapacity !== expectedCut) {
    errors.push(`cut capacity ${cut.cutCapacity} != recomputed upper bound ${expectedCut}`);
  }
  const expectedUnserved = sourceDemand - clusterCapacity;
  if (cut.unserved !== expectedUnserved) {
    errors.push(`cut unserved ${cut.unserved} != recomputed ${expectedUnserved}`);
  }
  if (expectedUnserved < 0n) {
    errors.push('cut has negative unserved amount (capacity exceeds demand inside the cut)');
  }
  if (cut.cutCapacity < 0n) {
    errors.push('cut capacity is negative');
  }

  if (expectedServed !== undefined) {
    if (cut.cutCapacity !== expectedServed) {
      errors.push(
        `cut capacity ${cut.cutCapacity} does not match served total ${expectedServed}, so it does not certify optimality`,
      );
    }
    if (!cut.tight) errors.push('cut is not marked tight');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Audits a complete plan against the raw input. Checks edge legality,
 * per-source and per-cluster conservation, totals, cost, and — when demand is
 * left unserved — the capacity cut that proves the gap is unavoidable.
 */
export function verifyPlan(input: PlanInput, result: PlanResult): VerificationReport {
  const errors: string[] = [];

  const demand = new Map<string, bigint>();
  for (const source of input.sources) demand.set(source.id, asBigInt(source.demand));
  const capacity = new Map<string, bigint>();
  for (const cluster of input.clusters) capacity.set(cluster.id, asBigInt(cluster.capacity));

  const allowed = new Set<string>();
  const unitCost = new Map<string, bigint>();
  for (const edge of input.edges) {
    const key = `${edge.source}\u0000${edge.cluster}`;
    allowed.add(key);
    unitCost.set(key, asBigInt(edge.cost));
  }

  const seen = new Set<string>();
  const servedBySource = new Map<string, bigint>();
  const usedByCluster = new Map<string, bigint>();
  let served = 0n;
  let totalCost = 0n;

  for (const assignment of result.assignments) {
    const key = `${assignment.source}\u0000${assignment.cluster}`;
    const requests = asBigInt(assignment.requests);
    if (!allowed.has(key)) {
      errors.push(`assignment ${assignment.source} -> ${assignment.cluster} uses a forbidden edge`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`duplicate assignment for ${assignment.source} -> ${assignment.cluster}`);
    }
    seen.add(key);
    if (requests <= 0n) {
      errors.push(`assignment ${assignment.source} -> ${assignment.cluster} is not positive`);
      continue;
    }
    const expectedUnit = unitCost.get(key)!;
    if (asBigInt(assignment.unitCost) !== expectedUnit) {
      errors.push(
        `assignment ${assignment.source} -> ${assignment.cluster} unit cost ${assignment.unitCost} != declared ${expectedUnit}`,
      );
    }
    if (asBigInt(assignment.cost) !== requests * expectedUnit) {
      errors.push(`assignment ${assignment.source} -> ${assignment.cluster} cost is inconsistent`);
    }
    servedBySource.set(assignment.source, (servedBySource.get(assignment.source) ?? 0n) + requests);
    usedByCluster.set(assignment.cluster, (usedByCluster.get(assignment.cluster) ?? 0n) + requests);
    served += requests;
    totalCost += requests * expectedUnit;
  }

  for (const source of input.sources) {
    const used = servedBySource.get(source.id) ?? 0n;
    if (used > demand.get(source.id)!) {
      errors.push(`source "${source.id}" sends ${used} > demand ${demand.get(source.id)}`);
    }
    const reportedServed = result.servedBySource.get(source.id);
    if (reportedServed === undefined) {
      errors.push(`servedBySource missing source "${source.id}"`);
    } else if (asBigInt(reportedServed) !== used) {
      errors.push(`servedBySource["${source.id}"] ${reportedServed} != recomputed ${used}`);
    }
    const reportedUnserved = result.unservedBySource.get(source.id);
    const expectedUnserved = demand.get(source.id)! - used;
    if (reportedUnserved === undefined) {
      errors.push(`unservedBySource missing source "${source.id}"`);
    } else if (asBigInt(reportedUnserved) !== expectedUnserved) {
      errors.push(
        `unservedBySource["${source.id}"] ${reportedUnserved} != recomputed ${expectedUnserved}`,
      );
    }
  }

  for (const cluster of input.clusters) {
    const used = usedByCluster.get(cluster.id) ?? 0n;
    if (used > capacity.get(cluster.id)!) {
      errors.push(`cluster "${cluster.id}" receives ${used} > capacity ${capacity.get(cluster.id)}`);
    }
    const reportedUsed = result.usedByCluster.get(cluster.id);
    if (reportedUsed === undefined) {
      errors.push(`usedByCluster missing cluster "${cluster.id}"`);
    } else if (asBigInt(reportedUsed) !== used) {
      errors.push(`usedByCluster["${cluster.id}"] ${reportedUsed} != recomputed ${used}`);
    }
  }

  let totalDemand = 0n;
  for (const value of demand.values()) totalDemand += value;
  let totalCapacity = 0n;
  for (const value of capacity.values()) totalCapacity += value;

  if (asBigInt(result.summary.served) !== served) {
    errors.push(`summary.served ${result.summary.served} != recomputed ${served}`);
  }
  if (asBigInt(result.summary.unserved) !== totalDemand - served) {
    errors.push(`summary.unserved ${result.summary.unserved} != recomputed ${totalDemand - served}`);
  }
  if (asBigInt(result.summary.totalCost) !== totalCost) {
    errors.push(`summary.totalCost ${result.summary.totalCost} != recomputed ${totalCost}`);
  }
  if (asBigInt(result.summary.totalDemand) !== totalDemand) {
    errors.push(`summary.totalDemand ${result.summary.totalDemand} != recomputed ${totalDemand}`);
  }
  if (asBigInt(result.summary.totalCapacity) !== totalCapacity) {
    errors.push(`summary.totalCapacity ${result.summary.totalCapacity} != recomputed ${totalCapacity}`);
  }

  const unserved = totalDemand - served;
  if (unserved > 0n) {
    if (result.cut === null) {
      errors.push('demand left unserved but no capacity cut was provided');
    } else {
      const cutReport = verifyCut(input, result.cut, served);
      errors.push(...cutReport.errors);
    }
  } else if (result.cut !== null) {
    errors.push('all demand was served but a capacity cut was reported');
  }

  return { ok: errors.length === 0, errors };
}
