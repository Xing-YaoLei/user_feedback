import { Emitter } from './emitter.ts';
import { SystemClock } from './clock.ts';
import {
  CursorExpiredError,
  GenerationConflictError,
  InvalidTokenError,
  RegistryClosedError,
  RegistryError,
  SessionExpiredError,
  type Clock,
  type EventRecord,
  type ExpiryReason,
  type Instance,
  type InstanceData,
  type KeyVersion,
  type ListOptions,
  type MutateResult,
  type Mutation,
  type PageResult,
  type RebuildBasis,
  type RegistryOptions,
  type RevisionRecord,
  type WatchEvent,
  type WatchMessage,
} from './types.ts';

interface SessionInternal {
  id: string;
  ttlMs: number;
  startedAt: number;
  expiresAt: number;
  dead: boolean;
  /** Keys this session currently owns (live registrations). */
  owned: Set<string>;
}

interface PageCursorInternal {
  id: number;
  revision: number;
  prefix: string;
  expiresAt: number;
  lastKey: string;
  finished: boolean;
  createdAt: number;
}

interface WatchInternal {
  id: number;
  prefix: string;
  /** First revision the watch wants to receive. */
  startRevision: number;
  ttlMs: number;
  expiresAt: number;
  queue: WatchMessage[];
  /** Number of revision records not yet acknowledged by the consumer. */
  backlog: number;
  /** Last revision accounted for (delivered or filtered through progress). */
  lastProgress: number;
  createdAt: number;
  stall: { reason: ExpiryReason; basis: RebuildBasis } | null;
}

interface EvictionTombstone {
  reason: ExpiryReason;
  at: number;
}

export interface CompactionResult {
  fromCompactedRevision: number;
  toCompactedRevision: number;
  removedRevisions: number;
  removedEvents: number;
  removedKeyVersions: number;
}

export interface RegistryStats {
  currentRevision: number;
  compactedRevision: number;
  retainedRevisions: number;
  retainedEvents: number;
  retainedBytes: number;
  livePageCursors: number;
  liveWatches: number;
  /** Oldest revision still pinned by a usable cursor, or null. */
  oldestPinnedRevision: number | null;
}

export interface RegistryEvents {
  commit: [RevisionRecord];
  compaction: [CompactionResult];
  sessionExpired: [{ sessionId: string; revision: number; keys: string[] }];
  sessionClosed: [{ sessionId: string; revision: number; keys: string[] }];
  cursorExpired: [
    { kind: 'page' | 'watch'; id: number; reason: ExpiryReason; basis: RebuildBasis },
  ];
}

interface TokenBody {
  v: 1;
  id: number;
  rev: number;
  pfx: string;
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function decodeBase64Url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/**
 * Embeddable service-discovery registry with etcd-style revision semantics.
 *
 * Concurrency model: Node is single-threaded and every public method runs to
 * completion synchronously, so a batch commit is atomic relative to all reads
 * and watch deliveries.
 */
export class Registry {
  readonly #clock: Clock;
  readonly #opts: Required<Omit<RegistryOptions, 'sweepIntervalMs'>> & { sweepIntervalMs: number };
  #closed = false;

  #currentRevision = 0;
  #compactedRevision = 0;
  /** Retained revision log; every record has revision > compactedRevision. */
  #log: RevisionRecord[] = [];
  /** Per-key MVCC version chains, sorted by revision ascending. */
  #keys = new Map<string, KeyVersion[]>();
  /**
   * Highest generation ever reached per key. Survives compaction even when the
   * tombstone version carrying that generation is pruned, so re-registration
   * after a compacted delete keeps the generation strictly monotonic.
   */
  #generationWatermark = new Map<string, number>();

  #sessions = new Map<string, SessionInternal>();
  #sessionSeq = 0;

  #pageCursors = new Map<number, PageCursorInternal>();
  #pageCursorSeq = 0;
  #evictedPageCursors = new Map<number, EvictionTombstone>();

  #watches = new Map<number, WatchInternal>();
  #watchSeq = 0;

  #sweepTimer: ReturnType<Clock['setTimeout']> | null = null;

  readonly #emitter = new Emitter<RegistryEvents>();

