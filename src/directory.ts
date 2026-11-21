import { randomUUID } from 'node:crypto';
import {
  CursorClosedError,
  CursorExpiredError,
  DirectoryClosedError,
  InvalidArgumentError,
  LeaseExpiredError,
  LeaseNotFoundError,
  LeaseSessionMismatchError,
  SnapshotUnavailableError,
} from './errors.ts';
import { TokenCodec } from './token.ts';
import type {
  Change,
  Clock,
  CloseLeaseResult,
  CompactionResult,
  CursorCloseReason,
  CursorCloseResult,
  CursorExpiredInfo,
  CursorExpiryReason,
  DeleteChange,
  DirectoryOptions,
  DirectoryStatus,
  InstanceInput,
  InstanceView,
  LeaseHandle,
  LeaseView,
  Page,
  PageOptions,
  PollLimit,
  PollResult,
  PutChange,
  QueryOptions,
  QueryResult,
  RebuildInfo,
  RegisterResult,
  Revision,
  RevisionBatch,
  SessionOpenOptions,
  Subscription,
  SubscriptionCloseReason,
  SubscriptionEpoch,
  SubscriptionOptions,
  SweepResult,
  UnregisterResult,
} from './types.ts';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE_CAP,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertPositiveInt,
  assertRevision,
  cloneInstance,
  compareNames,
  normalizeInput,
  normalizePageSize,
  normalizePrefix,
  sortInstances,
} from './util.ts';

/* ------------------------------------------------------------ internal types */

interface LeaseRecord {
  leaseId: string;
  sessionId: string;
  sessionGeneration: number;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  closed: boolean;
  closedReason: 'caller' | 'expired' | null;
  /** name -> per-name generation this lease owns. */
  entries: Map<string, number>;
}

interface PageCursorRecord {
  cursorId: string;
  revision: Revision;
  prefix: string;
  pageSize: number;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number;
}

interface ClosedCursorRecord {
  cursorId: string;
  kind: 'page' | 'subscription';
  reason: CursorCloseReason;
  revision: Revision;
  prefix: string;
  closedAt: number;
  /** True when an error (expiry/eviction) rather than an explicit close. */
  abnormal: boolean;
  expired: CursorExpiredInfo | null;
}

interface CompiledBatch extends RevisionBatch {
  readonly matches: (name: string) => boolean;
}

const CURSOR_HISTORY_LIMIT = 1024;

/* --------------------------------------------------------------------- clock */

class SystemClock {
  now(): number {
    return Date.now();
  }
}

function defaultIdFactory(kind: string): string {
  return kind + '_' + randomUUID();
}

/* ----------------------------------------------------------------- directory */

/**
 * An embeddable, in-memory registry directory with snapshot pagination,
 * resumable subscriptions, session-generation leases and bounded history.
 */
export class RegistryDirectory {
  readonly id: string;
  private readonly clock: Clock;
  private readonly codec: TokenCodec;
  private readonly idFactory: (kind: string) => string;

  private readonly retainRevisions: number;
  private readonly maxRetainedRevisions: number;
  private readonly autoCompact: boolean;
  private readonly defaultPageSize: number;
  private readonly maxPageSize: number;
  private readonly pageCursorTtlMs: number;
  private readonly maxPageCursors: number;
  private readonly defaultMaxBacklogChanges: number;
  private readonly maxSubscriptions: number;
  private readonly subscriptionTtlMs: number;
  private readonly defaultLeaseTtlMs: number;

  private revision: Revision = 0;
  private checkpointRevision: Revision = 0;
  /** Current state, at `revision`. */
  private state: Map<string, InstanceView> = new Map();
  /** Checkpoint state, at `checkpointRevision`. Instances are immutable. */
  private checkpointState: Map<string, InstanceView> = new Map();
  /** Replayable batches with revision > checkpointRevision, keyed by revision. */
  private readonly batches: Map<Revision, CompiledBatch> = new Map();
  /** Highest generation ever issued per name, so generations never repeat. */
  private readonly nameGenerations: Map<string, number> = new Map();
  /** Highest session generation ever issued per sessionId. */
  private readonly sessionGenerations: Map<string, number> = new Map();

  private readonly leases: Map<string, LeaseRecord> = new Map();
  private readonly pageCursors: Map<string, PageCursorRecord> = new Map();
  private readonly subscriptions: Map<string, SubscriptionImpl> = new Map();
  private readonly closedCursors: Map<string, ClosedCursorRecord> = new Map();
  private readonly closedCursorOrder: string[] = [];

  private closed = false;

  constructor(options: DirectoryOptions = {}) {
    const history = options.history ?? {};
    const pagination = options.pagination ?? {};
    const subs = options.subscriptions ?? {};
    const leases = options.leases ?? {};

    this.clock = options.clock ?? new SystemClock();
    this.codec = new TokenCodec(options.secret);
    this.idFactory =
      options.idFactory === undefined
        ? defaultIdFactory
        : (kind: string) => options.idFactory!(kind as never);

    this.retainRevisions = assertNonNegativeInt(
      history.retainRevisions,
      'history.retainRevisions',
      64,
    );
    this.maxRetainedRevisions = assertPositiveInt(
      history.maxRetainedRevisions,
      'history.maxRetainedRevisions',
      4096,
    );
    if (this.maxRetainedRevisions < this.retainRevisions) {
      throw new InvalidArgumentError(
        'history.maxRetainedRevisions must be >= history.retainRevisions',
      );
    }
    this.autoCompact = history.autoCompact ?? true;

    this.defaultPageSize = normalizePageSize(pagination.defaultPageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE_CAP);
    this.maxPageSize = normalizePageSize(pagination.maxPageSize, MAX_PAGE_SIZE_CAP, MAX_PAGE_SIZE_CAP);
    if (this.maxPageSize < this.defaultPageSize) {
      throw new InvalidArgumentError('pagination.maxPageSize must be >= pagination.defaultPageSize');
    }
    this.pageCursorTtlMs = assertNonNegativeInt(
      pagination.cursorTtlMs,
      'pagination.cursorTtlMs',
      60_000,
    );
    this.maxPageCursors = assertPositiveInt(pagination.maxCursors, 'pagination.maxCursors', 128);

    this.defaultMaxBacklogChanges = assertPositiveInt(
      subs.defaultMaxBacklogChanges,
      'subscriptions.defaultMaxBacklogChanges',
      4096,
    );
    this.maxSubscriptions = assertPositiveInt(subs.maxSubscriptions, 'subscriptions.maxSubscriptions', 256);
    this.subscriptionTtlMs = assertNonNegativeInt(subs.cursorTtlMs, 'subscriptions.cursorTtlMs', 0);

    this.defaultLeaseTtlMs = assertPositiveInt(leases.defaultTtlMs, 'leases.defaultTtlMs', 30_000);

    this.id = this.idFactory('directory');
  }

