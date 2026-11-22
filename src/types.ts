/**
 * Public types for the embeddable lease registry.
 *
 * The registry mimics a small subset of etcd semantics:
 *  - every atomic batch of mutations gets one globally increasing revision
 *  - reads are served from an immutable snapshot identified by a revision
 *  - pagination tokens bind a read to that snapshot revision
 *  - watches start after a given revision and can be resumed by progress cursor
 *  - every key carries a per-key monotonic generation (fencing token) bound to
 *    the session that currently owns it
 */

/** Arbitrary application payload stored alongside an instance. */
export type InstanceData = Record<string, unknown>;

/** A live service instance as visible at some revision. */
export interface Instance {
  /** Full key, e.g. `services/billing/instance-a`. */
  key: string;
  data: InstanceData;
  /** Session that currently owns the key. */
  sessionId: string;
  /** Per-key monotonic generation; bumped on every (re-)registration. */
  generation: number;
  /** Revision at which this generation was written. */
  createRevision: number;
  /** Logical lease expiry time (ms on the registry clock). */
  leaseExpiresAt: number;
}

/** One key/value version stored in MVCC history. */
export interface KeyVersion {
  /** Revision that wrote this version. */
  revision: number;
  /** `true` for a tombstone (deletion). */
  deleted: boolean;
  instance: Instance | null;
  /** Per-key monotonic generation captured by this version. */
  generation: number;
}

/** Kind of change carried by an event. */
export type EventKind = 'put' | 'delete';

/** A single change inside a revision record. */
export interface EventRecord {
  kind: EventKind;
  key: string;
  /** Present for puts, null for deletes. */
  instance: Instance | null;
  /** Generation of the key as of this event (1-based, never reset on delete). */
  generation: number;
  /** Session that produced the change (or the expired session). */
  sessionId: string;
}

/** All events of one atomic batch share the same revision. */
export interface RevisionRecord {
  revision: number;
  timestamp: number;
  events: EventRecord[];
  /** True when the revision was produced by an automatic session expiry. */
  causedByExpiry: boolean;
}

/** A single mutation inside a batch. */
export interface Mutation {
  type: 'put' | 'delete';
  key: string;
  data?: InstanceData;
  /**
   * For deletes: only apply when the live generation matches.
   * Puts always take over the key and bump the generation.
   */
  expectedGeneration?: number;
}

/** Result returned by {@link Registry.mutate}. */
export interface MutateResult {
  revision: number;
  events: EventRecord[];
}

/** A page of instances read from one immutable snapshot. */
export interface PageResult {
  instances: Instance[];
  /** Revision of the snapshot shared by every page of this read. */
  revision: number;
  /** Opaque token for the next page, or null when the scan is finished. */
  nextPageToken: string | null;
}

/** Options accepted by a paginated prefix read. */
export interface ListOptions {
  prefix?: string;
  pageSize?: number;
  /** Token returned by a previous page (must be used with the same prefix). */
  pageToken?: string;
}

/** One event delivered to a watcher. */
export interface WatchEvent {
  kind: EventKind;
  key: string;
  instance: Instance | null;
  generation: number;
  /** Revision that produced the event. */
  revision: number;
}

/**
 * Progress heartbeat. Watches always advance to the registry's current
 * revision even when prefix filtering skipped every event, so a resume cursor
 * never replays filtered-out revisions again.
 */
export interface WatchProgress {
  type: 'progress';
  /** Revision fully consumed; resume with `startRevision = progress + 1`. */
  progress: number;
}

export interface WatchChangeMessage {
  type: 'changes';
  revision: number;
  events: WatchEvent[];
}

export type WatchMessage = WatchChangeMessage | WatchProgress;

/** Why a cursor or watch can no longer be served. */
export type ExpiryReason =
  | 'compacted' // history behind the cursor was compacted away
  | 'liveness' // cursor exceeded its TTL / liveness window
  | 'capacity' // evicted because the registry cursor capacity was reached
  | 'backlog'; // slow watcher exceeded its backlog limit

export interface RebuildBasis {
  /** Snapshot revision to re-read with a fresh paginated list. */
  snapshotRevision: number;
  /** Resume the new watch strictly after this revision. */
  resumeAfterRevision: number;
  reason: ExpiryReason;
}

/** Tunable limits; ttlMs values use the registry clock. */
export interface RegistryOptions {
  /** TTL for pagination cursors. Default 30s. */
  pageTtlMs?: number;
  /** Max number of concurrently live pagination cursors. Default 64. */
  maxPageCursors?: number;
  /** TTL for an idle watch (no consume/keepalive). Default 60s. */
  watchTtlMs?: number;
  /** Max number of concurrently live watches. Default 64. */
  maxWatches?: number;
  /**
   * Max backlog of undelivered revisions per watch. When exceeded the watch is
   * closed with reason `backlog` plus a rebuild basis. Default 128.
   */
  watchBacklogLimit?: number;
  /**
   * Optional automatic history compaction: when the retained revision log
   * grows beyond this many revisions the oldest ones are compacted. Defaults
   * to Infinity (manual compaction only).
   */
  maxRetainedRevisions?: number;
  /** How often the internal TTL sweeper runs (manual clock ignores this). */
  sweepIntervalMs?: number;
}

/** Subset of a clock used throughout the registry. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, delayMs: number): { unref(): void; refresh(): void } | { unref(): void };
  clearTimeout(handle: unknown): void;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SessionExpiredError extends RegistryError {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} is expired or unknown`);
    this.sessionId = sessionId;
  }
}

export class GenerationConflictError extends RegistryError {
  readonly key: string;
  readonly expected: number;
  readonly actual: number;
  constructor(key: string, expected: number, actual: number) {
    super(`generation conflict on ${key}: expected ${expected}, actual ${actual}`);
    this.key = key;
    this.expected = expected;
    this.actual = actual;
  }
}

export class InvalidTokenError extends RegistryError {}

/**
 * Thrown when a cursor references history that no longer exists or a cursor
 * handle has expired. Callers must rebuild: take a fresh snapshot (list) and
 * start a new watch from {@link rebuildBasis}.
 */
export class CursorExpiredError extends RegistryError {
  readonly kind: 'page' | 'watch';
  readonly reason: ExpiryReason;
  readonly rebuildBasis: RebuildBasis;
  constructor(kind: 'page' | 'watch', reason: ExpiryReason, rebuildBasis: RebuildBasis) {
    super(
      `${kind} cursor expired (${reason}); rebuild from snapshot revision ${rebuildBasis.snapshotRevision}`,
    );
    this.kind = kind;
    this.reason = reason;
    this.rebuildBasis = rebuildBasis;
  }
}

export class RegistryClosedError extends RegistryError {
  constructor() {
    super('registry is closed');
  }
}
