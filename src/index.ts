/**
 * Offset lineage module — single entry point.
 */
export { LineageStore } from "./store.ts";
export { IntervalSet } from "./interval.ts";
export {
  LineageError,
  BackpressureError,
  DuplicateRecordError,
  UnknownRecordError,
  UnknownGenerationError,
  UnknownOffsetError,
  InvalidLineageError,
  InvalidTopologyError,
  CorruptStateError,
} from "./errors.ts";
export {
  recordKey,
  spgKeyOf,
  sameRecord,
  type RecordId,
  type StageKind,
  type StageSpec,
  type Topology,
  type LineageStoreOptions,
  type OffsetInterval,
  type SinkReport,
  type BlockReason,
  type Blocker,
  type SourcePositionExplanation,
  type CompactStats,
  type StoreStats,
} from "./types.ts";