  /* ------------------------------------------------------------------ reads */

  /** Current revision. */
  get currentRevision(): Revision {
    return this.revision;
  }

  /** Oldest revision a snapshot can be reconstructed from. */
  get oldestRetainedRevision(): Revision {
    return this.checkpointRevision;
  }

  status(): DirectoryStatus {
    return {
      revision: this.revision,
      oldestRetainedRevision: this.checkpointRevision,
      retainedRevisionCount: this.revision - this.checkpointRevision,
      instanceCount: this.state.size,
      activeLeaseCount: this.countActiveLeases(),
      openPageCursors: this.pageCursors.size,
      openSubscriptions: this.subscriptions.size,
      cursorHistoryRecords: this.closedCursors.size,
      closed: this.closed,
    };
  }

  /** Query the current state, ordered by name. */
  query(options: QueryOptions = {}): QueryResult {
    this.assertOpen();
    const prefix = normalizePrefix(options.prefix);
    const items: InstanceView[] = [];
    for (const instance of this.state.values()) {
      if (prefix === '' || instance.name.startsWith(prefix)) {
        items.push(instance);
      }
    }
    items.sort((a, b) => compareNames(a.name, b.name));
    return { revision: this.revision, items };
  }

  /** Snapshot at a specific retained revision. */
  snapshotAt(revision: Revision): QueryResult {
    this.assertOpen();
    assertRevision(revision, 'revision');
    if (revision > this.revision) {
      throw new InvalidArgumentError(
        `revision ${revision} is in the future (current ${this.revision})`,
      );
    }
    const state = this.stateAt(revision);
    return { revision, items: sortInstances(state.values()) };
  }

  get(name: string): InstanceView | null {
    this.assertOpen();
    assertNonEmptyString(name, 'name');
    return this.state.get(name) ?? null;
  }

  /* --------------------------------------------------------------- sessions */

  /**
   * Open a session lease. Re-opening the same sessionId starts a new
   * generation, which takes over names registered by the previous generation.
   */
  openSession(options: SessionOpenOptions = {}): Session {
    this.assertOpen();
    const now = this.clock.now();
    const sessionId =
      options.sessionId === undefined
        ? defaultIdFactory('session')
        : assertNonEmptyString(options.sessionId, 'sessionId');
    const ttlMs = assertPositiveInt(options.ttlMs, 'ttlMs', this.defaultLeaseTtlMs);
    const generation = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, generation);

