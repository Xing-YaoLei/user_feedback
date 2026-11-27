import { systemClock } from './clock.ts';
import type { Clock, TimerHandle } from './clock.ts';
import {
  BorrowAbortedError,
  BorrowTimeoutError,
  ConnectionCreateError,
  LeaseAlreadyReleasedError,
  LeaseInvalidError,
  PoolClosedError,
  PoolConfigurationError,
} from './errors.ts';

/**
 * The operations the pool performs on connections. Every operation may be
 * asynchronous and may take arbitrarily long; the pool never assumes that a
 * reset or a close has finished before its promise settles.
 */
export interface PoolAdapter<C> {
  /** Open a new connection. */
  create(): Promise<C>;
  /**
   * Clear any per-call/session state left behind by the previous borrower.
   * The pool only offers the connection to another borrower after this
   * promise fulfils.
   */
  reset(connection: C): Promise<void>;
  /** Close the connection and release its underlying resources. */
  close(connection: C): Promise<void>;
}

export interface AcquireOptions {
  /** Cancels a pending borrow. Borrowing an already-aborted signal fails immediately. */
  signal?: AbortSignal;
  /**
   * Maximum time this borrow may wait for a connection. Overrides
   * `acquireTimeoutMs`. `Infinity` means no deadline.
   */
  timeoutMs?: number;
}

/**
 * A credential for one exclusive borrow. The object itself is the credential:
 * it can release exactly the borrow that produced it, and nothing else.
 */
export interface ConnectionLease<C> {
  /** Unique per borrow, even when the same connection is borrowed repeatedly. */
  readonly id: string;
  readonly connection: C;
  /** True once release() has been invoked successfully (even while cleanup runs). */
  readonly released: boolean;
  /**
   * Returns the connection to the pool. Resolves once the pool has finished
   * with it: either the reset completed and the connection is idle again, or
   * the connection has been fully closed. A second call (or a call with an old
   * lease after the connection has been borrowed again) rejects with a
   * lease-credential error.
   */
  release(): Promise<void>;
}

/** Describes an adapter operation that rejected. */
export interface AdapterErrorInfo<C> {
  operation: 'create' | 'reset' | 'close';
  /** The connection involved, when one existed (absent for create failures). */
  connection: C | undefined;
  error: unknown;
}

export interface ConnectionLeasePoolOptions<C> {
  /** Maximum number of connections that may exist in any live state. Must be >= 1. */
  capacity: number;
  adapter: PoolAdapter<C>;
  /**
   * Absolute lifetime of a connection, measured from the moment create()
   * fulfilled. Must be positive. `Infinity` (default) disables lifetime
   * handling.
   */
  maxLifetimeMs?: number;
  /** Default borrow deadline. Defaults to Infinity (wait forever). */
  acquireTimeoutMs?: number;
  /** Time source used for lifetimes and borrow deadlines. Defaults to systemClock. */
  clock?: Clock;
  /**
   * Optional observer for adapter failures. The pool always records failures
   * in status(); this hook lets callers log or alert as well.
   */
  onAdapterError?: (info: AdapterErrorInfo<C>) => void;
}

export type PoolPhase = 'open' | 'closing' | 'closed';

export interface PoolStatus {
  capacity: number;
  /** Connections whose create() is still in flight. */
  creating: number;
  /** Connections currently held by a borrower. */
  leased: number;
  /** Connections reset and waiting to be borrowed. */
  idle: number;
  /** Returned connections whose reset() is still in flight. */
  resetting: number;
  /** Connections whose close() is still in flight. */
  closing: number;
  /** Leased or resetting connections that reached their lifetime boundary. */
  retired: number;
  /** creating + leased + idle + resetting + closing; always <= capacity. */
  used: number;
  /** capacity - used. */
  available: number;
  pendingBorrowers: number;
  /** False from the instant close() is called. */
  acceptingBorrows: boolean;
  /** True only when no connection exists in any state. */
  allResourcesClosed: boolean;
  /** open before close(), closing while resources drain, closed when drained. */
  phase: PoolPhase;
  /** Number of adapter.create() calls that rejected. */
  createFailures: number;
  /** Number of adapter.reset() calls that rejected. */
  resetFailures: number;
  /** Number of adapter.close() calls that rejected. */
  closeFailures: number;
}

