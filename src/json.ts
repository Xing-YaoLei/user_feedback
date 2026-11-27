/**
 * JSON adapters for the planner.
 *
 * JSON cannot represent bigint, so results are rendered with every quantity
 * as a decimal string. Inputs accept plain JSON numbers (safe integers only)
 * as well as decimal strings, so callers can round-trip arbitrarily large
 * values without losing precision. The output objects are plain data and are
 * ready for `JSON.stringify`.
 */

import { plan } from './planner.ts';
import type { CapacityCut, PlanInput, PlanResult } from './types.ts';

/** Input shape after a `JSON.parse`; quantities may be numbers or strings. */
export interface PlanJson {
  sources: { id: string; demand: number | string }[];
  clusters: { id: string; capacity: number | string }[];
  edges: { source: string; cluster: string; cost: number | string }[];
}

interface FlowAssignmentJson {
  source: string;
  cluster: string;
  requests: string;
  unitCost: string;
  cost: string;
}

interface CapacityCutJson {
  sourceRegion: string[];
  clusterRegion: string[];
  sourceDemand: string;
  clusterCapacity: string;
  cutCapacity: string;
  unserved: string;
  tight: boolean;
}

/** Bigint-free, JSON-serialisable form of a plan result. */
export interface PlanResultJson {
  assignments: FlowAssignmentJson[];
  servedBySource: Record<string, string>;
  unservedBySource: Record<string, string>;
  usedByCluster: Record<string, string>;
  summary: {
    served: string;
    unserved: string;
    totalCost: string;
    totalDemand: string;
    totalCapacity: string;
  };
  cut: CapacityCutJson | null;
}

function mapToRecord(source: Map<string, bigint>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of source) record[key] = value.toString();
  return record;
}

function cutToJson(cut: CapacityCut | null): CapacityCutJson | null {
  if (cut === null) return null;
  return {
    sourceRegion: cut.sourceRegion,
    clusterRegion: cut.clusterRegion,
    sourceDemand: cut.sourceDemand.toString(),
    clusterCapacity: cut.clusterCapacity.toString(),
    cutCapacity: cut.cutCapacity.toString(),
    unserved: cut.unserved.toString(),
    tight: cut.tight,
  };
}

/** Converts a planning result into plain JSON-safe data (bigints as strings). */
export function toJson(result: PlanResult): PlanResultJson {
  return {
    assignments: result.assignments.map((assignment) => ({
      source: assignment.source,
      cluster: assignment.cluster,
      requests: assignment.requests.toString(),
      unitCost: assignment.unitCost.toString(),
      cost: assignment.cost.toString(),
    })),
    servedBySource: mapToRecord(result.servedBySource),
    unservedBySource: mapToRecord(result.unservedBySource),
    usedByCluster: mapToRecord(result.usedByCluster),
    summary: {
      served: result.summary.served.toString(),
      unserved: result.summary.unserved.toString(),
      totalCost: result.summary.totalCost.toString(),
      totalDemand: result.summary.totalDemand.toString(),
      totalCapacity: result.summary.totalCapacity.toString(),
    },
    cut: cutToJson(result.cut),
  };
}

/** Plans a JSON-parsed input document directly. */
export function fromJson(document: PlanJson): PlanResultJson {
  const input: PlanInput = {
    sources: document.sources.map((source) => ({ id: source.id, demand: source.demand })),
    clusters: document.clusters.map((cluster) => ({
      id: cluster.id,
      capacity: cluster.capacity,
    })),
    edges: document.edges.map((edge) => ({
      source: edge.source,
      cluster: edge.cluster,
      cost: edge.cost,
    })),
  };
  return toJson(plan(input));
}
