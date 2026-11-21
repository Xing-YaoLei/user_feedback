import { abortCode, CoordinatorError } from './errors.ts';
import type {
  AbortReason,
  AcquiredLock,
  Clock,
  CoordinatorEvent,
  CreateSessionOptions,
  EndReason,
  GrantEvent,
  HeldLockSnapshot,
  LockMode,
  LockRequest,
  QueueEntrySnapshot,
  StartTransactionOptions,
} from './types.ts';

/* ---------------------------------- 内部状态 ---------------------------------- */

interface HeldLock {
  resource: string;
  mode: LockMode;
  /** token of the current exclusive holding; undefined for shared locks. */
  fencingToken?: number;
}

interface PendingGroup {
  groupId: number;
  transactionId: string;
  /** resources the transaction did not already hold in a sufficient mode. */
  requests: LockRequest[];
  /** per-request queue entry, same length/order as requests. */
  entries: QueueEntry[];
  resolve: (locks: AcquiredLock[]) => void;
  reject: (error: CoordinatorError) => void;
  settled: boolean;
}

interface QueueEntry {
  group: PendingGroup;
  resource: string;
  mode: LockMode;
  isUpgrade: boolean;
}

interface ResourceState {
  /** current holders; empty means the resource is free. */
  holders: Map<string, HeldLock>;
  /** FIFO wait queue; an exclusive head blocks every later request. */
  queue: QueueEntry[];
  /** monotonically increasing, bumped on every exclusive authorization. */
  fencingCounter: number;
}

interface SessionState {
  sessionId: string;
  leaseLength: number;
  createdAt: number;
  expiresAt: number;
  expired: boolean;
  transactions: Set<string>;
}

interface TransactionState {
  transactionId: string;
  sessionId: string;
  /** coordinator-assigned creation order; strictly increasing. */
  seq: number;
  deadline?: number;
  ended: boolean;
  endReason?: EndReason;
  held: Map<string, HeldLock>;
  pending?: PendingGroup;
}

/* ---------------------------------- 锁兼容性 ---------------------------------- */

function modesCompatible(a: LockMode, b: LockMode): boolean {
  return a === 'shared' && b === 'shared';
}

/**
 * Decide whether `mode` can be granted on a resource right now.
 * The requesting transaction's own locks never conflict with itself: it keeps
 * its original locks while waiting for an upgrade, and a weaker re-request of
 * a held lock is answered from the held set before reaching this function.
 */
function lockCouldBeGranted(
  resource: ResourceState,
  transactionId: string,
  mode: LockMode,
): boolean {
  for (const [holderId, held] of resource.holders) {
    if (holderId === transactionId) continue;
    if (!modesCompatible(held.mode, mode)) return false;
  }
  return true;
}

/* ---------------------------------- 协调器 ---------------------------------- */

export class LockCoordinator {
  private readonly clock: Clock;
  private readonly sessions = new Map<string, SessionState>();
  private readonly transactions = new Map<string, TransactionState>();
  private readonly resources = new Map<string, ResourceState>();
  private seqCounter = 0;
  private groupCounter = 0;
  private idCounter = 0;
  private pumping = false;
  private readonly listeners = new Set<(event: CoordinatorEvent) => void>();
  private readonly grantTrail: GrantEvent[] = [];
  private readonly clockUnsubscribe?: () => void;

  constructor(clock: Clock) {
    this.clock = clock;
    // A manual clock notifies us on every advance so deadline/lease callbacks
    // interleave deterministically with lock operations.
    const maybeManual = clock as { onAdvance?: (l: (now: number) => void) => () => void };
    if (typeof maybeManual.onAdvance === 'function') {
      this.clockUnsubscribe = maybeManual.onAdvance(() => this.processTimeouts());
    }
  }

  /* ------------------------------- 事件与轨迹 ------------------------------- */