    const record: LeaseRecord = {
      leaseId: this.idFactory('lease'),
      sessionId,
      sessionGeneration: generation,
      createdAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      closed: false,
      closedReason: null,
      entries: new Map(),
    };
    this.leases.set(record.leaseId, record);
    return new Session(this, record.leaseId, sessionId, generation, record.expiresAt, ttlMs);
  }

  getLease(leaseId: string): LeaseView | null {
    this.assertOpen();
    assertNonEmptyString(leaseId, 'leaseId');
    const record = this.leases.get(leaseId);
    return record === undefined ? null : this.leaseView(record);
  }

  /** Renew a lease. Late renewals only refresh the lease that owns them. */
  renewSession(handle: LeaseHandle, options: { ttlMs?: number } = {}): LeaseView {
    this.assertOpen();
    const now = this.clock.now();
    const record = this.resolveLease(handle);
    if (record.closed) {
      throw new LeaseExpiredError(record.leaseId, record.sessionId, `lease was closed (${record.closedReason})`);
    }
    if (now >= record.expiresAt) {
      throw new LeaseExpiredError(record.leaseId, record.sessionId, 'lease lifetime elapsed before sweep');
    }
    const ttlMs = assertPositiveInt(options.ttlMs, 'ttlMs', record.ttlMs);
    record.ttlMs = ttlMs;
    record.expiresAt = now + ttlMs;
    return this.leaseView(record);
  }

  /** Batch-register instances under a session lease generation. */
  register(handle: LeaseHandle, inputs: readonly InstanceInput[]): RegisterResult {
    this.assertOpen();
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new InvalidArgumentError('register requires a non-empty batch');
    }
    const record = this.resolveActiveLease(handle);
    const normalized = inputs.map((input) => normalizeInput(input));
    const seen = new Set<string>();
    for (const item of normalized) {
      if (seen.has(item.name)) {
        throw new InvalidArgumentError(`duplicate instance name "${item.name}" within one batch`);
      }
      seen.add(item.name);
    }

    const revision = this.revision + 1;
    const changes: Change[] = [];
    for (const item of normalized) {
      const previous = this.state.get(item.name) ?? null;
      const generation = (this.nameGenerations.get(item.name) ?? 0) + 1;
      this.nameGenerations.set(item.name, generation);
      const instance = this.makeInstance(item, record, generation, revision);
      const reason: PutChange['reason'] =
        previous === null
          ? 'register'
          : previous.sessionId === record.sessionId &&
              previous.sessionGeneration === record.sessionGeneration
            ? 'replace'
            : 'takeover';
      record.entries.set(item.name, generation);
      changes.push({ type: 'put', name: item.name, instance, supersedes: previous, reason });
    }

    this.commit(revision, changes);
    return { revision, changes };
  }

  /** Batch-remove instances owned by this exact lease generation. */
  unregister(handle: LeaseHandle, names: readonly string[]): UnregisterResult {
    this.assertOpen();
    if (!Array.isArray(names) || names.length === 0) {
      throw new InvalidArgumentError('unregister requires a non-empty batch of names');
    }
    const record = this.resolveActiveLease(handle);
    const seen = new Set<string>();
    for (const name of names) {
      assertNonEmptyString(name, 'instance name');
      if (seen.has(name)) {
        throw new InvalidArgumentError(`duplicate instance name "${name}" within one batch`);
      }
      seen.add(name);
    }

    const deleted: DeleteChange[] = [];
    const stale: UnregisterResult['stale'] = [];
    const missing: string[] = [];
    for (const name of names) {
      const current = this.state.get(name);
      if (current === undefined) {
        missing.push(name);
        continue;
      }
      if (!this.ownedBy(current, record)) {
        stale.push({ name, current, requestedBy: this.handleOf(record) });
        continue;
      }
      deleted.push({ type: 'delete', name, previous: current, reason: 'release' });
      record.entries.delete(name);
    }

    if (deleted.length === 0) {
      return { revision: this.revision, deleted: [], stale, missing };
    }
    const revision = this.revision + 1;
    this.commit(revision, deleted);
    return { revision, deleted, stale, missing };
  }

  /** Close a session lease and release every instance it still owns. */
  closeSession(handle: LeaseHandle): CloseLeaseResult {
    this.assertOpen();
    const record = this.resolveLease(handle);
    if (record.closed) {
      return { revision: this.revision, deleted: [], alreadyClosed: true };
    }
    const deleted = this.deletionsForLease(record);
    record.closed = true;
    record.closedReason = 'caller';
    record.entries.clear();
    if (deleted.length === 0) {
      return { revision: this.revision, deleted: [], alreadyClosed: false };
    }
    const revision = this.revision + 1;
    this.commit(revision, deleted);
    return { revision, deleted, alreadyClosed: false };
  }

  /* -------------------------------------------------------------- pagination */

  /** Open a pagination snapshot. The snapshot revision is fixed for all pages. */
  openPage(options: PageOptions = {}): Page {
    this.assertOpen();
    const now = this.clock.now();
    const prefix = normalizePrefix(options.prefix);
    const pageSize = normalizePageSize(
      options.pageSize,
      this.defaultPageSize,
      this.maxPageSize,
    );
    const revision = options.atRevision === undefined ? this.revision : options.atRevision;
    assertRevision(revision, 'atRevision');
    if (revision > this.revision) {
      throw new InvalidArgumentError(
        `atRevision ${revision} is in the future (current ${this.revision})`,
      );
    }
    if (revision < this.checkpointRevision) {
      throw new SnapshotUnavailableError(revision, this.checkpointRevision, this.revision);
    }
    this.enforcePageCursorCapacity(now);

    const cursor: PageCursorRecord = {
      cursorId: this.idFactory('page'),
      revision,
      prefix,
      pageSize,
      createdAt: now,
      expiresAt: this.pageCursorTtlMs === 0 ? Infinity : now + this.pageCursorTtlMs,
      lastAccessAt: now,
    };
    this.pageCursors.set(cursor.cursorId, cursor);
    const names = this.matchingNamesAt(revision, prefix);
    return this.buildPage(cursor, names, 0, null);
  }

  /** Continue a pagination snapshot from a token. */
  nextPage(token: string, options: { pageSize?: number } = {}): Page {
    this.assertOpen();
    const now = this.clock.now();
    const payload = this.codec.decode(token);
    if (payload.d !== this.id) {
      throw new SnapshotUnavailableError(payload.r, this.checkpointRevision, this.revision);
    }
    const cursor = this.pageCursors.get(payload.c);
    if (cursor === undefined) {
      this.throwClosedPageCursor(payload.c);
      throw new InvalidArgumentError('unreachable');
    }
    if (now >= cursor.expiresAt) {
      const info = this.expirePageCursor(cursor, 'ttl-expired', now);
      throw new CursorExpiredError(info);
    }
    if (payload.r !== cursor.revision || payload.p !== cursor.prefix) {
      throw new InvalidArgumentError('token does not match the cursor snapshot');
    }
    if (cursor.revision < this.checkpointRevision) {
      const info = this.expirePageCursor(cursor, 'history-compacted', now);
      throw new CursorExpiredError(info);
    }
    const pageSize = normalizePageSize(options.pageSize, cursor.pageSize, this.maxPageSize);
    cursor.pageSize = pageSize;
    cursor.lastAccessAt = now;
    const names = this.matchingNamesAt(cursor.revision, cursor.prefix);
    if (payload.o > names.length) {
      throw new InvalidArgumentError(
        `token offset ${payload.o} exceeds snapshot size ${names.length}`,
      );
    }
    return this.buildPage(cursor, names, payload.o, token);
  }

  /** Explicitly close a page cursor, releasing its retention pin. */
  closePage(cursorId: string): CursorCloseResult {
    this.assertOpen();
    assertNonEmptyString(cursorId, 'cursorId');
    const cursor = this.pageCursors.get(cursorId);
    if (cursor === undefined) {
      const record = this.closedCursors.get(cursorId);
      return {
        cursorId,
        releasedRevision: record === undefined ? this.revision : record.revision,
        currentRevision: this.revision,
        alreadyClosed: true,
        closedReason: record === undefined ? null : record.reason,
      };
    }
    const releasedRevision = cursor.revision;
    this.closePageCursor(cursor, 'caller-closed', false);
    if (this.autoCompact) {
      this.compactInternal(this.retainRevisions);
    }
    return {
      cursorId,
      releasedRevision,
      currentRevision: this.revision,
      alreadyClosed: false,
      closedReason: 'caller-closed',
    };
  }

  /* ----------------------------------------------------------- subscriptions */

  /**
   * Open a change subscription. Without `sinceRevision` it starts after the
   * current revision; with it, it replays strictly after that revision and
   * fails with CursorExpiredError if that history is gone.
   */
  openSubscription(options: SubscriptionOptions = {}): Subscription {
    this.assertOpen();
    const now = this.clock.now();
    const prefix = normalizePrefix(options.prefix);
    const explicitSince = options.sinceRevision !== undefined;
    const sinceRevision = explicitSince
      ? (assertRevision(options.sinceRevision, 'sinceRevision') as Revision)
      : this.revision;
    if (sinceRevision > this.revision) {
      throw new InvalidArgumentError(
        `sinceRevision ${sinceRevision} is in the future (current ${this.revision})`,
      );
    }
    const maxBacklogChanges = assertPositiveInt(
      options.maxBacklogChanges,
      'maxBacklogChanges',
      this.defaultMaxBacklogChanges,
    );
    const maxBacklogBatches = assertNonNegativeInt(
      options.maxBacklogBatches,
      'maxBacklogBatches',
      0,
    );

    if (sinceRevision < this.checkpointRevision) {
      const cursorId = this.idFactory('subscription');
      const message =
        `cannot resume after revision ${sinceRevision}: only revisions ` +
        `${this.checkpointRevision}..${this.revision} are replayable`;
      const rebuild: RebuildInfo = {
        cursorId,
        reason: 'history-compacted',
        lastDeliveredRevision: sinceRevision,
        sinceRevision: this.revision,
        currentRevision: this.revision,
        message,
      };
      throw new CursorExpiredError({
        kind: 'subscription',
        cursorId,
        prefix,
        reason: 'history-compacted',
        oldestRetainedRevision: this.checkpointRevision,
        currentRevision: this.revision,
        message,
        rebuild,
      });
    }

    this.enforceSubscriptionCapacity(now);

    const sub = new SubscriptionImpl({
      cursorId: this.idFactory('subscription'),
      prefix,
      position: sinceRevision,
      createdAt: now,
      expiresAt: this.subscriptionTtlMs === 0 ? Infinity : now + this.subscriptionTtlMs,
      maxBacklogChanges,
      maxBacklogBatches,
      epoch: {
        subscriptionId: '',
        sinceRevision,
        resumed: explicitSince,
        resumedFrom: options.resumedFrom ?? null,
      },
    });
    sub.epoch = Object.freeze({ ...sub.epoch, subscriptionId: sub.cursorId });
    this.subscriptions.set(sub.cursorId, sub);
    return sub;
  }

  /** Poll a subscription by id (the Subscription object exposes the same). */
  pollSubscription(cursorId: string, limit: PollLimit = {}): PollResult {
    this.assertOpen();
    const sub = this.subscriptions.get(cursorId);
    if (sub === undefined) {
      const record = this.closedCursors.get(cursorId);
      if (record !== undefined) {
        return this.closedPollResult(cursorId, record.revision, record);
      }
      throw new InvalidArgumentError(`subscription ${cursorId} is unknown`);
    }
    return this.pollSubject(sub, limit);
  }

  /** Close a subscription explicitly, releasing its retention pin. */
  closeSubscription(cursorId: string): CursorCloseResult {
    this.assertOpen();
    assertNonEmptyString(cursorId, 'cursorId');
    const sub = this.subscriptions.get(cursorId);
    if (sub === undefined) {
      const record = this.closedCursors.get(cursorId);
      return {
        cursorId,
        releasedRevision: record === undefined ? this.revision : record.revision,
        currentRevision: this.revision,
        alreadyClosed: true,
        closedReason: record === undefined ? null : record.reason,
      };
    }
    const released = sub.position;
    this.closeSubscriptionInternal(sub, 'caller-closed', false);
    if (this.autoCompact) {
      this.compactInternal(this.retainRevisions);
    }
    return {
      cursorId,
      releasedRevision: released,
      currentRevision: this.revision,
      alreadyClosed: false,
      closedReason: 'caller-closed',
    };
  }

  /* -------------------------------------------------------------- compaction */

  /** Advance the checkpoint, dropping history no live cursor still needs. */
  compact(options: { retainRevisions?: number } = {}): CompactionResult {
    this.assertOpen();
    return this.compactInternal(
      options.retainRevisions === undefined
        ? this.retainRevisions
        : assertNonNegativeInt(options.retainRevisions, 'retainRevisions', this.retainRevisions),
    );
  }

  /** Expire leases and cursors whose lifetime has elapsed. */
  sweep(): SweepResult {
    this.assertOpen();
    const now = this.clock.now();
    const expiredLeases: string[] = [];
    const expiredDeletes: DeleteChange[] = [];
    for (const record of this.leases.values()) {
      if (record.closed || now < record.expiresAt) {
        continue;
      }
      const deleted = this.deletionsForLease(record);
      record.closed = true;
      record.closedReason = 'expired';
      record.entries.clear();
      expiredLeases.push(record.leaseId);
      expiredDeletes.push(...deleted);
    }

    const expiredPageCursors: string[] = [];
    for (const cursor of Array.from(this.pageCursors.values())) {
      if (now >= cursor.expiresAt) {
        this.expirePageCursor(cursor, 'ttl-expired', now);
        expiredPageCursors.push(cursor.cursorId);
      }
    }
    const expiredSubscriptions: string[] = [];
    for (const sub of Array.from(this.subscriptions.values())) {
      if (now >= sub.expiresAt) {
        this.expireSubscription(sub, 'ttl-expired');
        expiredSubscriptions.push(sub.cursorId);
      }
    }

    let revision = this.revision;
    if (expiredDeletes.length > 0) {
      revision = this.revision + 1;
      this.commit(revision, expiredDeletes);
    } else if (this.autoCompact) {
      this.compactInternal(this.retainRevisions);
    }
    return {
      revision,
      expiredLeases,
      expiredDeletes,
      expiredSubscriptions,
      expiredPageCursors,
    };
  }

  /** Close the directory, dropping all cursors and releasing history. */
  close(): void {
    if (this.closed) {
      return;
    }
    const now = this.clock.now();
    for (const sub of Array.from(this.subscriptions.values())) {
      this.closeSubscriptionInternal(sub, 'directory-closed', false, now);
    }
    for (const cursor of Array.from(this.pageCursors.values())) {
      this.closePageCursor(cursor, 'directory-closed', false);
    }
    for (const record of this.leases.values()) {
      if (!record.closed) {
        record.closed = true;
        record.closedReason = 'expired';
      }
    }
    this.closed = true;
    this.checkpointRevision = this.revision;
    this.checkpointState = new Map(this.state);
    this.batches.clear();
  }

  /* ------------------------------------------------------------------- hooks */

  /** @internal Used by Session convenience methods. */
  registerFor(handle: LeaseHandle, inputs: readonly InstanceInput[]): RegisterResult {
    return this.register(handle, inputs);
  }

  /** @internal */
  unregisterFor(handle: LeaseHandle, names: readonly string[]): UnregisterResult {
    return this.unregister(handle, names);
  }

  /** @internal */
  renewFor(handle: LeaseHandle, ttlMs?: number): LeaseView {
    return this.renewSession(handle, { ttlMs });
  }

  /** @internal */
  closeFor(handle: LeaseHandle): CloseLeaseResult {
    return this.closeSession(handle);
  }

  /** @internal */
  leaseViewFor(leaseId: string): LeaseView | null {
    return this.getLease(leaseId);
  }

  /* ---------------------------------------------------------------- internal */

  private assertOpen(): void {
    if (this.closed) {
      throw new DirectoryClosedError();
    }
  }

  private makeInstance(
    input: ReturnType<typeof normalizeInput>,
    lease: LeaseRecord,
    generation: number,
    revision: Revision,
  ): InstanceView {
    const instance: InstanceView = {
      name: input.name,
      address: input.address,
      weight: input.weight,
      metadata: input.metadata,
      sessionId: lease.sessionId,
      sessionGeneration: lease.sessionGeneration,
      generation,
      leaseId: lease.leaseId,
      registeredRevision: revision,
    };
    return Object.freeze(instance);
  }

  private handleOf(record: LeaseRecord): LeaseHandle {
    return {
      leaseId: record.leaseId,
      sessionId: record.sessionId,
      sessionGeneration: record.sessionGeneration,
    };
  }

  private ownedBy(instance: InstanceView, record: LeaseRecord): boolean {
    return (
      instance.leaseId === record.leaseId &&
      instance.sessionId === record.sessionId &&
      instance.sessionGeneration === record.sessionGeneration
    );
  }

  private resolveLease(handle: LeaseHandle): LeaseRecord {
    if (typeof handle !== 'object' || handle === null) {
      throw new InvalidArgumentError('lease handle must be an object');
    }
    assertNonEmptyString(handle.leaseId, 'leaseId');
    const record = this.leases.get(handle.leaseId);
    if (record === undefined) {
      throw new LeaseNotFoundError(handle.leaseId);
    }
    if (
      record.sessionId !== handle.sessionId ||
      record.sessionGeneration !== handle.sessionGeneration
    ) {
      throw new LeaseSessionMismatchError(
        record.leaseId,
        `lease ${record.leaseId} belongs to session ${record.sessionId}` +
          `/gen${record.sessionGeneration}, not ${handle.sessionId}/gen${handle.sessionGeneration}`,
      );
    }
    return record;
  }

  private resolveActiveLease(handle: LeaseHandle): LeaseRecord {
    const record = this.resolveLease(handle);
    const now = this.clock.now();
    if (record.closed) {
      throw new LeaseExpiredError(record.leaseId, record.sessionId, `lease was closed (${record.closedReason})`);
    }
    if (now >= record.expiresAt) {
      throw new LeaseExpiredError(record.leaseId, record.sessionId, 'lease lifetime elapsed before sweep');
    }
    return record;
  }

  private deletionsForLease(record: LeaseRecord): DeleteChange[] {
    const deleted: DeleteChange[] = [];
    for (const [name, generation] of record.entries) {
      const current = this.state.get(name);
      if (
        current !== undefined &&
        current.generation === generation &&
        this.ownedBy(current, record)
      ) {
        deleted.push({ type: 'delete', name, previous: current, reason: 'expired' });
      }
    }
    return deleted;
  }

  private leaseView(record: LeaseRecord): LeaseView {
    const entries = Array.from(record.entries, ([name, generation]) => {
      const current = this.state.get(name);
      return {
        name,
        generation,
        current:
          current !== undefined && current.generation === generation && this.ownedBy(current, record),
      };
    });
    entries.sort((a, b) => compareNames(a.name, b.name));
    return Object.freeze({
      leaseId: record.leaseId,
      sessionId: record.sessionId,
      sessionGeneration: record.sessionGeneration,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ttlMs: record.ttlMs,
      closed: record.closed,
      closedReason: record.closedReason,
      entries: Object.freeze(entries),
    });
  }

  private countActiveLeases(): number {
    let count = 0;
    for (const record of this.leases.values()) {
      if (!record.closed && this.clock.now() < record.expiresAt) {
        count += 1;
      }
    }
    return count;
  }

  /* -------------------------------------------------------------- snapshots */

  private stateAt(revision: Revision): Map<string, InstanceView> {
    if (revision < this.checkpointRevision) {
      throw new SnapshotUnavailableError(revision, this.checkpointRevision, this.revision);
    }
    if (revision > this.revision) {
      throw new InvalidArgumentError(
        `revision ${revision} is in the future (current ${this.revision})`,
      );
    }
    const state = new Map(this.checkpointState);
    for (let r = this.checkpointRevision + 1; r <= revision; r += 1) {
      const batch = this.batches.get(r);
      if (batch === undefined) {
        throw new Error(`internal invariant: missing history for revision ${r}`);
      }
      applyChanges(state, batch.changes);
    }
    return state;
  }

  private matchingNamesAt(revision: Revision, prefix: string): InstanceView[] {
    const state = this.stateAt(revision);
    const items: InstanceView[] = [];
    for (const instance of state.values()) {
      if (prefix === '' || instance.name.startsWith(prefix)) {
        items.push(instance);
      }
    }
    items.sort((a, b) => compareNames(a.name, b.name));
    return items;
  }

  private buildPage(
    cursor: PageCursorRecord,
    names: InstanceView[],
    offset: number,
    token: string | null,
  ): Page {
    const end = Math.min(offset + cursor.pageSize, names.length);
    const items = names.slice(offset, end);
    const done = end >= names.length;
    let nextToken: string | null = null;
    if (!done) {
      nextToken = this.codec.encode({
        d: this.id,
        c: cursor.cursorId,
        r: cursor.revision,
        o: end,
        p: cursor.prefix,
      });
    }
    const page: Page = {
      cursorId: cursor.cursorId,
      token,
      revision: cursor.revision,
      items: Object.freeze(items.slice()),
      nextToken,
      pageNumber: cursor.pageSize === 0 ? 1 : Math.floor(offset / cursor.pageSize) + 1,
      done,
    };
    if (done) {
      // Reaching the last page releases the snapshot; the caller already has
      // every item and there is no token left to replay.
      this.closePageCursor(cursor, 'completed', false);
    }
    return Object.freeze(page);
  }

  private enforcePageCursorCapacity(now: number): void {
    for (const cursor of Array.from(this.pageCursors.values())) {
      if (now >= cursor.expiresAt) {
        this.expirePageCursor(cursor, 'ttl-expired', now);
      }
    }
    while (this.pageCursors.size >= this.maxPageCursors) {
      let oldest: PageCursorRecord | null = null;
      for (const cursor of this.pageCursors.values()) {
        if (oldest === null || cursor.lastAccessAt < oldest.lastAccessAt) {
          oldest = cursor;
        }
      }
      if (oldest === null) {
        break;
      }
      this.expirePageCursor(oldest, 'capacity-evicted', now);
    }
  }

  private expirePageCursor(
    cursor: PageCursorRecord,
    reason: CursorExpiryReason,
    now: number,
  ): CursorExpiredInfo {
    const message =
      reason === 'history-compacted'
        ? `page snapshot at revision ${cursor.revision} was compacted away`
        : `page cursor ${cursor.cursorId} expired (${reason})`;
    const info = this.cursorExpiredInfo('page', cursor.cursorId, cursor.prefix, cursor.revision, reason, message);
    this.closePageCursor(cursor, reason === 'history-compacted' ? 'history-compacted' : reason === 'capacity-evicted' ? 'capacity-evicted' : 'ttl-expired', true, info, now);
    return info;
  }

  private closePageCursor(
    cursor: PageCursorRecord,
    reason: CursorCloseReason,
    abnormal: boolean,
    info: CursorExpiredInfo | null = null,
    now = this.clock.now(),
  ): void {
    this.pageCursors.delete(cursor.cursorId);
    this.recordClosedCursor({
      cursorId: cursor.cursorId,
      kind: 'page',
      reason,
      revision: cursor.revision,
      prefix: cursor.prefix,
      closedAt: now,
      abnormal,
      expired: info,
    });
  }

  private throwClosedPageCursor(cursorId: string): never {
    const record = this.closedCursors.get(cursorId);
    if (record === undefined) {
      throw new InvalidArgumentError(`page cursor ${cursorId} is unknown`);
    }
    if (record.expired !== null) {
      throw new CursorExpiredError(record.expired);
    }
    throw new CursorClosedError({
      kind: 'page',
      cursorId,
      prefix: record.prefix,
      reason: 'ttl-expired',
      oldestRetainedRevision: this.checkpointRevision,
      currentRevision: this.revision,
      message: `page cursor ${cursorId} is closed (${record.reason})`,
      rebuild: {
        cursorId,
        reason: 'caller-closed',
        lastDeliveredRevision: record.revision,
        sinceRevision: this.revision,
        currentRevision: this.revision,
        message: `page cursor ${cursorId} is closed (${record.reason})`,
      },
    });
  }

  /* ----------------------------------------------------------- subscriptions */

  private enforceSubscriptionCapacity(now: number): void {
    for (const sub of Array.from(this.subscriptions.values())) {
      if (now >= sub.expiresAt) {
        this.expireSubscription(sub, 'ttl-expired');
      }
    }
    while (this.subscriptions.size >= this.maxSubscriptions) {
      let oldest: SubscriptionImpl | null = null;
      for (const sub of this.subscriptions.values()) {
        if (oldest === null || sub.createdAt < oldest.createdAt) {
          oldest = sub;
        }
      }
      if (oldest === null) {
        break;
      }
      this.expireSubscription(oldest, 'capacity-evicted');
    }
  }

  private pollSubject(sub: SubscriptionImpl, limit: PollLimit): PollResult {
    this.assertOpen();
    const now = this.clock.now();
    if (sub.closed) {
      return this.closedPollResult(sub.cursorId, sub.position, sub.closedRecord);
    }
    if (now >= sub.expiresAt) {
      const info = this.expireSubscription(sub, 'ttl-expired');
      return this.closedPollResult(sub.cursorId, sub.position, sub.closedRecord, info);
    }
    if (sub.position < this.checkpointRevision) {
      const info = this.expireSubscription(sub, 'history-compacted');
      return this.closedPollResult(sub.cursorId, sub.position, sub.closedRecord, info);
    }

    const maxBatches = assertPositiveInt(limit.maxBatches, 'maxBatches', 1000);
    const maxChanges = assertPositiveInt(limit.maxChanges, 'maxChanges', 10000);

    const batches: RevisionBatch[] = [];
    let position = sub.position;
    let deliveredChanges = 0;
    for (let r = position + 1; r <= this.revision; r += 1) {
      const batch = this.batches.get(r);
      if (batch === undefined) {
        throw new Error(`internal invariant: missing history for revision ${r}`);
      }
      const matching = filterChanges(batch.changes, sub.prefix);
      if (matching.length === 0) {
        position = r;
        continue;
      }
      if (batches.length > 0 && (batches.length >= maxBatches || deliveredChanges + matching.length > maxChanges)) {
        break;
      }
      batches.push(Object.freeze({ revision: r, changes: Object.freeze(matching) }));
      deliveredChanges += matching.length;
      position = r;
      sub.pendingChanges -= matching.length;
      sub.pendingBatches -= 1;
    }
    if (sub.pendingChanges < 0) {
      sub.pendingChanges = 0;
    }
    if (sub.pendingBatches < 0) {
      sub.pendingBatches = 0;
    }
    sub.position = position;
    sub.lastPollAt = now;
    return Object.freeze({
      cursorId: sub.cursorId,
      active: true,
      batches: Object.freeze(batches),
      position,
      closed: false,
      closedReason: null,
      expired: null,
      rebuild: null,
    });
  }

  private closedPollResult(
    cursorId: string,
    position: Revision,
    record: ClosedCursorRecord | null,
    info: CursorExpiredInfo | null = null,
  ): PollResult {
    const expired = info ?? record?.expired ?? null;
    const reason: SubscriptionCloseReason | null =
      info !== null
        ? reasonFromExpiry(info.reason)
        : record !== null
          ? (record.reason as SubscriptionCloseReason)
          : null;
    return Object.freeze({
      cursorId,
      active: false,
      batches: Object.freeze([]) as readonly RevisionBatch[],
      position,
      closed: true,
      closedReason: reason,
      expired,
      rebuild: expired === null ? null : expired.rebuild,
    });
  }

  private expireSubscription(
    sub: SubscriptionImpl,
    reason: CursorExpiryReason,
  ): CursorExpiredInfo {
    const message =
      reason === 'history-compacted'
        ? `subscription ${sub.cursorId} at revision ${sub.position} lost its history`
        : `subscription ${sub.cursorId} expired (${reason})`;
    const info = this.cursorExpiredInfo(
      'subscription',
      sub.cursorId,
      sub.prefix,
      sub.position,
      reason,
      message,
    );
    const closeReason: SubscriptionCloseReason =
      reason === 'history-compacted'
        ? 'history-compacted'
        : reason === 'capacity-evicted'
          ? 'capacity-evicted'
          : 'ttl-expired';
    this.closeSubscriptionInternal(sub, closeReason, true, this.clock.now(), info);
    return info;
  }

  private closeSubscriptionInternal(
    sub: SubscriptionImpl,
    reason: SubscriptionCloseReason,
    abnormal: boolean,
    now = this.clock.now(),
    info: CursorExpiredInfo | null = null,
  ): void {
    if (sub.closed && reason !== 'directory-closed') {
      return;
    }
    sub.closed = true;
    sub.closedReason = reason;
    sub.closedRecord = {
      cursorId: sub.cursorId,
      kind: 'subscription',
      reason: reason as CursorCloseReason,
      revision: sub.position,
      prefix: sub.prefix,
      closedAt: now,
      abnormal,
      expired: info,
    };
    this.subscriptions.delete(sub.cursorId);
    this.recordClosedCursor(sub.closedRecord);
  }

  private cursorExpiredInfo(
    kind: 'page' | 'subscription',
    cursorId: string,
    prefix: string,
    cursorRevision: Revision,
    reason: CursorExpiryReason,
    message: string,
  ): CursorExpiredInfo {
    const rebuild: RebuildInfo = Object.freeze({
      cursorId,
      reason:
        reason === 'history-compacted'
          ? 'history-compacted'
          : reason === 'capacity-evicted'
            ? 'capacity-evicted'
            : 'ttl-expired',
      lastDeliveredRevision: cursorRevision,
      sinceRevision: this.revision,
      currentRevision: this.revision,
      message,
    });
    return Object.freeze({
      kind,
      cursorId,
      prefix,
      reason,
      oldestRetainedRevision: this.checkpointRevision,
      currentRevision: this.revision,
      message,
      rebuild,
    });
  }

  private recordClosedCursor(record: ClosedCursorRecord): void {
    this.closedCursors.set(record.cursorId, record);
    this.closedCursorOrder.push(record.cursorId);
    while (this.closedCursorOrder.length > CURSOR_HISTORY_LIMIT) {
      const oldest = this.closedCursorOrder.shift();
      if (oldest !== undefined) {
        this.closedCursors.delete(oldest);
      }
    }
  }

  /* --------------------------------------------------------------- commits */

  private commit(revision: Revision, changes: Change[]): void {
    for (const change of changes) {
      applyChange(this.state, change);
    }
    const frozenChanges = Object.freeze(changes.slice());
    const compiled: CompiledBatch = Object.freeze({
      revision,
      changes: frozenChanges,
      matches: (name: string) => {
        for (const change of frozenChanges) {
          if (change.name === name) {
            return true;
          }
        }
        return false;
      },
    });
    this.revision = revision;
    this.batches.set(revision, compiled);
    this.advanceSubscriptions(compiled);
    if (this.autoCompact) {
      this.compactInternal(this.retainRevisions);
    }
  }

  private advanceSubscriptions(batch: CompiledBatch): void {
    for (const sub of Array.from(this.subscriptions.values())) {
      const matching = filterChanges(batch.changes, sub.prefix);
      if (matching.length === 0) {
        continue;
      }
      sub.pendingChanges += matching.length;
      sub.pendingBatches += 1;
      const overflowed =
        sub.pendingChanges > sub.maxBacklogChanges ||
        (sub.maxBacklogBatches > 0 && sub.pendingBatches > sub.maxBacklogBatches);
      if (overflowed) {
        this.expireSubscription(sub, 'backlog-overflow' as never);
      }
    }
  }

  private compactInternal(retainRevisions: number): CompactionResult {
    const before = this.checkpointRevision;
    const retentionLimit = Math.max(0, this.revision - retainRevisions);
    let minPin = Infinity;
    for (const cursor of this.pageCursors.values()) {
      if (cursor.revision < minPin) {
        minPin = cursor.revision;
      }
    }
    for (const sub of this.subscriptions.values()) {
      if (sub.position < minPin) {
        minPin = sub.position;
      }
    }
    let target = Math.min(retentionLimit, minPin);
    let forced = false;
    if (this.revision - target > this.maxRetainedRevisions) {
      target = Math.max(0, this.revision - this.maxRetainedRevisions);
      forced = true;
    }
    target = Math.max(0, Math.min(target, this.revision));
    if (target <= before) {
      return {
        revision: this.revision,
        oldestRetainedRevision: before,
        droppedBatches: 0,
        expiredCursors: [],
      };
    }

    for (let r = before + 1; r <= target; r += 1) {
      const batch = this.batches.get(r);
      if (batch === undefined) {
        throw new Error(`internal invariant: missing history for revision ${r}`);
      }
      applyChanges(this.checkpointState, batch.changes);
      this.batches.delete(r);
    }
    this.checkpointRevision = target;

    const expiredCursors: string[] = [];
    const now = this.clock.now();
    for (const cursor of Array.from(this.pageCursors.values())) {
      if (cursor.revision < target) {
        this.expirePageCursor(cursor, 'history-compacted', now);
        expiredCursors.push(cursor.cursorId);
      }
    }
    for (const sub of Array.from(this.subscriptions.values())) {
      if (sub.position < target) {
        this.expireSubscription(sub, 'history-compacted');
        expiredCursors.push(sub.cursorId);
      }
    }
    if (forced && expiredCursors.length > 0) {
      // History cap overrides pins, so the eviction is intentionally loud.
      for (const cursorId of expiredCursors) {
        const record = this.closedCursors.get(cursorId);
        if (record !== undefined) {
          record.abnormal = true;
        }
      }
    }
    return {
      revision: this.revision,
      oldestRetainedRevision: target,
      droppedBatches: target - before,
      expiredCursors,
    };
  }

  /** Close leaked subscriptions on garbage collection boundaries is not needed; explicit closes are used. */
  shutdown(): void {
    this.close();
  }

  /** @internal */
  clockNow(): number {
    return this.clock.now();
  }

  /** @internal */
  rawStateSize(): number {
    return this.state.size;
  }
}

