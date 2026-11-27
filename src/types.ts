/**
 * Public types for the discovery-view synthesis module.
 *
 * Everything here is data-in / data-out. The module never reads a clock, never
 * performs I/O and never depends on wall time: callers supply the receipt
 * timestamp for every update and the `now` value for every query.
 */

/** Stable identifier of a discovery source, e.g. "primary" or "fallback". */
export type SourceId = string;

/** Logical service name. Facts are keyed by (serviceId, instanceId). */
export type ServiceId = string;

/** A source generation number. Higher generations supersede lower ones. */
export type Generation = number;

/** Source sequence number; increments by exactly one per accepted update. */
export type SequenceNumber = number;

/**
 * An availability record. `value` is an opaque, caller-owned payload (any JSON
 * value, including `null`); the module never interprets it.
 */
export interface AvailableRecord {
  readonly kind: "value";
  readonly value: unknown;
}

/** An authoritative deletion marker for an instance. */
export interface TombstoneRecord {
  readonly kind: "tombstone";
}

export type InstanceRecord = AvailableRecord | TombstoneRecord;

/**
 * A full snapshot: the authoritative, complete contents of one source view.
 * Records are nested service -> instance id -> record. The map is exhaustive:
 * an instance absent from a snapshot means this source no longer holds a fact
 * for it, so resolution may fall back to another source.
 */
export interface SnapshotUpdate {
  readonly kind: "snapshot";
  readonly sourceId: SourceId;
  readonly generation: Generation;
  readonly sequence: SequenceNumber;
  readonly records: ReadonlyMap<ServiceId, ReadonlyMap<string, InstanceRecord>>;
  /** Validity duration in milliseconds, measured from local receipt time. */
  readonly ttlMs: number;
}

/** An incremental update: exactly one (service, instance) fact changed. */
export interface DeltaUpdate {
  readonly kind: "delta";
  readonly sourceId: SourceId;
  readonly generation: Generation;
  readonly sequence: SequenceNumber;
  readonly serviceId: ServiceId;
  readonly instanceId: string;
  /** New record, or `undefined` to drop this source's fact for the instance. */
  readonly record: InstanceRecord | undefined;
  /** Validity duration in milliseconds, measured from local receipt time. */
  readonly ttlMs: number;
}

export type SourceUpdate = SnapshotUpdate | DeltaUpdate;

/** A single update paired with the local receipt timestamp supplied by the caller. */
export interface Receipt<U extends SourceUpdate = SourceUpdate> {
  readonly update: U;
  /** Local receipt time in epoch milliseconds, supplied by the caller. */
  readonly receivedAt: number;
}

/** Where a synthesised answer came from. */
export interface SourceRef {
  readonly sourceId: SourceId;
  readonly generation: Generation;
  readonly sequence: SequenceNumber;
}

/** Why a fact lost to the winning fact. */
export type ShadowReason =
  | "lower-priority"          // a higher-priority source also held a fact
  | "overridden-by-tombstone" // the winner is an authoritative deletion marker
  | "source-unusable";        // the source holds the fact but its view is not in force

/** A fact that was considered but lost to a higher-priority, valid fact. */
export interface ShadowedFact {
  readonly sourceId: SourceId;
  readonly priority: number;
  readonly generation: Generation;
  readonly sequence: SequenceNumber;
  readonly reason: ShadowReason;
}

export interface AvailableResolution {
  readonly serviceId: ServiceId;
  readonly instanceId: string;
  readonly state: "available";
  readonly value: unknown;
  readonly source: SourceRef;
  readonly shadowed: readonly ShadowedFact[];
}

export interface DeletedResolution {
  readonly serviceId: ServiceId;
  readonly instanceId: string;
  readonly state: "deleted";
  /** Source whose authoritative deletion marker is in force. */
  readonly source: SourceRef;
  /** Facts hidden by the deletion marker. */
  readonly shadowed: readonly ShadowedFact[];
}

export interface AbsentResolution {
  readonly serviceId: ServiceId;
  readonly instanceId: string;
  readonly state: "absent";
  /** No source contributes a fact; entries explain sources that held one. */
  readonly shadowed: readonly ShadowedFact[];
}

export type InstanceResolution = AvailableResolution | DeletedResolution | AbsentResolution;

/** Why a source is not contributing. */
export type SourceIssueReason =
  | "gap"             // an increment skipped a sequence number (out of sync)
  | "expired"         // the source's validity window closed normally
  | "source-conflict" // same generation + sequence carried different content
  | "invalid";        // the update itself was malformed

export interface SourceIssue {
  readonly sourceId: SourceId;
  readonly reason: SourceIssueReason;
  readonly generation: Generation;
  readonly sequence: SequenceNumber;
}

/** Diagnostics snapshot of one registered source. */
export interface SourceStatus {
  readonly sourceId: SourceId;
  readonly priority: number;
  /** Highest generation observed from this source, or `null`. */
  readonly generation: Generation | null;
  /** Highest sequence accepted in the active generation, or `null`. */
  readonly sequence: SequenceNumber | null;
  /** True when the source currently contributes facts to the view. */
  readonly usable: boolean;
  /** True when a sequence gap made the whole view unusable. */
  readonly blocked: boolean;
  /** True when a held view's validity window has closed. */
  readonly expired: boolean;
  /** Local receipt instant of the accepted update that opened the window. */
  readonly receivedAt: number | null;
  /** Absolute expiry instant, or `null` when no window is open. */
  readonly expiresAt: number | null;
  readonly issue: SourceIssue | null;
}

/** The value returned by `query` / `render`. */
export interface DiscoveryView {
  readonly at: number;
  readonly instances: readonly InstanceResolution[];
  readonly sources: readonly SourceStatus[];
}

/** Per-update classification inside a batch. */
export type UpdateDisposition = "applied" | "ignored" | "rejected";

export type IgnoredReason = "outdated-generation" | "outdated-sequence" | "duplicate";

export type RejectedReason =
  | "unknown-source"
  | "invalid"
  | "gap"
  | "conflict"
  | "expired";

export interface BatchUpdateResult {
  readonly index: number;
  readonly sourceId: SourceId;
  readonly status: UpdateDisposition;
  readonly reason: IgnoredReason | RejectedReason | null;
}

/** Coarse outcome of applying one batch. */
export type BatchOutcome =
  | "applied"           // every update applied (or the batch was empty)
  | "partially-applied" // some applied, some ignored/rejected
  | "unchanged"         // nothing applied, but nothing rejected either
  | "rejected";         // nothing applied and at least one update rejected

export interface BatchResult {
  readonly outcome: BatchOutcome;
  readonly results: readonly BatchUpdateResult[];
  readonly applied: number;
  readonly ignored: number;
  readonly rejected: number;
}

/** Configuration for one source. */
export interface SourceConfig {
  readonly sourceId: SourceId;
  /** Lower number = higher priority. Must be unique across sources. */
  readonly priority: number;
}

export interface ConfigureOptions {
  readonly sources: readonly SourceConfig[];
}

export interface QueryOptions {
  /** Restrict the view to one service. */
  readonly serviceId?: ServiceId;
  /** Restrict the view to one instance id. */
  readonly instanceId?: string;
}