type SlotState = 'creating' | 'leased' | 'idle' | 'resetting' | 'closing';

interface Slot<C> {
  readonly id: string;
  state: SlotState;
  connection: C | undefined;
  /** Set when create() fulfils; lifetime is measured from this instant. */
  createdAt: number | undefined;
  lease: LeaseRecord<C> | null;
  /** Set when the lifetime boundary passes while the connection is unavailable. */
  retired: boolean;
  /** The waiter whose demand caused this creation, if it was still waiting. */
  requester: Waiter<C> | null;
  lifetimeTimer: TimerHandle | undefined;
  hasLifetimeTimer: boolean;
  /** Resolves when close() has completed for this slot (success or failure). */
  closePromise: Promise<void> | null;
  resolveClose: (() => void) | null;
}

interface LeaseRecord<C> {
  readonly id: string;
  readonly slot: Slot<C>;
  active: boolean;
}

interface Waiter<C> {
  readonly signal: AbortSignal | undefined;
  settled: boolean;
  timer: TimerHandle | undefined;
  hasTimer: boolean;
  abortListener: (() => void) | undefined;
  resolve: (lease: ConnectionLease<C>) => void;
  reject: (error: unknown) => void;
}

type WaiterOutcome<C> = { lease: ConnectionLease<C> } | { error: unknown };

/**
 * An exclusive lease pool with strict capacity accounting.
 *
 * Capacity is consumed by a connection as soon as its creation starts and is
 * only given back when creation fails or closing completes. Returning a
 * connection does not free a slot: the connection is reset first and either
 * becomes idle or is closed.
 */
export class ConnectionLeasePool<C> {
  readonly capacity: number;

  private readonly adapter: PoolAdapter<C>;
  private readonly clock: Clock;
  private readonly maxLifetimeMs: number;
  private readonly defaultAcquireTimeoutMs: number;
  private readonly onAdapterError: ((info: AdapterErrorInfo<C>) => void) | undefined;

  private readonly slots = new Map<string, Slot<C>>();
  private readonly waiters: Waiter<C>[] = [];

  private closingPool = false;
  private shutdownPromise: Promise<void> | null = null;
  private resolveShutdown: (() => void) | null = null;

  private slotSequence = 0;
  private leaseSequence = 0;
  private createFailures = 0;
  private resetFailures = 0;
  private closeFailures = 0;