  onEvent(listener: (event: CoordinatorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Immutable view of every grant event, in authorization order. */
  getGrantTrail(): ReadonlyArray<GrantEvent> {
    return this.grantTrail;
  }

  /** Detach from the injected clock's advance notifications. */
  dispose(): void {
    this.clockUnsubscribe?.();
    this.listeners.clear();
  }

  private emit(event: CoordinatorEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /* --------------------------------- 会话 --------------------------------- */

  createSession(options: CreateSessionOptions): string {
    if (!(options.leaseLength > 0)) {
      throw new CoordinatorError('INVALID_REQUEST', 'leaseLength must be positive');
    }
    const now = this.clock.now();
    const sessionId = options.sessionId ?? this.generateId('s');
    if (this.sessions.has(sessionId)) {
      throw new CoordinatorError('INVALID_REQUEST', `duplicate session id: ${sessionId}`);
    }
    this.sessions.set(sessionId, {
      sessionId,
      leaseLength: options.leaseLength,
      createdAt: now,
      expiresAt: now + options.leaseLength,
      expired: false,
      transactions: new Set(),
    });
    return sessionId;
  }

  /**
   * Extend the lease. A renewal that arrives at or after expiry is rejected and
   * can never restore an expired (old) session.
   */
  renewSession(sessionId: string, extension: number): number {
    if (!(extension > 0)) {
      throw new CoordinatorError('INVALID_REQUEST', 'extension must be positive');
    }
    this.processTimeouts();
    const session = this.sessions.get(sessionId);
    if (!session || session.expired) {
      throw new CoordinatorError('SESSION_EXPIRED', `session ${sessionId} is no longer valid`);
    }
    session.expiresAt = this.clock.now() + extension;
    session.leaseLength = extension;
    return session.expiresAt;
  }

  isSessionValid(sessionId: string): boolean {
    this.processTimeouts();
    const session = this.sessions.get(sessionId);
    return !!session && !session.expired;
  }

  getSessionExpiry(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new CoordinatorError('SESSION_EXPIRED', 'unknown session');
    return session.expiresAt;
  }

  /* -------------------------------- 事务 -------------------------------- */

  startTransaction(sessionId: string, options: StartTransactionOptions = {}): string {
    this.processTimeouts();
    const session = this.sessions.get(sessionId);
    if (!session || session.expired) {
      throw new CoordinatorError('SESSION_EXPIRED', `session ${sessionId} is no longer valid`);
    }
    if (options.deadline !== undefined && options.deadline <= this.clock.now()) {
      throw new CoordinatorError('INVALID_REQUEST', 'deadline is already in the past');
    }
    const transactionId = options.transactionId ?? this.generateId('tx');
    if (this.transactions.has(transactionId)) {
      throw new CoordinatorError('INVALID_REQUEST', `duplicate transaction id: ${transactionId}`);
    }
    const tx: TransactionState = {
      transactionId,
      sessionId,
      seq: ++this.seqCounter,
      deadline: options.deadline,
      ended: false,
      held: new Map(),
    };
    this.transactions.set(transactionId, tx);
    session.transactions.add(transactionId);
    return transactionId;
  }

  isTransactionActive(transactionId: string): boolean {
    this.processTimeouts();
    const tx = this.transactions.get(transactionId);
    return !!tx && !tx.ended;
  }

  getHeldLocks(transactionId: string): HeldLockSnapshot[] {
    const tx = this.transactions.get(transactionId);
    if (!tx) return [];
    return [...tx.held.values()].map((l) => ({ ...l }));
  }

  /** FIFO snapshot of a resource's wait queue (head first). */
  getQueue(resource: string): QueueEntrySnapshot[] {
    const state = this.resources.get(resource);
    if (!state) return [];
    return state.queue.map((entry) => ({
      transactionId: entry.group.transactionId,
      mode: entry.mode,
      isUpgrade: entry.isUpgrade,
    }));
  }

  /* -------------------------------- 申请锁 -------------------------------- */

  /**
   * Request a whole batch of locks. The batch is authorized together: either
   * every requested resource is granted immediately, or every unsatisfied
   * request is queued as one group and the returned promise settles only when
   * the whole group can be granted. Already-held sufficient locks are answered
   * from the transaction's own holding without queueing.
   */
  acquire(transactionId: string, requests: LockRequest[]): Promise<AcquiredLock[]> {
    this.processTimeouts();
    const tx = this.requireActiveTransaction(transactionId);
    if (tx.pending) {
      throw new CoordinatorError(
        'INVALID_REQUEST',
        `transaction ${transactionId} already has a waiting request batch`,
      );
    }
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new CoordinatorError('INVALID_REQUEST', 'at least one lock request is required');
    }

    const normalized = this.normalizeRequests(tx, requests);
    const answerOrder = normalized.map((r) => r.resource);

    // Anything already held strongly enough needs no queue entry.
    const toAcquire: LockRequest[] = [];
    const immediate: AcquiredLock[] = [];
    for (const request of normalized) {
      const held = tx.held.get(request.resource);
      if (held && (held.mode === request.mode || held.mode === 'exclusive')) {
        immediate.push({
          resource: request.resource,
          mode: held.mode,
          ...(held.fencingToken !== undefined ? { fencingToken: held.fencingToken } : {}),
        });
      } else {
        toAcquire.push(request);
      }
    }

    if (toAcquire.length === 0) {
      return Promise.resolve(this.orderAnswer(immediate, answerOrder));
    }

    // All-or-nothing: only answer immediately if every missing lock can be
    // granted without passing any queued waiter.
    if (toAcquire.every((r) => this.canGrantNow(r, tx))) {
      const granted = this.grantLocks(tx, toAcquire);
      this.pump();
      return Promise.resolve(this.orderAnswer([...immediate, ...granted], answerOrder));
    }

    // Enqueue the whole group at the tail of each involved resource queue.
    const group: PendingGroup = {
      groupId: ++this.groupCounter,
      transactionId,
      requests: toAcquire,
      entries: [],
      resolve: () => undefined,
      reject: () => undefined,
      settled: false,
    };
    for (const request of toAcquire) {
      const state = this.getResource(request.resource);
      const held = tx.held.get(request.resource);
      const entry: QueueEntry = {
        group,
        resource: request.resource,
        mode: request.mode,
        isUpgrade: !!held && held.mode === 'shared' && request.mode === 'exclusive',
      };
      state.queue.push(entry);
      group.entries.push(entry);
    }
    tx.pending = group;

    const promise = new Promise<AcquiredLock[]>((resolve, reject) => {
      group.resolve = resolve;
      group.reject = reject;
    });

    // A new edge may have closed a wait-for cycle. Victim selection depends
    // only on transaction creation order, and must run before any pumping.
    this.resolveDeadlocks();
    this.pump();
    return promise;
  }

  /* ------------------------------ 释放与结束 ------------------------------ */

  /** Release specific held locks. Pending requests are not affected. */
  release(transactionId: string, resources: string[]): void {
    this.processTimeouts();
    const tx = this.requireActiveTransaction(transactionId);
    for (const resource of resources) {
      const held = tx.held.get(resource);
      if (!held) {
        throw new CoordinatorError(
          'INVALID_REQUEST',
          `transaction ${transactionId} does not hold ${resource}`,
        );
      }
      this.removeHolding(tx, resource);
    }
    this.pump();
  }

  /** Normal completion: release every lock and invalidate the transaction id. */
  commit(transactionId: string): void {
    this.finish(transactionId, 'committed');
  }

  rollback(transactionId: string): void {
    this.finish(transactionId, 'rolled-back');
  }

  /** Explicit cancellation: abort the transaction and revoke any waiting. */
  cancel(transactionId: string): void {
    this.processTimeouts();
    const tx = this.transactions.get(transactionId);
    if (!tx || tx.ended) {
      throw new CoordinatorError('TRANSACTION_ENDED', `transaction ${transactionId} is not active`);
    }
    this.abort(tx, 'cancelled');
    // Released locks (and removed queue entries) must unblock other waiters.
    this.pump();
  }

  /* ------------------------------ 超时与过期 ------------------------------ */

  /**
   * Process every due session expiration and transaction deadline at the
   * clock's current time. Boundary rule: expiry at exactly `now` is due.
   * Safe to call repeatedly; also invoked automatically on clock advances and
   * at the start of every public operation.
   */
  processTimeouts(): void {
    if (this.pumping) return;
    const now = this.clock.now();
    let changed = false;

    for (const session of this.sessions.values()) {
      if (!session.expired && session.expiresAt <= now) {
        session.expired = true;
        changed = true;
        for (const transactionId of [...session.transactions]) {
          const tx = this.transactions.get(transactionId);
          if (tx && !tx.ended) this.abort(tx, 'session-expired');
        }
      }
    }

    for (const tx of this.transactions.values()) {
      if (!tx.ended && tx.deadline !== undefined && tx.deadline <= now) {
        this.abort(tx, 'deadline-exceeded');
        changed = true;
      }
    }

    if (changed) this.pump();
  }

  /* ------------------------------ Fencing 校验 ------------------------------ */

  /**
   * Validate a write credential. Passes only when:
   *  1. the transaction is still active and its session lease is unexpired,
   *  2. the transaction still holds an exclusive lock on the resource,
   *  3. the presented token is exactly the token of that exclusive holding.
   * A token from an older exclusive authorization can never validate again.
   */
  validateFencingToken(transactionId: string, resource: string, token: number): boolean {
    this.processTimeouts();
    const tx = this.transactions.get(transactionId);
    if (!tx || tx.ended) return false;
    const session = this.sessions.get(tx.sessionId);
    if (!session || session.expired) return false;
    const held = tx.held.get(resource);
    if (!held || held.mode !== 'exclusive' || held.fencingToken === undefined) return false;
    return held.fencingToken === token;
  }

  /* ------------------------------- 内部实现 ------------------------------- */

  private requireActiveTransaction(transactionId: string): TransactionState {
    const tx = this.transactions.get(transactionId);
    if (!tx) {
      throw new CoordinatorError(
        'TRANSACTION_ENDED',
        `unknown transaction id: ${transactionId}; ended ids stay invalid`,
      );
    }
    const session = this.sessions.get(tx.sessionId);
    if (tx.ended || !session || session.expired) {
      throw new CoordinatorError(
        'TRANSACTION_ENDED',
        `transaction ${transactionId} is not active`,
        tx.endReason as AbortReason | undefined,
      );
    }
    return tx;
  }

  private normalizeRequests(tx: TransactionState, requests: LockRequest[]): LockRequest[] {
    const byResource = new Map<string, LockMode>();
    for (const request of requests) {
      if (!request || typeof request.resource !== 'string' || request.resource.length === 0) {
        throw new CoordinatorError('INVALID_REQUEST', 'each request needs a non-empty resource');
      }
      if (request.mode !== 'shared' && request.mode !== 'exclusive') {
        throw new CoordinatorError('INVALID_REQUEST', `unknown lock mode: ${String(request.mode)}`);
      }
      const existing = byResource.get(request.resource);
      // Two mentions of one resource in a batch collapse to the stronger mode.
      if (existing === 'exclusive' || request.mode === 'shared') {
        byResource.set(request.resource, existing ?? request.mode);
      } else {
        byResource.set(request.resource, 'exclusive');
      }
    }
    return [...byResource.entries()].map(([resource, mode]) => ({ resource, mode }));
  }

  private getResource(resource: string): ResourceState {
    let state = this.resources.get(resource);
    if (!state) {
      state = { holders: new Map(), queue: [], fencingCounter: 0 };
      this.resources.set(resource, state);
    }
    return state;
  }

  /**
   * Immediate grant check: no blocking holder and nobody queued ahead
   * (strict FIFO; an exclusive waiter ahead blocks even compatible requests,
   * which prevents later shared requests from jumping the queue).
   */
  private canGrantNow(request: LockRequest, tx: TransactionState): boolean {
    const state = this.getResource(request.resource);
    if (state.queue.length > 0) return false;
    return lockCouldBeGranted(state, tx.transactionId, request.mode);
  }

  /** Grant check for a queued entry: it must be at the head and conflicts gone. */
  private canGrantHead(entry: QueueEntry): boolean {
    const state = this.getResource(entry.resource);
    if (state.queue[0] !== entry) return false;
    return lockCouldBeGranted(state, entry.group.transactionId, entry.mode);
  }

  private grantLocks(tx: TransactionState, requests: LockRequest[]): AcquiredLock[] {
    const result: AcquiredLock[] = [];
    for (const request of requests) {
      const state = this.getResource(request.resource);

      if (request.mode === 'exclusive') {
        // Every exclusive authorization (including a shared -> exclusive
        // upgrade) gets a fresh strictly increasing per-resource token, and
        // supersedes any previously held lock on the resource.
        state.fencingCounter += 1;
        const token = state.fencingCounter;
        const held: HeldLock = { resource: request.resource, mode: 'exclusive', fencingToken: token };
        state.holders.set(tx.transactionId, held);
        tx.held.set(request.resource, held);
        result.push({ resource: request.resource, mode: 'exclusive', fencingToken: token });
      } else {
        const held: HeldLock = { resource: request.resource, mode: 'shared' };
        state.holders.set(tx.transactionId, held);
        tx.held.set(request.resource, held);
        result.push({ resource: request.resource, mode: 'shared' });
      }
    }

    const event: GrantEvent = {
      type: 'grant',
      transactionId: tx.transactionId,
      locks: result.map((l) => ({ ...l })),
      at: this.clock.now(),
    };
    this.grantTrail.push(event);
    this.emit(event);
    return result;
  }

  /**
   * Repeatedly scan every resource queue. A waiting group is granted only when
   * every one of its entries is at its resource head and conflict-free, so a
   * batch is always authorized together. Each pass examines all resources
   * rather than stopping at a blocked head: a cross-resource batch may be
   * grantable on one resource while blocked on another, and non-conflicting
   * resources must keep moving independently. An exclusive head simply stalls
   * its own queue until its group becomes grantable.
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let progress = true;
      while (progress) {
        progress = false;
        for (const state of this.resources.values()) {
          const head = state.queue[0];
          if (!head) continue;
          const group = head.group;
          if (group.settled) {
            this.removeGroupEntries(group);
            progress = true;
            continue;
          }
          // Every entry of this group must be the head of its own queue and
          // free of conflicts; otherwise leave every entry queued and keep
          // scanning the other resources (strict FIFO, no partial grants).
          const allReady = group.entries.every((entry) => this.canGrantHead(entry));
          if (!allReady) continue;

          this.removeGroupEntries(group);
          const granted = this.grantLocks(
            this.transactions.get(group.transactionId)!,
            group.requests,
          );
          group.settled = true;
          const tx = this.transactions.get(group.transactionId)!;
          tx.pending = undefined;
          group.resolve(granted);
          progress = true;
        }

        if (!progress) {
          // Nothing moved this pass: remaining waiters may form a cycle that
          // only closed after a recent release/grant. Break it and let the
          // next pass advance the surviving requests; if the graph is already
          // acyclic every remaining waiter is blocked on a live holder, so stop.
          const brokeCycle = this.resolveDeadlocks();
          if (!brokeCycle) break;
          progress = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private removeGroupEntries(group: PendingGroup): void {
    for (const entry of group.entries) {
      const state = this.resources.get(entry.resource);
      if (!state) continue;
      const index = state.queue.indexOf(entry);
      if (index >= 0) state.queue.splice(index, 1);
    }
  }

  /* ------------------------------ 等待图死锁 ------------------------------ */

  /**
   * Build wait-for edges: waiting transaction -> every transaction that blocks
   * it. For each queued entry:
   *  - if it is not the queue head, every queued transaction ahead of it blocks
   *    it (a batch can only be authorized once each entry reaches its head);
   *  - if it is the queue head, every current holder of the resource blocks it:
   *    a compatible holder may be releasable, but while held the entry cannot
   *    be authorized, so cross-resource batch cycles are fully represented.
   * Edges point strictly toward the blocker, so an ordinary FIFO line is a
   * chain rather than a cycle; real cycles require mutual waiting across
   * resources or held locks. Self edges are ignored.
   */
  private buildWaitGraph(): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    for (const tx of this.transactions.values()) {
      if (tx.ended || !tx.pending) continue;
      const edges = new Set<string>();
      graph.set(tx.transactionId, edges);
      for (const entry of tx.pending.entries) {
        const state = this.resources.get(entry.resource);
        if (!state) continue;

        const position = state.queue.indexOf(entry);
        if (position > 0) {
          for (let i = 0; i < position; i++) {
            const ahead = state.queue[i]!;
            if (ahead.group.transactionId !== tx.transactionId) {
              edges.add(ahead.group.transactionId);
            }
          }
        } else {
          for (const holderId of state.holders.keys()) {
            if (holderId !== tx.transactionId) edges.add(holderId);
          }
        }
      }
    }
    return graph;
  }

  /**
   * Detect cycles with Tarjan's SCC algorithm and abort the youngest
   * transaction (largest coordinator-assigned creation sequence) of each
   * cyclic SCC. Repeats until the wait-for graph is acyclic.
   */
  private resolveDeadlocks(): boolean {
    let abortedAny = false;
    for (let guard = 0; guard < 1000; guard++) {
      const graph = this.buildWaitGraph();
      if (graph.size === 0) return abortedAny;

      let indexCounter = 0;
      const indices = new Map<string, number>();
      const lowLinks = new Map<string, number>();
      const stack: string[] = [];
      const onStack = new Set<string>();
      const components: string[][] = [];

      const strongConnect = (vertex: string): void => {
        indices.set(vertex, indexCounter);
        lowLinks.set(vertex, indexCounter);
        indexCounter++;
        stack.push(vertex);
        onStack.add(vertex);

        for (const next of graph.get(vertex) ?? []) {
          if (!graph.has(next)) continue; // edge to a non-waiting node
          if (!indices.has(next)) {
            strongConnect(next);
            lowLinks.set(vertex, Math.min(lowLinks.get(vertex)!, lowLinks.get(next)!));
          } else if (onStack.has(next)) {
            lowLinks.set(vertex, Math.min(lowLinks.get(vertex)!, indices.get(next)!));
          }
        }

        if (lowLinks.get(vertex) === indices.get(vertex)) {
          const component: string[] = [];
          let node: string;
          do {
            node = stack.pop()!;
            onStack.delete(node);
            component.push(node);
          } while (node !== vertex);
          components.push(component);
        }
      };

      for (const vertex of graph.keys()) {
        if (!indices.has(vertex)) strongConnect(vertex);
      }

      const victims: TransactionState[] = [];
      for (const component of components) {
        const cyclic =
          component.length > 1 ||
          (component.length === 1 && (graph.get(component[0]!)?.has(component[0]!) ?? false));
        if (!cyclic) continue;
        let victim: TransactionState | undefined;
        for (const id of component) {
          const candidate = this.transactions.get(id)!;
          if (!victim || candidate.seq > victim.seq) victim = candidate;
        }
        if (victim) victims.push(victim);
      }

      if (victims.length === 0) return abortedAny;
      for (const victim of victims) {
        this.abort(victim, 'deadlock-victim');
        abortedAny = true;
      }
    }
    return abortedAny;
  }

  /* -------------------------------- 终止处理 -------------------------------- */

  private abort(tx: TransactionState, reason: AbortReason): void {
    if (tx.ended) return;

    // Revoke the waiting first: an invalidated request must never be granted
    // later, even if a pump is already unfolding.
    if (tx.pending) {
      const group = tx.pending;
      this.removeGroupEntries(group);
      tx.pending = undefined;
      if (!group.settled) {
        group.settled = true;
        const error = new CoordinatorError(
          abortCode(reason),
          `transaction ${tx.transactionId} aborted: ${reason}`,
          reason,
        );
        group.reject(error);
      }
    }

    // Release every held lock.
    for (const resource of [...tx.held.keys()]) this.removeHolding(tx, resource);
    tx.held.clear();

    this.markEnded(tx, reason);
  }

  private finish(transactionId: string, reason: EndReason): void {
    this.processTimeouts();
    const tx = this.transactions.get(transactionId);
    if (!tx || tx.ended) {
      throw new CoordinatorError('TRANSACTION_ENDED', `transaction ${transactionId} is not active`);
    }
    if (tx.pending) {
      throw new CoordinatorError(
        'INVALID_REQUEST',
        'cannot end a transaction while a lock batch is still waiting; cancel it first',
      );
    }
    for (const resource of [...tx.held.keys()]) this.removeHolding(tx, resource);
    tx.held.clear();
    this.markEnded(tx, reason);
    this.pump();
  }

  private removeHolding(tx: TransactionState, resource: string): void {
    tx.held.delete(resource);
    const state = this.resources.get(resource);
    if (state) state.holders.delete(tx.transactionId);
  }

  private markEnded(tx: TransactionState, reason: EndReason): void {
    tx.ended = true;
    tx.endReason = reason;
    const session = this.sessions.get(tx.sessionId);
    session?.transactions.delete(tx.transactionId);
    // The id is intentionally retained in `transactions` so it stays invalid:
    // any later acquire/renew/cancel referencing it fails deterministically.
    this.emit({ type: 'transaction-end', transactionId: tx.transactionId, reason, at: this.clock.now() });
  }

  private orderAnswer(locks: AcquiredLock[], order: string[]): AcquiredLock[] {
    const byResource = new Map(locks.map((l) => [l.resource, l]));
    return order.map((resource) => byResource.get(resource)!).filter(Boolean);
  }

  private generateId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