/* -------------------------------------------------------------------- session */

/** A caller-side session handle bound to one session generation. */
export class Session implements LeaseHandle {
  private readonly dir: RegistryDirectory;
  readonly leaseId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly expiresAt: number;
  readonly ttlMs: number;

  constructor(
    dir: RegistryDirectory,
    leaseId: string,
    sessionId: string,
    sessionGeneration: number,
    expiresAt: number,
    ttlMs: number,
  ) {
    this.dir = dir;
    this.leaseId = leaseId;
    this.sessionId = sessionId;
    this.sessionGeneration = sessionGeneration;
    this.expiresAt = expiresAt;
    this.ttlMs = ttlMs;
  }

  get generation(): number {
    return this.sessionGeneration;
  }

  register(inputs: readonly InstanceInput[]): RegisterResult {
    return this.dir.registerFor(this, inputs);
  }

  unregister(names: readonly string[]): UnregisterResult {
    return this.dir.unregisterFor(this, names);
  }

  renew(options: { ttlMs?: number } = {}): LeaseView {
    return this.dir.renewFor(this, options.ttlMs);
  }

  close(): CloseLeaseResult {
    return this.dir.closeFor(this);
  }

  view(): LeaseView | null {
    return this.dir.leaseViewFor(this.leaseId);
  }
}