  constructor(options: ConnectionLeasePoolOptions<C>) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new PoolConfigurationError('capacity must be an integer greater than or equal to 1.');
    }
    const maxLifetimeMs = options.maxLifetimeMs ?? Infinity;
    // A finite lifetime must be positive: zero would make every freshly
    // created connection expire immediately, which can only churn creation and
    // closing forever while a borrower is waiting.
    if (typeof maxLifetimeMs !== 'number' || Number.isNaN(maxLifetimeMs) || maxLifetimeMs <= 0) {
      throw new PoolConfigurationError('maxLifetimeMs must be a positive number or Infinity.');
    }
    const acquireTimeoutMs = options.acquireTimeoutMs ?? Infinity;
    if (typeof acquireTimeoutMs !== 'number' || Number.isNaN(acquireTimeoutMs) || acquireTimeoutMs < 0) {
      throw new PoolConfigurationError('acquireTimeoutMs must be a non-negative number or Infinity.');
    }

    this.capacity = options.capacity;
    this.adapter = options.adapter;
    this.clock = options.clock ?? systemClock;
    this.maxLifetimeMs = maxLifetimeMs;
    this.defaultAcquireTimeoutMs = acquireTimeoutMs;
    this.onAdapterError = options.onAdapterError;
  }

  /**
   * Requests exclusive use of a connection. Waiters are served in arrival
   * order. The returned lease is the only credential that can return this
   * particular borrow.
   */
  acquire(options: AcquireOptions = {}): Promise<ConnectionLease<C>> {
    if (this.closingPool) {
      return Promise.reject(new PoolClosedError());
    }

    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(new BorrowAbortedError(signal.reason));
    }

    const timeoutMs = options.timeoutMs ?? this.defaultAcquireTimeoutMs;
    if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(
        new PoolConfigurationError('timeoutMs must be a non-negative number or Infinity.'),
      );
    }

    return new Promise<ConnectionLease<C>>((resolve, reject) => {
      const waiter: Waiter<C> = {
        signal,
        settled: false,
        timer: undefined,
        hasTimer: false,
        abortListener: undefined,
        resolve,
        reject,
      };

      // Register the waiter before arming its deadline so a clock that fires
      // synchronously cannot leave a settled waiter sitting in the queue.
      this.waiters.push(waiter);

      if (Number.isFinite(timeoutMs)) {
        waiter.hasTimer = true;
        waiter.timer = this.clock.setTimeout(() => {
          waiter.hasTimer = false;
          waiter.timer = undefined;
          this.settleWaiter(waiter, { error: new BorrowTimeoutError(timeoutMs) });
          this.pump();
        }, timeoutMs);
      }

      if (signal !== undefined) {
        const onAbort = () => {
          this.settleWaiter(waiter, { error: new BorrowAbortedError(signal.reason) });
          this.pump();
        };
        waiter.abortListener = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
        // Re-check after subscribing: a custom signal may report `aborted`
        // without ever dispatching to a listener added afterwards.
        if (signal.aborted) {
          onAbort();
          return;
        }
      }

      this.pump();
    });
  }

  /**
   * Stops accepting borrows immediately, rejects outstanding waiters, and
   * lets in-flight creation/return cleanup finish. The returned promise
   * fulfils only when every connection has finished closing.
   */
  close(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }

    this.closingPool = true;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });

    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, { error: new PoolClosedError() });
    }

    for (const slot of [...this.slots.values()]) {
      if (slot.state === 'idle') {
        this.startClose(slot);
      } else if (slot.state === 'leased' || slot.state === 'resetting') {
        // Do not interrupt a borrower: mark retirement and close after the
        // holder returns (or after an in-flight reset finishes).
        slot.retired = true;
      }
      // 'creating' closes as soon as create() settles successfully.
      // 'closing' is already on its way.
    }

    this.checkDrained();
    return this.shutdownPromise;
  }

  /** Snapshot of capacity usage and lifecycle state. */
  status(): PoolStatus {
    let creating = 0;
    let leased = 0;
    let idle = 0;
    let resetting = 0;
    let closing = 0;
    let retired = 0;

    for (const slot of this.slots.values()) {
      switch (slot.state) {
        case 'creating':
          creating += 1;
          break;
        case 'leased':
          leased += 1;
          if (slot.retired) retired += 1;
          break;
        case 'idle':
          idle += 1;
          break;
        case 'resetting':
          resetting += 1;
          if (slot.retired) retired += 1;
          break;
        case 'closing':
          closing += 1;
          break;
      }
    }

    const used = this.slots.size;
    const phase: PoolPhase = !this.closingPool ? 'open' : used === 0 ? 'closed' : 'closing';

    return {
      capacity: this.capacity,
      creating,
      leased,
      idle,
      resetting,
      closing,
      retired,
      used,
      available: this.capacity - used,
      pendingBorrowers: this.waiters.length,
      acceptingBorrows: !this.closingPool,
      allResourcesClosed: used === 0,
      phase,
      resetFailures: this.resetFailures,
      closeFailures: this.closeFailures,
      createFailures: this.createFailures,
    };
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  /**
   * Synchronous reconciliation of supply and demand:
   *   1. close idle connections that reached their lifetime boundary;
   *   2. hand idle connections to waiters in FIFO order;
   *   3. start creations while there is demand that no idle/creating/resetting
   *      connection can satisfy and capacity remains.
   */
  private pump(): void {
    if (this.closingPool) {
      return;
    }

    for (const slot of [...this.slots.values()]) {
      if (slot.state === 'idle' && this.isExpired(slot)) {
        this.startClose(slot);
      }
    }

    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.settled) {
        this.waiters.shift();
        continue;
      }
      const slot = this.takeIdleConnection();
      if (slot === undefined) {
        break;
      }
      this.grant(slot, waiter);
    }

    const counts = this.countStates();
    // After the grant loop there is no idle connection that a waiter can use.
    // In-flight creations and resets that will finish usable cover the first
    // waiters in FIFO order. Every waiter beyond that supply needs a new
    // connection, and its demand is what the new creation is started for.
    let covered = counts.creating + counts.resettingReady;
    let needed = this.waiters.length - covered;

    while (needed > 0 && this.slots.size < this.capacity) {
      const requester = this.waiters[covered] ?? null;
      this.startCreate(requester);
      covered += 1;
      needed -= 1;
    }
  }

  /**
   * Counts the supply that can serve a queued waiter:
   * idle connections (already excluded by the grant loop), creations in
   * flight, and resets that will finish usable. Retired or expired resets
   * are going to be closed instead, so they are not supply.
   */
  private countStates(): { idle: number; creating: number; resettingReady: number } {
    let idle = 0;
    let creating = 0;
    let resettingReady = 0;
    for (const slot of this.slots.values()) {
      if (slot.state === 'idle') idle += 1;
      else if (slot.state === 'creating') creating += 1;
      else if (slot.state === 'resetting' && !slot.retired && !this.isExpired(slot)) resettingReady += 1;
    }
    return { idle, creating, resettingReady };
  }

  private takeIdleConnection(): Slot<C> | undefined {
    for (const slot of [...this.slots.values()]) {
      if (slot.state !== 'idle') {
        continue;
      }
      // An idle connection must never be retired (retirement is only applied
      // while leased or resetting), but guard anyway: handing out a retired
      // or expired connection would defeat the lifetime limit.
      if (slot.retired || this.isExpired(slot)) {
        this.startClose(slot);
        continue;
      }
      return slot;
    }
    return undefined;
  }

  private grant(slot: Slot<C>, waiter: Waiter<C>): void {
    if (slot.connection === undefined) {
      throw new Error('Attempted to grant a connection that has no connection instance.');
    }

    const record: LeaseRecord<C> = {
      id: `lease-${++this.leaseSequence}`,
      slot,
      active: true,
    };

    const lease: ConnectionLease<C> = {
      id: record.id,
      connection: slot.connection,
      get released(): boolean {
        return !record.active;
      },
      release: () => this.releaseLease(record),
    };

    slot.state = 'leased';
    slot.lease = record;
    slot.retired = false;
    slot.requester = null;

    this.settleWaiter(waiter, { lease });
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  private startCreate(requester: Waiter<C> | null): void {
    // `requester` is the waiter whose demand justifies this creation. If it
    // gives up (deadline or cancellation) before creation settles, a failure
    // is not pinned on a later waiter and a late connection is not attributed
    // to it.
    const slot: Slot<C> = {
      id: `slot-${++this.slotSequence}`,
      state: 'creating',
      connection: undefined,
      createdAt: undefined,
      lease: null,
      retired: false,
      requester,
      lifetimeTimer: undefined,
      hasLifetimeTimer: false,
      closePromise: null,
      resolveClose: null,
    };
    this.slots.set(slot.id, slot);

    let creation: Promise<C>;
    try {
      creation = Promise.resolve(this.adapter.create());
    } catch (error) {
      creation = Promise.reject(error);
    }

    creation.then(
      (connection) => this.onCreateSuccess(slot, connection),
      (error) => this.onCreateFailure(slot, error),
    );
  }

  private onCreateSuccess(slot: Slot<C>, connection: C): void {
    if (this.slots.get(slot.id) !== slot) {
      return;
    }

    if (connection === undefined) {
      // An adapter that resolves create() with no connection has failed to
      // produce a usable resource. Treat it exactly like a creation failure so
      // capacity is released and no caller is handed `undefined`.
      this.onCreateFailure(slot, new Error('The adapter resolved create() without a connection.'));
      return;
    }

    slot.connection = connection;
    slot.createdAt = this.clock.now();
    slot.state = 'idle';
    slot.requester = null;

    if (this.closingPool || slot.retired) {
      // The pool closed (or the slot was flagged) while creation was in
      // flight. Finish the handshake, then tear the connection down without
      // handing it to anyone.
      this.startClose(slot);
      return;
    }

    this.armLifetimeTimer(slot);
    this.pump();
  }

  private onCreateFailure(slot: Slot<C>, error: unknown): void {
    if (this.slots.get(slot.id) === slot) {
      this.slots.delete(slot.id);
    }
    this.createFailures += 1;
    this.reportAdapterError({ operation: 'create', connection: undefined, error });

    // Creation failure frees capacity, so somebody's demand can now be served
    // by a retry. The failure is reported to the waiter whose demand started
    // this creation — but only if it is still waiting. If that caller already
    // timed out or cancelled, the failure goes to the earliest waiter that is
    // not covered by another in-flight creation. Without that second step an
    // adapter that always fails would be retried forever and no caller would
    // ever learn why.
    const target = this.pickFailureTarget(slot.requester);
    slot.requester = null;
    if (target !== null) {
      this.settleWaiter(target, { error: new ConnectionCreateError(error) });
    }

    this.pump();
    this.checkDrained();
  }

  /**
   * Chooses who learns about a creation failure. Prefers the requesting
   * waiter; otherwise the earliest waiter with no other creation working for
   * it. Returns null when every remaining waiter is covered by a live
   * creation, in which case no retry is started (preventing a failure storm).
   */
  private pickFailureTarget(requester: Waiter<C> | null): Waiter<C> | null {
    if (requester !== null && !requester.settled && this.waiters.includes(requester)) {
      return requester;
    }

    const covered = new Set<Waiter<C>>();
    for (const slot of this.slots.values()) {
      if (slot.state === 'creating' && slot.requester !== null) {
        covered.add(slot.requester);
      }
    }
    for (const waiter of this.waiters) {
      if (!waiter.settled && !covered.has(waiter)) {
        return waiter;
      }
    }
    return null;
  }

  private armLifetimeTimer(slot: Slot<C>): void {
    if (!Number.isFinite(this.maxLifetimeMs)) {
      return;
    }
    slot.hasLifetimeTimer = true;
    slot.lifetimeTimer = this.clock.setTimeout(() => {
      slot.hasLifetimeTimer = false;
      slot.lifetimeTimer = undefined;
      this.onLifetimeBoundary(slot);
    }, this.maxLifetimeMs);
  }

  private onLifetimeBoundary(slot: Slot<C>): void {
    if (this.slots.get(slot.id) !== slot) {
      return;
    }

    switch (slot.state) {
      case 'leased':
      case 'resetting':
        // Never rip a connection away from its holder or from an in-flight
        // reset. Mark it; release() will close it instead of making it idle.
        slot.retired = true;
        break;
      case 'idle':
        this.startClose(slot);
        this.pump();
        break;
      case 'creating':
      case 'closing':
        break;
    }
  }

  private isExpired(slot: Slot<C>): boolean {
    if (!Number.isFinite(this.maxLifetimeMs) || slot.createdAt === undefined) {
      return false;
    }
    return this.clock.now() - slot.createdAt >= this.maxLifetimeMs;
  }

  private clearLifetimeTimer(slot: Slot<C>): void {
    if (slot.hasLifetimeTimer) {
      slot.hasLifetimeTimer = false;
      if (slot.lifetimeTimer !== undefined) {
        this.clock.clearTimeout(slot.lifetimeTimer);
      }
      slot.lifetimeTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Return / reset
  // ---------------------------------------------------------------------------

  private releaseLease(record: LeaseRecord<C>): Promise<void> {
    if (!record.active) {
      // Covers both a duplicate release and an old credential used after the
      // same underlying connection has been leased again.
      return Promise.reject(new LeaseAlreadyReleasedError(record.id));
    }

    const slot = record.slot;
    if (slot.state !== 'leased' || slot.lease !== record) {
      record.active = false;
      return Promise.reject(new LeaseInvalidError(record.id));
    }

    // Invalidate the credential before any asynchronous work so concurrent
    // (or repeated) releases cannot both observe an active lease.
    record.active = false;
    slot.lease = null;
    slot.state = 'resetting';

    const connection = slot.connection;
    if (connection === undefined) {
      record.active = false;
      const closed = this.startClose(slot);
      return closed.then(() => {
        throw new LeaseInvalidError(record.id);
      });
    }

    if (this.closingPool) {
      // The pool is shutting down: a reset would be pointless work that could
      // delay teardown. Close straight away; the slot is freed by finishClose.
      return this.startClose(slot);
    }

    let resetPromise: Promise<void>;
    try {
      resetPromise = Promise.resolve(this.adapter.reset(connection));
    } catch (error) {
      resetPromise = Promise.reject(error);
    }

    return new Promise<void>((resolveRelease) => {
      resetPromise.then(
        () => {
          if (this.slots.get(slot.id) !== slot) {
            resolveRelease();
            return;
          }
          if (this.closingPool || slot.retired || this.isExpired(slot)) {
            // Reset succeeded, but this connection must not be reused: either
            // it is retired, its lifetime elapsed, or the pool is shutting down.
            this.startClose(slot).then(resolveRelease, resolveRelease);
          } else {
            slot.state = 'idle';
            this.pump();
            resolveRelease();
          }
        },
        (error: unknown) => {
          this.resetFailures += 1;
          this.reportAdapterError({ operation: 'reset', connection, error });
          // A failed reset must never be followed by a hand-off. Close and
          // only then free the capacity slot.
          this.startClose(slot).then(resolveRelease, resolveRelease);
        },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Close
  // ---------------------------------------------------------------------------

  /**
   * Starts closing a slot and returns a promise that settles when the close
   * has completed (or immediately when there is no connection yet / already).
   */
  private startClose(slot: Slot<C>): Promise<void> {
    if (slot.state === 'closing') {
      return slot.closePromise ?? Promise.resolve();
    }
    if (this.slots.get(slot.id) !== slot) {
      return slot.closePromise ?? Promise.resolve();
    }
    if (slot.state === 'creating') {
      // There is no connection to close yet. onCreateSuccess will see the
      // flag and close the freshly created connection instead of pooling it.
      slot.retired = true;
      return slot.closePromise ?? Promise.resolve();
    }

    const connection = slot.connection;
    if (connection === undefined) {
      this.slots.delete(slot.id);
      this.checkDrained();
      return Promise.resolve();
    }

    slot.state = 'closing';
    slot.lease = null;
    slot.requester = null;
    this.clearLifetimeTimer(slot);

    slot.closePromise = new Promise<void>((resolveClose) => {
      slot.resolveClose = resolveClose;
    });

    let closePromise: Promise<void>;
    try {
      closePromise = Promise.resolve(this.adapter.close(connection));
    } catch (error) {
      closePromise = Promise.reject(error);
    }

    closePromise.then(
      () => this.finishClose(slot),
      (error: unknown) => {
        // A rejected close is still terminal for this implementation: the
        // slot is reclaimed and the failure is surfaced in status().
        this.closeFailures += 1;
        this.reportAdapterError({ operation: 'close', connection, error });
        this.finishClose(slot);
      },
    );

    return slot.closePromise;
  }

  private finishClose(slot: Slot<C>): void {
    if (this.slots.get(slot.id) === slot) {
      this.slots.delete(slot.id);
    }
    slot.connection = undefined;
    slot.lease = null;

    const resolveClose = slot.resolveClose;
    slot.resolveClose = null;
    if (resolveClose !== null) {
      resolveClose();
    }

    // Closing is the second (and only other) event that frees capacity.
    this.pump();
    this.checkDrained();
  }

  private reportAdapterError(info: AdapterErrorInfo<C>): void {
    if (this.onAdapterError === undefined) {
      return;
    }
    try {
      this.onAdapterError(info);
    } catch {
      // An observer must never break pool accounting.
    }
  }

  private checkDrained(): void {
    if (this.closingPool && this.slots.size === 0 && this.resolveShutdown !== null) {
      const resolve = this.resolveShutdown;
      this.resolveShutdown = null;
      resolve();
    }
  }

  // ---------------------------------------------------------------------------
  // Waiter plumbing
  // ---------------------------------------------------------------------------

  private settleWaiter(waiter: Waiter<C>, outcome: WaiterOutcome<C>): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;

    if (waiter.hasTimer) {
      waiter.hasTimer = false;
      if (waiter.timer !== undefined) {
        this.clock.clearTimeout(waiter.timer);
      }
      waiter.timer = undefined;
    }

    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
      waiter.abortListener = undefined;
    }

    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }

    if ('error' in outcome) {
      waiter.reject(outcome.error);
    } else {
      waiter.resolve(outcome.lease);
    }
  }
}
