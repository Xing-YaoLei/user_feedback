/**
 * Public domain types: record identity, topology and query results.
 */

/**
 * Record identity. The four-tuple (stage, partition, generation, offset)
 * uniquely identifies one registered record.
 *
 * - stage:      pipeline stage name (source / intermediate / sink)
 * - partition:  partition number inside that stage
 * - generation: epoch/generation of the stage; offsets may be reused after a
 *               generation switch but never collide because the generation is
 *               part of the identity
 * - offset:     monotonically increasing, gap-free offset inside one
 *               (stage, partition, generation) stream
 */
export interface RecordId {
  stage: string;
  partition: number;
  generation: number;
  offset: number;
}

export type StageKind = "source" | "intermediate" | "sink";

export interface StageSpec {
  name: string;
  kind: StageKind;
}

/**
 * Declarative stage topology. `edges` pairs an input stage with an output
 * stage; registration of successors is validated against this DAG.
 */
export interface Topology {
  stages: StageSpec[];
  edges: Array<{ from: string; to: string }>;
}

export interface LineageStoreOptions {
  /**
   * Maximum number of simultaneously live (not yet complete) records.
   * New registration beyond this fails with BackpressureError; seals and
   * confirmations release capacity. `undefined` means unbounded.
   */
  capacity?: number;
}

/** A half-open discrete offset interval [start, end). */
export interface OffsetInterval {
  start: number;
  end: number;
}

/**
 * Terminal report for one (sink, partition, generation).
 * - confirmedFrontier: continuous confirmed prefix length (next unconfirmed offset)
 * - intervals:         every confirmed interval, including holes after the frontier
 */
export interface SinkReport {
  stage: string;
  partition: number;
  generation: number;
  maxOffset: number;
  confirmedFrontier: number;
  intervals: OffsetInterval[];
}

/** Why a source position is currently blocked from being committed. */
export type BlockReason =
  | "unsealed" // the record itself has not been sealed yet
  | "unregistered" // the successor declaration is missing (seal not seen)
  | "unconfirmed" // a reachable terminal output has not been confirmed
  | "filtered" // terminal of a filtered (zero-successor sealed) branch — never a blocker, kept for debugging
  | "cycle";

export interface Blocker {
  record: RecordId;
  reason: BlockReason;
}

export interface SourcePositionExplanation {
  source: string;
  partition: number;
  generation: number;
  offset: number;
  /** "committed" | "committable" | "blocked" | "not-registered" | "evicted" | "complete-pending-prefix" */
  state: string;
  commitFrontier: number;
  blockers: Blocker[];
}

export interface CompactStats {
  evictedRecords: number;
  remainingRecords: number;
  spgSummaries: number;
}

export interface StoreStats {
  liveRecords: number;
  totalRecords: number;
  completeRecords: number;
  spgCount: number;
}

/** Stringify a record identity into a stable map key. */
export function recordKey(id: RecordId): string {
  return `${id.stage}#${id.partition}#${id.generation}#${id.offset}`;
}

/** Key of the continuous stream (stage-partition-generation) a record belongs to. */
export function spgKeyOf(id: Pick<RecordId, "stage" | "partition" | "generation">): string {
  return `${id.stage}#${id.partition}#${id.generation}`;
}

export function sameRecord(a: RecordId, b: RecordId): boolean {
  return (
    a.stage === b.stage &&
    a.partition === b.partition &&
    a.generation === b.generation &&
    a.offset === b.offset
  );
}