/* --------------------------------------------------------------- subscription */

export class SubscriptionImpl implements Subscription {
  readonly cursorId: string;
  readonly prefix: string;
  epoch: SubscriptionEpoch;
  position: Revision;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly maxBacklogChanges: number;
  readonly maxBacklogBatches: number;
  pendingChanges = 0;
  pendingBatches = 0;
  lastPollAt: number;
  closed = false;
  closedReason: SubscriptionCloseReason | null = null;
  closedRecord: ClosedCursorRecord | null = null;
  private readonly dirRef: RegistryDirectory | null;

  constructor(init: {
    cursorId: string;
    prefix: string;
    position: Revision;
    createdAt: number;
    expiresAt: number;
    maxBacklogChanges: number;
    maxBacklogBatches: number;
    epoch: SubscriptionEpoch;
  }, dirRef: RegistryDirectory | null = null) {
    this.cursorId = init.cursorId;
    this.prefix = init.prefix;
    this.position = init.position;
    this.createdAt = init.createdAt;
    this.expiresAt = init.expiresAt;
    this.maxBacklogChanges = init.maxBacklogChanges;
    this.maxBacklogBatches = init.maxBacklogBatches;
    this.epoch = Object.freeze(init.epoch);
    this.lastPollAt = init.createdAt;
    this.dirRef = dirRef;
  }

