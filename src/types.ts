/**
 * Public types for the long-polling read module.
 *
 * The adapter contract is deliberately small: a partition snapshot pinned at a
 * revision, plus change notifications that can continue from a given revision.
 * That is enough for a reader to take one consistent cross-partition upper
 * bound and to avoid losing appends that land between "not enough data" and
 * "we are watching".
 */

/** A single record as stored by the log. */
export interface LogRecord {
  /** Size of the record body in bytes, as declared by the log. */
  bytes: number;
  /** Opaque record payload. */
  value: unknown;
}

/**
 * A partition snapshot as of one revision.
 *
 * `records[i]` is the record whose offset is `startOffset + i`. A snapshot
 * never contains holes, so `records.length === nextOffset - startOffset`.
 */
export interface PartitionSnapshot {
  partition: string;
  /** Lowest offset still retained in `records`. */
  startOffset: number;
  /** Offset just past the last record visible at the snapshot revision. */
  nextOffset: number;
  /** Revision this snapshot is pinned at. */
  revision: number;
  records: readonly LogRecord[];
}

/** A change notification delivered by an adapter. */
export interface ChangeNotification {
  /** Revision of the log at the moment of the change. */
  revision: number;
  /** Partitions that advanced; never empty. */
  partitions: readonly string[];
}

export type ChangeListener = (notification: ChangeNotification) => void;

export type Unsubscribe = () => void;

/**
 * The log adapter the reader is built on.
 *
 * Implementations must guarantee:
 *  - `snapshotRevision()` never goes backwards.
 *  - `snapshot(partition, revision)` returns a snapshot pinned at exactly
 *    `revision` (or at the current revision when omitted). Snapshots at the
 *    same revision are consistent across partitions and exclude records
 *    appended at later revisions.
 *  - `subscribe(listener, sinceRevision)` delivers a notification for every
 *    change whose revision is greater than `sinceRevision` — including changes
 *    that landed before the `subscribe` call returned. Replayed notifications
 *    may be delivered synchronously, and duplicates are permitted.
 *  - A notification is delivered only after the snapshot at its revision is
 *    readable.
 */
export interface LogAdapter {
  /** Partitions in the log, in a stable order. */
  partitions(): readonly string[];
  /** Current revision of the log. */
  snapshotRevision(): number;
  /** Snapshot one partition pinned at `revision` (current if omitted). */
  snapshot(partition: string, revision?: number): PartitionSnapshot;
  /**
   * Subscribe to changes. The listener receives every advanced partition (the
   * reader filters by interest). Passing `sinceRevision` replays changes after
   * that revision.
   */
  subscribe(listener: ChangeListener, sinceRevision?: number): Unsubscribe;
  /** Size in bytes of a record body. */
  byteLength(record: LogRecord): number;
}

/** A long-poll read request. */
export interface ReadRequest {
  /**
   * Partitions to read, in round-robin order. Each round takes at most one
   * record from each partition, skipping partitions with no record available.
   */
  partitions: readonly string[];
  /** First offset to read, required for every requested partition. */
  startOffsets: Readonly<Record<string, number>>;
  /** Return once at least this many body bytes have been packed. */
  minBytes: number;
  /** Upper bound on body bytes in one pack (see the oversized-first rule). */
  maxBytes: number;
  /** Upper bound on the record count in one pack. */
  maxRecords: number;
  /** Longest time to wait for enough data, in milliseconds. */
  waitMs: number;
  /** Cancels this read only; other reads sharing the subscription continue. */
  signal?: AbortSignal;
}

/**
 * Why a read returned. A read settles once, with exactly one of these.
 *
 * - `min-bytes`: the pack reached `minBytes` (also returned immediately when
 *   `minBytes` is 0 or every requested partition is empty).
 * - `deadline`: the wait expired; the pack holds whatever fit at that moment
 *   (possibly nothing), never exceeding `maxBytes` or `maxRecords`.
 * - `cancelled`: this read's signal ended its wait; no pack is returned.
 */
export type ReadStatus = 'min-bytes' | 'deadline' | 'cancelled';

/** How packing stopped within one snapshot round. */
export type PackStopReason = 'min-bytes' | 'max-bytes' | 'max-records' | 'exhausted';

/** Records packed from one partition. */
export interface ReadPartitionResult {
  partition: string;
  /** Start offset echoed from the request. */
  startOffset: number;
  /**
   * Offset of `records[0]`. Differs from `startOffset` only when the log has
   * already trimmed the requested offset; equals `nextOffset` when nothing was
   * packed.
   */
  firstOffset: number;
  /** Offset to resume from on the next read. */
  nextOffset: number;
  records: LogRecord[];
  bytes: number;
}

/** Result of one read. */
export interface ReadResult {
  status: ReadStatus;
  /**
   * Revision whose consistent partition snapshots produced this decision.
   * Records appended after this revision are left for the next read.
   * `null` for a cancelled read, which returns no pack.
   */
  revision: number | null;
  /** Per-partition results in request order (empty partitions included). */
  partitions: ReadPartitionResult[];
  /** Total body bytes packed. */
  bytes: number;
  /** Total records packed. */
  recordCount: number;
  /** Convenience map of `partition -> nextOffset` for resuming. */
  nextOffsets: Record<string, number>;
  /** How packing stopped, for diagnostics and tests. */
  stopReason: PackStopReason;
}