  constructor(options: RegistryOptions = {}, clock?: Clock) {
    this.#clock = clock ?? new SystemClock();
    this.#opts = {
      pageTtlMs: options.pageTtlMs ?? 30_000,
      maxPageCursors: options.maxPageCursors ?? 64,
      watchTtlMs: options.watchTtlMs ?? 60_000,
      maxWatches: options.maxWatches ?? 64,
      watchBacklogLimit: options.watchBacklogLimit ?? 128,
      maxRetainedRevisions: options.maxRetainedRevisions ?? Number.POSITIVE_INFINITY,
      sweepIntervalMs: options.sweepIntervalMs ?? 100,
    };
    this.#scheduleSweep();
  }

  // ---------------------------------------------------------------- events

  on<K extends keyof RegistryEvents>(event: K, fn: (...args: RegistryEvents[K]) => void): this {
    this.#emitter.on(event, fn);
    return this;
  }

  off<K extends keyof RegistryEvents>(event: K, fn: (...args: RegistryEvents[K]) => void): this {
    this.#emitter.off(event, fn);
    return this;
  }

  // ------------------------------------------------------------- lifecycle

  get currentRevision(): number {
    return this.#currentRevision;
  }

  get compactedRevision(): number {
    return this.#compactedRevision;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweepTimer) {
      this.#clock.clearTimeout(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#pageCursors.clear();
    this.#evictedPageCursors.clear();
    this.#watches.clear();
    this.#sessions.clear();
    this.#emitter.clear();
  }

  #checkOpen(): void {
    if (this.#closed) throw new RegistryClosedError();
  }

  // --------------------------------------------------------------- sessions