  poll(limit: PollLimit = {}): PollResult {
    if (this.dirRef === null) {
      throw new Error('subscription is detached');
    }
    return this.dirRef.pollSubscription(this.cursorId, limit);
  }

  close(): CursorCloseResult {
    if (this.dirRef === null) {
      throw new Error('subscription is detached');
    }
    return this.dirRef.closeSubscription(this.cursorId);
  }
}

/* ------------------------------------------------------------------- helpers */

function applyChange(state: Map<string, InstanceView>, change: Change): void {
  if (change.type === 'put') {
    state.set(change.name, change.instance);
  } else {
    state.delete(change.name);
  }
}

function applyChanges(state: Map<string, InstanceView>, changes: readonly Change[]): void {
  for (const change of changes) {
    applyChange(state, change);
  }
}

function filterChanges(changes: readonly Change[], prefix: string): Change[] {
  if (prefix === '') {
    return changes.slice();
  }
  const matched: Change[] = [];
  for (const change of changes) {
    if (change.name.startsWith(prefix)) {
      matched.push(change);
    }
  }
  return matched;
}

function reasonFromExpiry(reason: CursorExpiryReason): SubscriptionCloseReason {
  if (reason === 'history-compacted') {
    return 'history-compacted';
  }
  if (reason === 'capacity-evicted') {
    return 'capacity-evicted';
  }
  return 'ttl-expired';
}
