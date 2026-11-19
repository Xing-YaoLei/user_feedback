/**
 * Public types for the embeddable durable message queue.
 *
 * Vocabulary
 * ----------
 *  - artifact: the grouping key. Every event belongs to exactly one artifact
 *    (工件编号). Within an artifact, events are processed strictly in enqueue
 *    order. Across artifacts, work proceeds concurrently.
 *  - enqueue: a durable operation identified by `opId` that appends events.
 *  - lease: the right to process one event. At most one live lease per artifact;
 *    other artifacts keep flowing. Claiming is not idempotent: a consumer asks
 *    for work and either gets a lease or `null`.
 *  - ack: a durable operation identified by `opId` that completes a leased
 *    event and, in the same atomic step, appends follow-up events.
 *
 * Both enqueue and ack carry operation ids. Retrying a successful request with
 * identical content returns the original result — even when the lease token
 * used at the time has since expired. Reusing an id for different content is a
 * conflict. Presenting a stale lease token on a *new* ack is rejected.
 */

export type EventPayload = Readonly<Record<string, unknown>>;

export interface EnqueueRequest {
  /** Caller-supplied idempotency key for this enqueue. */
  opId: string;
  /** Artifact (工件编号) the events belong to. */
  artifactId: string;
  /** Events appended in array order. Must be non-empty. */
  events: readonly EventPayload[];
}

export interface EnqueuedEvent {
  /** Monotonic per-artifact sequence number, starting at 1. */
  seq: number;
  /**
   * Durable event id: `${artifactId}#${seq}`. Stable across redelivery and
   * across process restarts. (Artifact ids may themselves contain `#`; treat
   * the id as opaque and use `seq` when a number is needed.)
   */
  eventId: string;
  artifactId: string;
  payload: EventPayload;
  /** Enqueue op that created this event (an ack op id for follow-ups). */
  enqueuedBy: string;
}

export interface EnqueueResult {
  opId: string;
  kind: "enqueue";
  artifactId: string;
  events: EnqueuedEvent[];
  /** Wall-clock ms when the operation first committed. */
  committedAt: number;
}

export interface LeaseRequest {
  /** Consumer identity recorded on the lease. */
  consumerId: string;
  /** Lease duration in ms from the moment of the claim. Default 30_000. */
  leaseMs?: number;
  /**
   * How long the caller is willing to wait for an eligible artifact.
   * 0 (default) returns immediately, possibly with `lease: null`.
   */
  waitMs?: number;
}

export interface Lease {
  /** Opaque credential. Invalid as soon as the lease expires or is superseded. */
  token: string;
  eventId: string;
  artifactId: string;
  seq: number;
  payload: EventPayload;
  consumerId: string;
  /** Epoch ms after which the token is dead. */
  expiresAt: number;
  /** 1 for the first delivery, 2 for the first redelivery, ... */
  deliveryAttempt: number;
}

export interface AckRequest {
  opId: string;
  leaseToken: string;
  /** Follow-up events appended to the same artifact, in array order. */
  followUps?: readonly EventPayload[];
}

export interface AckResult {
  opId: string;
  kind: "ack";
  artifactId: string;
  eventId: string;
  /** Events that were enqueued atomically with this ack, in append order. */
  followUps: EnqueuedEvent[];
  committedAt: number;
}

export interface SnapshotResult {
  /** Durable snapshot file name (informational). */
  snapshot: string;
  /** Wall-clock ms when compaction completed. */
  completedAt: number;
  /** Number of journal records folded into the snapshot. */
  folded: number;
}

export interface QueueStats {
  artifacts: number;
  pending: number;
  inFlight: number;
  completed: number;
  /** Records in the active journal segment (older segments are compacted away). */
  journalEntries: number;
  journalBytes: number;
}

/**
 * Testing / operational hooks. They run inside the queue's commit path:
 *  - `afterCommit` is synchronous and is called after the record is fsynced and
 *    applied but before the result is returned. Blocking here (or killing the
 *    process) reproduces the "committed but no response" crash window.
 *  - `beforeSnapshotPublish` is awaited after the snapshot temp file is durable
 *    and before the atomic rename. Blocking here holds compaction mid-switch
 *    while regular enqueues and acks keep committing.
 */
export interface QueueInstrumentation {
  afterCommit?: (info: {
    kind: "enqueue" | "ack";
    opId: string;
    artifactId: string;
    journalGen: number;
    journalIndex: number;
  }) => void;
  beforeSnapshotPublish?: (info: { gen: number; tmpPath: string }) => void | Promise<void>;
}

export interface OpenOptions {
  /** Data directory. Created if absent. One queue process per directory. */
  directory: string;
  instrumentation?: QueueInstrumentation;
}

/** Stable error codes surfaced through {@link QueueError}. */
export type QueueErrorCode =
  | "INVALID_REQUEST"
  | "OP_ID_CONFLICT"
  | "STALE_LEASE"
  | "QUEUE_CLOSED"
  | "DIRECTORY_LOCKED"
  | "CORRUPT_JOURNAL"
  | "CORRUPT_SNAPSHOT";

export class QueueError extends Error {
  readonly code: QueueErrorCode;

  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------------- *
 * Durable record shapes (persisted in journals and snapshots)
 * ------------------------------------------------------------------------- */

export interface EnqueueRecord {
  type: "enqueue";
  opId: string;
  artifactId: string;
  fingerprint: string;
  committedAt: number;
  /** Events with their assigned ids and payloads, in append order. */
  events: EnqueuedEvent[];
}

export interface AckRecord {
  type: "ack";
  opId: string;
  fingerprint: string;
  artifactId: string;
  eventId: string;
  seq: number;
  committedAt: number;
  /** Follow-up events with assigned ids and payloads, in append order. */
  followUps: EnqueuedEvent[];
}

export type JournalRecordBody = EnqueueRecord | AckRecord;

export interface PersistedEvent {
  seq: number;
  eventId: string;
  payload: EventPayload;
  status: "pending" | "completed";
  enqueuedBy: string;
  deliveryAttempt: number;
}

export interface PersistedArtifact {
  id: string;
  nextSeq: number;
  events: PersistedEvent[];
}

export interface PersistedOperation {
  opId: string;
  fingerprint: string;
  result: EnqueueResult | AckResult;
}

export interface PersistedState {
  artifacts: PersistedArtifact[];
  ops: PersistedOperation[];
}
