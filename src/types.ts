/**
 * Public types for the embeddable session registry directory.
 *
 * Revision model
 * --------------
 * A revision is a non-negative integer; revision 0 is the empty directory.
 * Every atomic mutation (batch register, batch unregister, lease-expiry
 * sweep) receives exactly one new revision. Lease open/renew/close, cursor
 * open/poll/close and history compaction never consume a revision.
 *
 * Visibility model
 * ----------------
 *  - Queries observe whole revisions; a batch is never partially visible.
 *  - A pagination token is pinned to the revision of its first page. Every
 *    later page is a window over that exact snapshot, so inserts, deletes,
 *    re-registrations and ordering changes during paging cannot create gaps
 *    or duplicates across pages.
 *  - A subscription consumes strictly after the revision it was given and
 *    replays whole batches. Prefix-filtered batches still advance the
 *    resumable position, so revision jumps are part of the progress.
 *
 * Retention model
 * ---------------
 *  - The directory keeps a checkpoint state plus the batches after it. The
 *    checkpoint revision is the oldest revision at which a snapshot can be
 *    reconstructed and from which a subscription can resume.
 *  - Open page cursors pin their snapshot revision; open subscriptions pin
 *    their last delivered revision. Compaction cannot move past a pin unless
 *    the hard retention cap forces it, in which case the affected cursor is
 *    expired with an explicit rebuild signal.
 *  - Closing or expiring a cursor releases its pin, letting later compaction
 *    reclaim that history.
 */

export type Revision = number;

/** A name may be hierarchical (for example `/svc/api/a`); prefix queries are string prefixes. */
export interface InstanceInput {
  name: string;
  address?: string | null;
  weight?: number;
  metadata?: Readonly<Record<string, string>>;
}

/** Immutable view of one registered instance generation. */
export interface InstanceView {
  readonly name: string;
  readonly address: string | null;
  readonly weight: number;
  readonly metadata: Readonly<Record<string, string>>;
  /** Session that owns this registration generation. */
  readonly sessionId: string;
  /** Generation of the owning session at registration time. */
  readonly sessionGeneration: number;
  /** Monotonic per-name generation. Every put creates a new generation. */
  readonly generation: number;
  /** Lease that covers this exact generation. */
  readonly leaseId: string;
  /** Revision at which this generation became visible. */
  readonly registeredRevision: Revision;
}