  createSession(options: { ttlMs: number; id?: string }): {
    sessionId: string;
    leaseExpiresAt: number;
  } {
    this.#checkOpen();
    if (!(options.ttlMs > 0)) throw new RegistryError('ttlMs must be positive');
    const id = options.id ?? `session-${++this.#sessionSeq}`;
    if (this.#sessions.has(id)) throw new RegistryError(`session ${id} already exists`);
    const now = this.#clock.now();
    this.#sessions.set(id, {
      id,
      ttlMs: options.ttlMs,
      startedAt: now,
      expiresAt: now + options.ttlMs,
      dead: false,
      owned: new Set(),
    });
    return { sessionId: id, leaseExpiresAt: now + options.ttlMs };
  }

  /**
   * Renew a session lease.
   *
   * With `key` + `generation` the call is fenced: a late keepalive from an old
   * session generation is rejected and the lease is NOT extended. Without a
   * key the whole session (and every instance it owns) is renewed.
   */
  keepAlive(
    sessionId: string,
    fence?: { key: string; generation: number },
  ): { leaseExpiresAt: number } {
    this.#checkOpen();
    const session = this.#requireLiveSession(sessionId);
    if (fence) {
      const live = this.#liveAt(fence.key, this.#currentRevision);
      if (!live || live.sessionId !== sessionId || live.generation !== fence.generation) {
        const actual = this.#currentGeneration(fence.key);
        throw new GenerationConflictError(fence.key, fence.generation, actual);
      }
    }
    const next = this.#clock.now() + session.ttlMs;
    session.expiresAt = next;
    const keys = fence ? [fence.key] : [...session.owned];
    for (const key of keys) {
      const live = this.#liveAt(key, this.#currentRevision);
      if (live && live.sessionId === sessionId) live.leaseExpiresAt = next;
    }
    return { leaseExpiresAt: next };
  }

  getSession(sessionId: string): { sessionId: string; expiresAt: number; keys: string[] } | null {
    const session = this.#sessions.get(sessionId);
    if (!session || session.dead) return null;
    return { sessionId, expiresAt: session.expiresAt, keys: [...session.owned] };
  }

  listSessions(): Array<{ sessionId: string; expiresAt: number; keys: string[] }> {
    return [...this.#sessions.values()]
      .filter((s) => !s.dead)
      .map((s) => ({ sessionId: s.id, expiresAt: s.expiresAt, keys: [...s.owned] }));
  }

  /** Deterministic expiry helper (the TTL sweeper calls the same logic). */
  expireSessionNow(sessionId: string): MutateResult | null {
    this.#checkOpen();
    const session = this.#sessions.get(sessionId);
    if (!session || session.dead) return null;
    return this.#terminateSession(session, true);
  }

  /** Explicitly release a session and delete everything it still owns. */
  closeSession(sessionId: string): MutateResult | null {
    this.#checkOpen();
    const session = this.#sessions.get(sessionId);
    if (!session || session.dead) return null;
    return this.#terminateSession(session, false);
  }

  #requireLiveSession(sessionId: string): SessionInternal {
    const session = this.#sessions.get(sessionId);
    if (!session || session.dead) throw new SessionExpiredError(sessionId);
    return session;
  }

  #terminateSession(session: SessionInternal, expired: boolean): MutateResult {
    session.dead = true;
    const mutations: Mutation[] = [];
    for (const key of [...session.owned]) {
      const live = this.#liveAt(key, this.#currentRevision);
      // A key taken over by a newer session is skipped.
      if (live && live.sessionId === session.id) {
        mutations.push({ type: 'delete', key, expectedGeneration: live.generation });
      }
    }
    const result = this.#applyBatch(mutations, { kind: 'session-termination', sessionId: session.id }, expired);
    this.#sessions.delete(session.id);
    this.#emitter.emit(expired ? 'sessionExpired' : 'sessionClosed', {
      sessionId: session.id,
      revision: result.revision,
      keys: result.events.map((e) => e.key),
    });
    return result;
  }

  // -------------------------------------------------------------- mutations

  /**
   * Apply one atomic batch. All mutations are validated before any change is
   * applied: either the whole batch gets one revision and becomes visible at
   * once, or nothing changes and an error is thrown.
   */
  mutate(sessionId: string, mutations: Mutation[]): MutateResult {
    this.#checkOpen();
    this.#requireLiveSession(sessionId);
    if (!Array.isArray(mutations) || mutations.length === 0) {
      throw new RegistryError('batch must contain at least one mutation');
    }
    return this.#applyBatch(mutations, { kind: 'client', sessionId }, false);
  }

  #applyBatch(
    mutations: Mutation[],
    origin: { kind: 'client' | 'session-termination'; sessionId: string },
    causedByExpiry: boolean,
  ): MutateResult {
    const now = this.#clock.now();
    const newRevision = this.#currentRevision + 1;

    // ---- Phase 1: validate everything against the current snapshot. ----
    const seenKeys = new Set<string>();
    const planned = mutations.map((m) => {
      if (typeof m.key !== 'string' || m.key.length === 0) {
        throw new RegistryError('mutation key must be a non-empty string');
      }
      if (seenKeys.has(m.key)) {
        throw new RegistryError(`batch contains multiple mutations for ${m.key}`);
      }
      seenKeys.add(m.key);
      const chain = this.#keys.get(m.key);
      const last = chain && chain.length > 0 ? chain[chain.length - 1]! : null;
      const live = last && !last.deleted ? last.instance : null;
      if (m.type === 'put') {
        const data: InstanceData = m.data ? { ...m.data } : {};
        const watermark = this.#generationWatermark.get(m.key) ?? 0;
        return { m, generation: Math.max((last?.generation ?? 0), watermark) + 1, live, data };
      }
      // delete
      if (typeof m.expectedGeneration !== 'number') {
        throw new RegistryError(`delete on ${m.key} requires expectedGeneration fencing token`);
      }
      const actualGeneration = Math.max(last?.generation ?? 0, this.#generationWatermark.get(m.key) ?? 0);
      if (!live || live.generation !== m.expectedGeneration) {
        throw new GenerationConflictError(m.key, m.expectedGeneration, actualGeneration);
      }
      // Every change, including a delete, advances the per-key generation so
      // re-registration after a (possibly compacted) tombstone never reuses it.
      return { m, generation: actualGeneration + 1, live, data: null };
    });

    // ---- Phase 2: apply; all events share one revision. ----
    const events: EventRecord[] = [];
    for (const item of planned) {
      const { m, generation } = item;
      const session = this.#sessions.get(origin.sessionId);
      if (m.type === 'put') {
        if (!session || session.dead) throw new SessionExpiredError(origin.sessionId);
        const instance: Instance = {
          key: m.key,
          data: item.data!,
          sessionId: origin.sessionId,
          generation,
          createRevision: newRevision,
          leaseExpiresAt: session.expiresAt,
        };
        // Transfer ownership away from any previous (possibly older) session.
        if (item.live && item.live.sessionId !== origin.sessionId) {
          this.#sessions.get(item.live.sessionId)?.owned.delete(m.key);
        }
        session.owned.add(m.key);
        this.#pushVersion(m.key, {
          revision: newRevision,
          deleted: false,
          instance,
          generation,
        });
        events.push({
          kind: 'put',
          key: m.key,
          instance,
          generation,
          sessionId: origin.sessionId,
        });
      } else {
        const ownerSession = item.live ? this.#sessions.get(item.live.sessionId) : undefined;
        ownerSession?.owned.delete(m.key);
        this.#pushVersion(m.key, {
          revision: newRevision,
          deleted: true,
          instance: null,
          generation,
        });
        events.push({
          kind: 'delete',
          key: m.key,
          instance: null,
          generation,
          sessionId: item.live?.sessionId ?? origin.sessionId,
        });
      }
    }

    const record: RevisionRecord = {
      revision: newRevision,
      timestamp: now,
      events,
      causedByExpiry,
    };
    this.#log.push(record);
    this.#currentRevision = newRevision;

    // Watches observe the commit before any compaction decision.
    this.#fanOut(record);
    this.#emitter.emit('commit', record);

    // Optional automatic retention bound.
    if (this.#log.length > this.#opts.maxRetainedRevisions) {
      this.compact(this.#currentRevision - this.#opts.maxRetainedRevisions);
    }

    return { revision: newRevision, events };
  }

  #pushVersion(key: string, version: KeyVersion): void {
    let chain = this.#keys.get(key);
    if (!chain) {
      chain = [];
      this.#keys.set(key, chain);
    }
    chain.push(version);
    const watermark = this.#generationWatermark.get(key) ?? 0;
    if (version.generation > watermark) this.#generationWatermark.set(key, version.generation);
  }

  // -------------------------------------------------------------- MVCC read

  /** Latest version of a key visible at `revision` (may be a tombstone). */
  #versionAt(key: string, revision: number): KeyVersion | null {
    const chain = this.#keys.get(key);
    if (!chain) return null;
    // Binary search for the rightmost version with version.revision <= revision.
    let lo = 0;
    let hi = chain.length - 1;
    let answer: KeyVersion | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = chain[mid]!;
      if (candidate.revision <= revision) {
        answer = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return answer;
  }

  #liveAt(key: string, revision: number): Instance | null {
    const version = this.#versionAt(key, revision);
    return version && !version.deleted ? version.instance : null;
  }

  #currentGeneration(key: string): number {
    const chain = this.#keys.get(key);
    const chainGeneration = chain && chain.length > 0 ? chain[chain.length - 1]!.generation : 0;
    return Math.max(chainGeneration, this.#generationWatermark.get(key) ?? 0);
  }

  /** Point read pinned to a revision. Revision 0 is the empty directory. */
  viewAt(key: string, revision: number): Instance | null {
    this.#checkOpen();
    this.#assertValidRevision(revision);
    if (revision === 0) return null;
    const version = this.#versionAt(key, revision);
    // When the revision is below the watermark its version chain was pruned;
    // report an explicit rebuild signal instead of silently returning null.
    if (!version && revision <= this.#compactedRevision) {
      throw new CursorExpiredError('page', 'compacted', this.#rebuildBasis('compacted'));
    }
    return version && !version.deleted ? version.instance : null;
  }

  #assertValidRevision(revision: number): void {
    if (revision < 0 || revision > this.#currentRevision) {
      throw new InvalidTokenError(
        `revision ${revision} is outside [0, ${this.#currentRevision}]`,
      );
    }
  }

  /** Materialize the sorted live key set of an immutable snapshot. */
  #snapshotKeys(revision: number, prefix: string): string[] {
    const out: string[] = [];
    for (const key of this.#keys.keys()) {
      if (!key.startsWith(prefix)) continue;
      const version = this.#versionAt(key, revision);
      if (version && !version.deleted) out.push(key);
    }
    out.sort();
    return out;
  }

  // ------------------------------------------------------------- pagination

  /**
   * Paged prefix read. The first page binds the read to the current revision;
   * every later page (via the opaque token) serves the same immutable snapshot.
   */
  list(options: ListOptions = {}): PageResult {
    this.#checkOpen();
    const prefix = options.prefix ?? '';
    const pageSize = options.pageSize ?? 100;
    if (!(pageSize > 0) || !Number.isInteger(pageSize)) {
      throw new RegistryError('pageSize must be a positive integer');
    }

    let cursor: PageCursorInternal;
    if (!options.pageToken) {
      while (this.#pageCursors.size >= this.#opts.maxPageCursors) {
        this.#evictOldestPageCursor('capacity');
      }
      const now = this.#clock.now();
      const id = ++this.#pageCursorSeq;
      cursor = {
        id,
        revision: this.#currentRevision,
        prefix,
        expiresAt: now + this.#opts.pageTtlMs,
        lastKey: '',
        finished: false,
        createdAt: now,
      };
      this.#pageCursors.set(id, cursor);
    } else {
      const body = this.#decodePageToken(options.pageToken);
      cursor = this.#pageCursors.get(body.id)!;
      if (!cursor) {
        const tombstone = this.#evictedPageCursors.get(body.id);
        const reason: ExpiryReason = tombstone?.reason ?? 'liveness';
        throw new CursorExpiredError('page', reason, this.#rebuildBasis(reason));
      }
      if (cursor.prefix !== prefix) {
        throw new InvalidTokenError('page token was issued for a different prefix');
      }
      if (cursor.revision <= this.#compactedRevision) {
        this.#expirePageCursor(cursor, 'compacted');
        throw new CursorExpiredError('page', 'compacted', this.#rebuildBasis('compacted'));
      }
      if (this.#clock.now() > cursor.expiresAt) {
        this.#expirePageCursor(cursor, 'liveness');
        throw new CursorExpiredError('page', 'liveness', this.#rebuildBasis('liveness'));
      }
      cursor.expiresAt = this.#clock.now() + this.#opts.pageTtlMs;
    }

    const keys = this.#snapshotKeys(cursor.revision, prefix);
    // The cursor only stores a key boundary, never an array index: keys
    // inserted or deleted after the first page cannot shift the boundary.
    const begin = cursor.lastKey === '' ? 0 : keys.findIndex((k) => k > cursor.lastKey);
    const start = begin === -1 ? keys.length : begin;
    const slice = keys.slice(start, start + pageSize);
    const instances = slice.map((k) => this.#liveAt(k, cursor.revision)!);

    let nextPageToken: string | null = null;
    if (slice.length === pageSize) {
      cursor.lastKey = slice[slice.length - 1]!;
      nextPageToken = this.#encodePageToken(cursor);
    } else {
      // Scan complete: release the cursor and its history pin immediately.
      cursor.finished = true;
      this.#pageCursors.delete(cursor.id);
    }
    return { instances, revision: cursor.revision, nextPageToken };
  }

  #encodePageToken(cursor: PageCursorInternal): string {
    const body: TokenBody = { v: 1, id: cursor.id, rev: cursor.revision, pfx: cursor.prefix };
    return encodeBase64Url(JSON.stringify(body));
  }

  #decodePageToken(token: string): TokenBody {
    let body: TokenBody;
    try {
      body = JSON.parse(decodeBase64Url(token)) as TokenBody;
    } catch {
      throw new InvalidTokenError('malformed page token');
    }
    if (!body || body.v !== 1 || typeof body.id !== 'number' || typeof body.rev !== 'number') {
      throw new InvalidTokenError('malformed page token');
    }
    return body;
  }

  #evictOldestPageCursor(reason: ExpiryReason): void {
    let oldest: PageCursorInternal | null = null;
    for (const cursor of this.#pageCursors.values()) {
      if (!oldest || cursor.createdAt < oldest.createdAt) oldest = cursor;
    }
    if (oldest) this.#expirePageCursor(oldest, reason);
  }

  #expirePageCursor(cursor: PageCursorInternal, reason: ExpiryReason): void {
    this.#pageCursors.delete(cursor.id);
    this.#rememberEviction(cursor.id, reason);
    this.#emitter.emit('cursorExpired', {
      kind: 'page',
      id: cursor.id,
      reason,
      basis: this.#rebuildBasis(reason),
    });
  }

  #rememberEviction(id: number, reason: ExpiryReason): void {
    this.#evictedPageCursors.set(id, { reason, at: this.#clock.now() });
    if (this.#evictedPageCursors.size > 1024) {
      const firstKey = this.#evictedPageCursors.keys().next().value;
      if (firstKey !== undefined) this.#evictedPageCursors.delete(firstKey);
    }
  }

  // ----------------------------------------------------------------- watches

  /**
   * Start (or resume) a watch. `startRevision` is the first revision to
   * receive; pass `progress + 1` from a previous watch to resume. Defaults to
   * changes strictly after the current revision.
   */
  watch(options: { prefix?: string; startRevision?: number; ttlMs?: number } = {}): WatchHandle {
    this.#checkOpen();
    const prefix = options.prefix ?? '';
    const startRevision = options.startRevision ?? this.#currentRevision + 1;
    if (startRevision < 1 || !Number.isInteger(startRevision)) {
      throw new InvalidTokenError('startRevision must be a positive integer');
    }
    if (startRevision > this.#currentRevision + 1) {
      throw new InvalidTokenError(
        `startRevision ${startRevision} is ahead of current revision ${this.#currentRevision}`,
      );
    }
    if (startRevision <= this.#compactedRevision) {
      throw new CursorExpiredError('watch', 'compacted', this.#rebuildBasis('compacted'));
    }

    while (this.#watches.size >= this.#opts.maxWatches) {
      this.#evictOldestWatch('capacity');
    }

    const now = this.#clock.now();
    const id = ++this.#watchSeq;
    const ttlMs = options.ttlMs ?? this.#opts.watchTtlMs;
    const watch: WatchInternal = {
      id,
      prefix,
      startRevision,
      ttlMs,
      expiresAt: now + ttlMs,
      queue: [],
      backlog: 0,
      lastProgress: startRevision - 1,
      createdAt: now,
      stall: null,
    };
    this.#watches.set(id, watch);

    // Replay retained history for a resume / late-start watcher.
    for (const record of this.#log) {
      if (record.revision < startRevision) continue;
      this.#deliverToWatch(watch, record, true);
      if (watch.stall) break;
    }
    return new WatchHandle(this, watch);
  }

  #fanOut(record: RevisionRecord): void {
    for (const watch of this.#watches.values()) {
      if (watch.stall) continue;
      if (record.revision < watch.startRevision) continue;
      this.#deliverToWatch(watch, record);
    }
  }

  #deliverToWatch(watch: WatchInternal, record: RevisionRecord, isReplay = false): void {
    if (watch.stall) return;
    // Every observed revision advances the resumable progress cursor, even
    // when prefix filtering removes every event in it.
    watch.lastProgress = record.revision;
    const matched: WatchEvent[] = [];
    for (const event of record.events) {
      if (!event.key.startsWith(watch.prefix)) continue;
      matched.push({
        kind: event.kind,
        key: event.key,
        instance: event.instance,
        generation: event.generation,
        revision: record.revision,
      });
    }
    if (matched.length > 0) {
      // Backlog is the number of buffered, not-yet-consumed messages.
      // Live fan-out evicts a watcher that keeps falling behind. Explicit
      // history replay (resume) is buffered directly: the client asked for
      // exactly that history and will drain it on the next consume().
      if (!isReplay) {
        watch.backlog += 1;
        if (watch.backlog > this.#opts.watchBacklogLimit) {
          this.#stallWatch(watch, 'backlog');
          return;
        }
      }
      watch.queue.push({ type: 'changes', revision: record.revision, events: matched });
      if (isReplay) watch.backlog = watch.queue.length;
    }
  }

  #stallWatch(watch: WatchInternal, reason: ExpiryReason): void {
    if (watch.stall) return;
    const basis = this.#rebuildBasis(reason);
    watch.stall = { reason, basis };
    watch.queue = [];
    watch.backlog = 0;
    // The watch no longer pins any history; the handle stays usable for the
    // single error read, but registry accounting releases it immediately.
    this.#watches.delete(watch.id);
    this.#emitter.emit('cursorExpired', { kind: 'watch', id: watch.id, reason, basis });
  }

  #evictOldestWatch(reason: ExpiryReason): void {
    let oldest: WatchInternal | null = null;
    for (const watch of this.#watches.values()) {
      if (watch.stall) continue;
      if (!oldest || watch.createdAt < oldest.createdAt) oldest = watch;
    }
    if (oldest) this.#stallWatch(oldest, reason);
  }

  #consumeWatch(watch: WatchInternal, maxMessages: number): WatchMessage[] {
    this.#checkOpen();
    if (watch.stall) {
      throw new CursorExpiredError('watch', watch.stall.reason, watch.stall.basis);
    }
    if (this.#clock.now() > watch.expiresAt) {
      this.#stallWatch(watch, 'liveness');
      throw new CursorExpiredError('watch', 'liveness', watch.stall!.basis);
    }
    watch.expiresAt = this.#clock.now() + watch.ttlMs;
    if (watch.queue.length === 0) {
      // No buffered change messages: the watcher is caught up to the
      // registry head. Filtered-only revisions are therefore confirmed here
      // even though they never produced a queued message.
      watch.lastProgress = Math.max(watch.lastProgress, this.#currentRevision);
      return [{ type: 'progress', progress: watch.lastProgress }];
    }
    const messages: WatchMessage[] = [];
    while (watch.queue.length > 0 && messages.length < maxMessages) {
      const message = watch.queue.shift()!;
      messages.push(message);
    }
    // Every buffered change message has now been acknowledged.
    watch.backlog = watch.queue.length;
    return messages;
  }

  #keepaliveWatch(watch: WatchInternal): number {
    this.#checkOpen();
    if (watch.stall) {
      throw new CursorExpiredError('watch', watch.stall.reason, watch.stall.basis);
    }
    watch.expiresAt = this.#clock.now() + watch.ttlMs;
    return watch.lastProgress;
  }

  #closeWatch(watch: WatchInternal): void {
    this.#watches.delete(watch.id);
  }

  #watchProgress(watch: WatchInternal): number {
    return watch.lastProgress;
  }

  #watchStall(watch: WatchInternal): { reason: ExpiryReason; basis: RebuildBasis } | null {
    return watch.stall ? { ...watch.stall } : null;
  }

  #watchId(watch: WatchInternal): number {
    return watch.id;
  }

  // -------------------------------------------------------------- compaction

  /**
   * Drop every revision up to and including `targetRevision`. The newest
   * version of each key (including a tombstone, which preserves the fencing
   * generation) is always retained so current-state reads remain available.
   * Cursors whose history disappears receive an explicit expiry/rebuild
   * signal (event now, thrown error on next use).
   */
  compact(targetRevision: number): CompactionResult {
    this.#checkOpen();
    const target = Math.max(0, Math.min(targetRevision, this.#currentRevision));
    if (target <= this.#compactedRevision) {
      return {
        fromCompactedRevision: this.#compactedRevision,
        toCompactedRevision: this.#compactedRevision,
        removedRevisions: 0,
        removedEvents: 0,
        removedKeyVersions: 0,
      };
    }
    const previousCompactedRevision = this.#compactedRevision;

    let removedEvents = 0;
    const retainedLog: RevisionRecord[] = [];
    for (const record of this.#log) {
      if (record.revision <= target) removedEvents += record.events.length;
      else retainedLog.push(record);
    }
    const removedRevisions = this.#log.length - retainedLog.length;
    this.#log = retainedLog;

    let removedKeyVersions = 0;
    for (const [key, chain] of this.#keys) {
      // Versions newer than the compaction target are always retained; find
      // the index of the first such version (the post-compaction chain head).
      let firstNewIdx = chain.length;
      while (firstNewIdx > 0 && chain[firstNewIdx - 1]!.revision > target) {
        firstNewIdx -= 1;
      }
      if (firstNewIdx === 0) continue; // nothing old to prune

      if (firstNewIdx < chain.length) {
        // Newer versions exist: keep them and drop every older version.
        removedKeyVersions += firstNewIdx;
        this.#keys.set(key, chain.slice(firstNewIdx));
        continue;
      }

      // All versions are at or below the target; the rightmost one is the
      // snapshot survivor. Tombstones are retained (not listed, point reads
      // return null) so a fully-compacted delete stays invisible while its
      // generation remains available for fencing.
      const survivor = chain[chain.length - 1]!;
      if (chain.length > 1) {
        removedKeyVersions += chain.length - 1;
        this.#keys.set(key, [survivor]);
      }
    }

    this.#compactedRevision = target;

    // Cursors that can no longer be served from retained history.
    for (const cursor of [...this.#pageCursors.values()]) {
      if (cursor.revision <= target) this.#expirePageCursor(cursor, 'compacted');
    }
    for (const watch of [...this.#watches.values()]) {
      if (!watch.stall && watch.startRevision <= target) this.#stallWatch(watch, 'compacted');
    }

    const result: CompactionResult = {
      fromCompactedRevision: previousCompactedRevision,
      toCompactedRevision: target,
      removedRevisions,
      removedEvents,
      removedKeyVersions,
    };
    this.#emitter.emit('compaction', result);
    return result;
  }

  // ------------------------------------------------------------------ stats

  stats(): RegistryStats {
    let retainedEvents = 0;
    for (const record of this.#log) retainedEvents += record.events.length;
    const retainedBytes = Buffer.byteLength(
      JSON.stringify({ log: this.#log, keys: [...this.#keys.entries()] }),
      'utf8',
    );
    let oldestPinnedRevision: number | null = null;
    const consider = (revision: number): void => {
      if (oldestPinnedRevision === null || revision < oldestPinnedRevision) {
        oldestPinnedRevision = revision;
      }
    };
    for (const cursor of this.#pageCursors.values()) consider(cursor.revision);
    for (const watch of this.#watches.values()) {
      if (!watch.stall) consider(watch.startRevision);
    }
    return {
      currentRevision: this.#currentRevision,
      compactedRevision: this.#compactedRevision,
      retainedRevisions: this.#log.length,
      retainedEvents,
      retainedBytes,
      livePageCursors: this.#pageCursors.size,
      liveWatches: this.#watches.size,
      oldestPinnedRevision,
    };
  }

  #rebuildBasis(reason: ExpiryReason): RebuildBasis {
    return {
      reason,
      snapshotRevision: this.#currentRevision,
      resumeAfterRevision: this.#currentRevision,
    };
  }

  // ------------------------------------------------------------------ sweep

  #scheduleSweep(): void {
    this.#sweepTimer = this.#clock.setTimeout(() => {
      this.#sweepTimer = null;
      if (!this.#closed) {
        this.sweepNow();
        this.#scheduleSweep();
      }
    }, this.#opts.sweepIntervalMs);
  }

  /** Run all TTL work immediately (also driven by the internal timer). */
  sweepNow(): void {
    if (this.#closed) return;
    const now = this.#clock.now();
    for (const session of [...this.#sessions.values()]) {
      if (!session.dead && session.expiresAt <= now) {
        this.#terminateSession(session, true);
      }
    }
    for (const cursor of [...this.#pageCursors.values()]) {
      if (cursor.expiresAt <= now) this.#expirePageCursor(cursor, 'liveness');
    }
    for (const watch of [...this.#watches.values()]) {
      if (!watch.stall && watch.expiresAt <= now) this.#stallWatch(watch, 'liveness');
    }
  }

  // ----------------------------------------------- handle-internal accessors

  /** @internal */
  consumeWatch(watch: WatchInternal, maxMessages: number): WatchMessage[] {
    return this.#consumeWatch(watch, maxMessages);
  }
  /** @internal */
  keepaliveWatch(watch: WatchInternal): number {
    return this.#keepaliveWatch(watch);
  }
  /** @internal */
  closeWatch(watch: WatchInternal): void {
    this.#closeWatch(watch);
  }
  /** @internal */
  watchProgress(watch: WatchInternal): number {
    return this.#watchProgress(watch);
  }
  /** @internal */
  watchStall(watch: WatchInternal): { reason: ExpiryReason; basis: RebuildBasis } | null {
    return this.#watchStall(watch);
  }
  /** @internal */
  watchId(watch: WatchInternal): number {
    return this.#watchId(watch);
  }
}

/**
 * Live watch handle. Consume messages with {@link consume}; every consumed
 * progress value is a durable resume point (`watch({ startRevision: progress + 1 })`).
 */
export class WatchHandle {
  readonly #registry: Registry;
  readonly #watch: WatchInternal;

  constructor(registry: Registry, watch: WatchInternal) {
    this.#registry = registry;
    this.#watch = watch;
  }

  get id(): number {
    return this.#registry.watchId(this.#watch);
  }

  get prefix(): string {
    return this.#watch.prefix;
  }

  get progress(): number {
    return this.#registry.watchProgress(this.#watch);
  }

  get stalled(): boolean {
    return this.#registry.watchStall(this.#watch) !== null;
  }

  get stall(): { reason: ExpiryReason; basis: RebuildBasis } | null {
    return this.#registry.watchStall(this.#watch);
  }

  /**
   * Pop buffered messages. When nothing is buffered returns a single progress
   * heartbeat carrying the current resume revision.
   * Throws {@link CursorExpiredError} once the watch must be rebuilt.
   */
  consume(maxMessages = 32): WatchMessage[] {
    return this.#registry.consumeWatch(this.#watch, maxMessages);
  }

  /** Extend the liveness window and return the current progress revision. */
  keepalive(): number {
    return this.#registry.keepaliveWatch(this.#watch);
  }

  close(): void {
    this.#registry.closeWatch(this.#watch);
  }
}