export interface LeaseHandle {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export interface LeaseEntryView {
  readonly name: string;
  readonly generation: number;
  /** True when this entry still owns the name's current generation. */
  readonly current: boolean;
}

export interface LeaseView extends LeaseHandle {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly ttlMs: number;
  readonly closed: boolean;
  readonly closedReason: 'caller' | 'expired' | 'superseded' | null;
  readonly entries: readonly LeaseEntryView[];
}

/* ------------------------------------------------------------------ changes */

export interface PutChange {
  readonly type: 'put';
  readonly name: string;
  readonly instance: InstanceView;
  /** Previous generation at this name, if any. */
  readonly supersedes: InstanceView | null;
  readonly reason: 'register' | 'replace' | 'takeover';
}

export interface DeleteChange {
  readonly type: 'delete';
  readonly name: string;
  readonly previous: InstanceView;
  readonly reason: 'release' | 'expired';
}

export type Change = PutChange | DeleteChange;

/** One atomic revision. A batch is visible as a whole in queries and subscriptions. */
export interface RevisionBatch {
  readonly revision: Revision;
  readonly changes: readonly Change[];
}

/* --------------------------------------------------------------- pagination */

export interface PageOptions {
  /** Prefix filter; empty means every name. Default ''. */
  prefix?: string;
  /** Maximum instances on one page. Default 100; bounded by the directory max. */
  pageSize?: number;
  /**
   * Snapshot at this revision instead of the current revision. Must be within
   * retained history. Useful to rebuild a client at a well-defined baseline.
   */
  atRevision?: Revision;
}

export interface Page {
  /** Identity of the page cursor; pass to closePage(). */
  readonly cursorId: string;
  /** Snapshot revision the whole pagination belongs to. */
  readonly revision: Revision;
  /**
   * Instances that matched the prefix in this snapshot, ordered by code-unit
   * comparison of names. Each instance carries the generation visible at
   * `revision`, so a re-registration during paging cannot leak into a later
   * page.
   */
  readonly items: readonly InstanceView[];
  /** Next continuation token, or null when this page completes the snapshot. */
  readonly nextToken: string | null;
  /** 1-based index of this page. */
  readonly pageNumber: number;
  /** True when this page completes the snapshot (nextToken is null). */
  readonly done: boolean;
}

export interface CursorCloseResult {
  readonly cursorId: string;
  /** Revision the cursor was pinned at (release boundary for retention). */
  readonly releasedRevision: Revision;
  readonly currentRevision: Revision;
  readonly alreadyClosed: boolean;
  readonly closedReason: CursorCloseReason | null;
}

/* -------------------------------------------------------------- subscriptions */

export interface PollLimit {
  /** Maximum number of non-empty batches returned by one poll. Default 1000. */
  maxBatches?: number;
  /** Maximum changes summed across returned batches. Default 10000. */
  maxChanges?: number;
}

export interface RebuildInfo {
  readonly cursorId: string;
  readonly kind: 'page' | 'subscription';
  readonly reason: SubscriptionCloseReason;
  /** Position the failed cursor had actually delivered. */
  readonly lastDeliveredRevision: Revision;
  /**
   * Revision a rebuilt client should either resume after, or snapshot at when
   * history no longer supports lastDeliveredRevision.
   */
  readonly sinceRevision: Revision;
  readonly currentRevision: Revision;
  readonly message: string;
}

export interface CursorExpiredInfo {
  readonly kind: 'page' | 'subscription';
  readonly cursorId: string;
  readonly prefix: string;
  readonly reason: CursorExpiryReason;
  /** Oldest revision with replayable history at the moment of expiry. */
  readonly oldestRetainedRevision: Revision;
  readonly currentRevision: Revision;
  readonly message: string;
  readonly rebuild: RebuildInfo;
}

export type SubscriptionCloseReason =
  | 'caller-closed'
  | 'backlog-overflow'
  | 'capacity-evicted'
  | 'ttl-expired'
  | 'history-compacted'
  | 'directory-closed';

/** Page cursors close for a subset of the reasons subscriptions do. */
export type CursorCloseReason =
  | 'caller-closed'
  | 'capacity-evicted'
  | 'ttl-expired'
  | 'history-compacted'
  | 'directory-closed'
  | 'completed';

export type CursorExpiryReason = 'history-compacted' | 'ttl-expired' | 'capacity-evicted';

export interface PollResult {
  readonly cursorId: string;
  /** True while this subscription is still open and usable. */
  readonly active: boolean;
  /** Non-empty batches in revision order; empty filtered batches are skipped. */
  readonly batches: readonly RevisionBatch[];
  /**
   * Revision after the returned batches. The next poll resumes here.
   * When a prefix filters a whole batch out, the batch is not returned but
   * its revision is still consumed, so progress reflects the jump.
   */
  readonly position: Revision;
  /** True when the subscription is no longer usable. */
  readonly closed: boolean;
  /** Set when the subscription is no longer usable. */
  readonly closedReason: SubscriptionCloseReason | null;
  /** Set when history/capacity/lifetime made the cursor unusable. */
  readonly expired: CursorExpiredInfo | null;
  /** Set when a rebuild is required, with the revision to rebuild from. */
  readonly rebuild: RebuildInfo | null;
}

export interface SubscriptionEpoch {
  /** Cursor identity; a reconnect yields a new cursor id. */
  readonly subscriptionId: string;
  /** Revision at which this subscription starts consuming changes. */
  readonly sinceRevision: Revision;
  /** True when an explicit sinceRevision was supplied. */
  readonly resumed: boolean;
  /** Cursor id of a previous subscription this one replaces, if supplied. */
  readonly resumedFrom: string | null;
}

export interface SubscriptionOptions extends PollLimit {
  /** Prefix filter; empty/undefined subscribes to every name. */
  prefix?: string;
  /**
   * Resume strictly after this revision. Omit to start after the current
   * revision. An explicit value older than retained history is rejected with
   * CursorExpiredError carrying rebuild instructions.
   */
  sinceRevision?: Revision;
  /** Maximum queued matching changes before eviction. Default from config (4096). */
  maxBacklogChanges?: number;
  /** Maximum queued non-empty batches before eviction. Default 0 = unlimited. */
  maxBacklogBatches?: number;
  /** Cursor id of the subscription being replaced (recorded in the epoch). */
  resumedFrom?: string;
}

export interface Subscription {
  readonly cursorId: string;
  readonly prefix: string;
  readonly epoch: SubscriptionEpoch;
  readonly closed: boolean;
  poll(limit?: PollLimit): PollResult;
  close(): CursorCloseResult;
}

/* -------------------------------------------------------------------- reads */

export interface QueryOptions {
  prefix?: string;
}

export interface QueryResult {
  readonly revision: Revision;
  readonly items: readonly InstanceView[];
}

/* ------------------------------------------------------------------ results */

export interface RegisterResult {
  readonly revision: Revision;
  readonly changes: readonly Change[];
}

export interface StaleDelete {
  readonly name: string;
  /** Current instance owned by another generation; left untouched. */
  readonly current: InstanceView;
  readonly requestedBy: LeaseHandle;
}

export interface UnregisterResult {
  readonly revision: Revision;
  readonly deleted: readonly DeleteChange[];
  readonly stale: readonly StaleDelete[];
  readonly missing: readonly string[];
}

export interface CloseLeaseResult {
  readonly revision: Revision;
  readonly deleted: readonly DeleteChange[];
  readonly alreadyClosed: boolean;
}

export interface CompactionResult {
  readonly revision: Revision;
  readonly oldestRetainedRevision: Revision;
  readonly droppedBatches: number;
  readonly expiredCursors: readonly string[];
}

export interface SweepResult {
  readonly revision: Revision;
  readonly expiredLeases: readonly string[];
  readonly expiredDeletes: readonly DeleteChange[];
  readonly expiredSubscriptions: readonly string[];
  readonly expiredPageCursors: readonly string[];
}

export interface DirectoryStatus {
  readonly revision: Revision;
  /** Oldest revision whose snapshot can be reconstructed / resubscribed from. */
  readonly oldestRetainedRevision: Revision;
  /** Number of replayable revisions (currentRevision - checkpoint). */
  readonly retainedRevisionCount: number;
  readonly instanceCount: number;
  readonly activeLeaseCount: number;
  readonly openPageCursors: number;
  readonly openSubscriptions: number;
  /** Closed/expired cursor records retained for precise close/expiry signals. */
  readonly cursorHistoryRecords: number;
  readonly closed: boolean;
}

export interface SessionOpenOptions {
  /** Reuse this session id; a new generation is issued and takes over old names. */
  sessionId?: string;
  /** Lease lifetime in milliseconds. Default from config (30000). */
  ttlMs?: number;
}

/** Injected time source; defaults to Date.now. */
export type Clock = () => number;

export interface DirectoryOptions {
  clock?: Clock;
  /** Signing secret for pagination tokens. A random secret is generated by default. */
  secret?: string | Uint8Array;
  /** Id factory for directory/lease/page/subscription ids. Defaults to crypto.randomUUID. */
  idFactory?: (kind: 'directory' | 'lease' | 'page' | 'subscription') => string;
  history?: {
    /** Revisions kept by default, without cursor pins. Default 64. */
    retainRevisions?: number;
    /** Hard cap on retained revisions, including cursor pins. Default 4096. */
    maxRetainedRevisions?: number;
    /** Compact automatically after commits and cursor closes. Default true. */
    autoCompact?: boolean;
  };
  pagination?: {
    defaultPageSize?: number;
    maxPageSize?: number;
    /** Page-cursor lifetime in milliseconds; 0 disables. Default 60000. */
    cursorTtlMs?: number;
    /** Maximum open page cursors; the oldest is evicted. Default 128. */
    maxCursors?: number;
  };
  subscriptions?: {
    defaultMaxBacklogChanges?: number;
    /** Maximum open subscriptions; the oldest is retired. Default 256. */
    maxSubscriptions?: number;
    /** Subscription lifetime in milliseconds; 0 disables. Default 0. */
    cursorTtlMs?: number;
  };
  leases?: {
    defaultTtlMs?: number;
  };
}
