/**
 * Deterministic deadline scheduler over an exact integer nanosecond clock.
 *
 * See README.md for the behavioural contract and `test/` for executable
 * evidence of every guarantee.
 */
import { toNanoseconds, type TimeInput } from './time.ts';

// ------------------------------------------------------------------- types

/**
 * A handle to one registration ("generation") of an RPC.
 *
 * Handles are frozen values.  A handle becomes stale when its registration is
 * cancelled, has fired, or its RPC id is registered again; stale handles never
 * trigger callbacks and their `cancel`/`reschedule` calls are no-ops.
 */
export interface DeadlineHandle {
  /** Caller-supplied RPC identifier; may be reused after the old one ends. */
  readonly rpcId: string;
  /** Registration order, assigned once per `register`; breaks deadline ties. */
  readonly seq: number;
  /** Opaque per-registration token, unique for the scheduler's lifetime. */
  readonly generation: number;
}

/** One registration that reached its deadline and was executed. */
export interface ExpiryRecord {
  readonly rpcId: string;
  readonly seq: number;
  readonly generation: number;
  /** Deadline the callback was invoked for. */
  readonly deadline: bigint;
  /** Clock value at invocation (equal to `deadline`). */
  readonly firedAt: bigint;
  /** Position of this callback within the `advance` that ran it (0-based). */
  readonly indexInAdvance: number;
  /** True iff the callback threw. */
  readonly failed: boolean;
  /** True iff this RPC id was re-registered while the callback ran. */
  readonly supersededDuringCallback: boolean;
  /** The thrown value, when `failed` is true. */
  readonly error?: unknown;
}

/** The single terminal `cancel` of a registration. */
export interface CancellationRecord {
  readonly rpcId: string;
  readonly seq: number;
  readonly generation: number;
  readonly cancelledAt: bigint;
  /** True iff the cancellation happened inside a callback of an `advance`. */
  readonly duringAdvance: boolean;
}

/** The single terminal timeout (fired callback that threw) of a registration. */
export interface TimeoutRecord {
  readonly rpcId: string;
  readonly seq: number;
  readonly generation: number;
  readonly deadline: bigint;
  readonly firedAt: bigint;
  readonly error: unknown;
}

export interface SchedulerOptions {
  /** Initial monotonic clock in nanoseconds; defaults to `0n`. */
  readonly now?: TimeInput;
}

export interface AdvanceOptions {
  /**
   * Clock target for this advance.  A deadline is eligible while it is
   * `<= target`.  Defaults to the scheduler's current clock, or — after a
   * budget-stopped advance — the target that advance was working toward.
   */
  readonly target?: TimeInput;
  /** Maximum callbacks to invoke; defaults to unlimited. `0` only observes. */
  readonly maxCallbacks?: number;
}

/** Index-accounting delta for one operation. */
export interface AccessCounts {
  /** Heap node visits + array writes performed. */
  readonly heap: number;
  /** Live-map reads/writes/deletes performed. */
  readonly map: number;
}

export interface AdvanceResult {
  /** Clock after the advance. */
  readonly now: bigint;
  /** Callbacks invoked by this advance. */
  readonly callbacks: number;
  /** Expiry records in execution order. */
  readonly expired: ExpiryRecord[];
  /** True iff the callback budget stopped the advance while work remained due. */
  readonly hasMore: boolean;
  /** Dead index nodes physically dropped while serving this advance. */
  readonly purged: number;
  /** Active registrations after the advance. */
  readonly activeCount: number;
  /** Live-index size after the advance (bounded by `2 * activeCount + 1`). */
  readonly indexSize: number;
  /** Access counts incurred by this advance. */
  readonly access: AccessCounts;
}

/** Synchronous deadline callback; it may cancel/reschedule/register freely. */
export type DeadlineCallback = (handle: DeadlineHandle) => void;

// --------------------------------------------------------------- scheduler

/**
 * Ordering: earliest deadline first; equal deadlines break by smallest
 * registration sequence (oldest registration).  Rescheduling keeps the
 * registration sequence, so the tie-break is stable across re-arming.
 *
 * Representation:
 *  - `live`: exactly one node per active registration (O(1) handle checks).
 *  - `heap`: a binary min-heap keyed by `(deadline, seq)`.  It may briefly hold
 *    dead nodes left by reschedules/supersessions/cancels, but it is rebuilt
 *    whenever dead nodes outnumber live ones, so its size is O(active).
 *
 * Every operation is O(log n) except the amortized O(1) rebuild.  A forward
 * jump across an arbitrary idle span, and skipping past arbitrarily many
 * not-yet-due registrations, both cost O(1) plus the callbacks that actually
 * fire; the clock is never stepped nanosecond by nanosecond.
 *
 * Terminal uniqueness is structural: `cancel` only accepts a live handle and
 * firing removes the node from `live` before its callback runs, so a
 * registration can end exactly once — cancelled, fired, or timed out.
 */
export class DeadlineScheduler {
  private clock: bigint;

  private nextSeq = 1;
  private nextGeneration = 1;

  /** rpcId -> the single live registration node. */
  private readonly live = new Map<string, Node>();

  /** Min-heap of nodes, possibly containing lazily-dead entries. */
  private heap: Node[] = [];
  /** Number of dead nodes currently inside `heap`. */
  private deadInHeap = 0;

  private heapAccesses = 0;
  private mapLookups = 0;
  /** Count of dead index nodes physically dropped (purges + rebuilds). */
  private deadDropped = 0;

  private readonly expiryLog: ExpiryRecord[] = [];
  private readonly cancellationLog: CancellationRecord[] = [];
  private readonly timeoutLog: TimeoutRecord[] = [];

  /** True while an `advance` is running (guards re-entrant advances). */
  private advancing = false;

  /**
   * Target of the most recent advance that stopped on its callback budget.
   * A later `advance()` with no explicit target resumes toward it.
   */
  private pendingTarget: bigint | undefined;

  constructor(options: SchedulerOptions = {}) {
    this.clock = options.now === undefined ? 0n : toNanoseconds(options.now, 'now');
  }

  // ----------------------------------------------------------- observation

  /** Current monotonic time in nanoseconds. */
  now(): bigint {
    return this.clock;
  }

  /** Number of active registrations (neither cancelled nor fired). */
  activeCount(): number {
    return this.live.size;
  }

  /** Number of nodes physically held by the heap index. */
  indexSize(): number {
    return this.heap.length;
  }

  /** Number of dead nodes currently retained by the heap index. */
  staleIndexCount(): number {
    return this.deadInHeap;
  }

  /** Cumulative heap accesses since construction. */
  heapAccessCount(): number {
    return this.heapAccesses;
  }

  /** Cumulative live-map accesses since construction. */
  mapAccessCount(): number {
    return this.mapLookups;
  }

  /** All expiry records in firing order. */
  expiries(): readonly ExpiryRecord[] {
    return this.expiryLog.slice();
  }

  /** All cancellation records in cancellation order. */
  cancellations(): readonly CancellationRecord[] {
    return this.cancellationLog.slice();
  }

  /** All timeout (failed callback) records in firing order. */
  timeouts(): readonly TimeoutRecord[] {
    return this.timeoutLog.slice();
  }

  /** Deadline of an active handle, or `undefined` for a stale handle. */
  deadlineOf(handle: DeadlineHandle): bigint | undefined {
    const node = this.lookup(handle);
    return node?.deadline;
  }

  /** True iff the handle still names an active registration. */
  isActive(handle: DeadlineHandle): boolean {
    return this.lookup(handle) !== undefined;
  }

  // ------------------------------------------------------------- mutation

  /**
   * Register a new generation for `rpcId` at the current clock.  Any previous
   * registration for the same id becomes stale immediately and can never fire.
   * A deadline at or before `now` is due on the next `advance`.
   */
  register(rpcId: string, deadline: TimeInput, callback: DeadlineCallback): DeadlineHandle {
    if (typeof rpcId !== 'string' || rpcId.length === 0) {
      throw new TypeError('rpcId must be a non-empty string');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }
    const deadlineNs = toNanoseconds(deadline, 'deadline');
    const previous = this.mapGet(rpcId);
    if (previous !== undefined) {
      this.retire(previous); // superseded generation must never fire
    }
    const node: Node = {
      rpcId,
      seq: this.nextSeq++,
      generation: this.nextGeneration++,
      deadline: deadlineNs,
      callback,
      dead: false,
    };
    this.mapSet(rpcId, node);
    this.push(node);
    return freezeHandle(node);
  }

  /**
   * Re-arm one registration with a new deadline.  The same handle stays valid
   * and the registration sequence (tie-break) is preserved.  Returns `false`
   * for a stale handle.  O(log n); stale heap space is reclaimed automatically.
   */
  reschedule(handle: DeadlineHandle, deadline: TimeInput): boolean {
    const deadlineNs = toNanoseconds(deadline, 'deadline');
    const node = this.lookup(handle);
    if (node === undefined) {
      return false;
    }
    node.dead = true;
    this.deadInHeap++;
    const replacement: Node = {
      rpcId: node.rpcId,
      seq: node.seq,
      generation: node.generation,
      deadline: deadlineNs,
      callback: node.callback,
      dead: false,
    };
    this.mapSet(node.rpcId, replacement);
    this.push(replacement);
    this.maybeRebuild();
    this.purgeDeadTop();
    return true;
  }

  /**
   * Cancel one registration.  Only a live handle can be cancelled, so each
   * registration yields exactly one terminal outcome.  Returns `true` iff this
   * call terminated the registration.
   */
  cancel(handle: DeadlineHandle): boolean {
    const node = this.lookup(handle);
    if (node === undefined) {
      return false;
    }
    this.mapDelete(node.rpcId);
    node.dead = true;
    this.deadInHeap++;
    this.cancellationLog.push(
      Object.freeze({
        rpcId: node.rpcId,
        seq: node.seq,
        generation: node.generation,
        cancelledAt: this.clock,
        duringAdvance: this.advancing,
      }),
    );
    this.maybeRebuild();
    this.purgeDeadTop();
    return true;
  }

  /** Cancel every active registration; returns how many were terminated. */
  cancelAll(): number {
    let count = 0;
    for (const node of this.live.values()) {
      node.dead = true;
      this.deadInHeap++;
      this.cancellationLog.push(
        Object.freeze({
          rpcId: node.rpcId,
          seq: node.seq,
          generation: node.generation,
          cancelledAt: this.clock,
          duringAdvance: this.advancing,
        }),
      );
      count++;
    }
    this.mapClear();
    this.maybeRebuild();
    this.purgeDeadTop();
    return count;
  }

  // -------------------------------------------------------------- advance

  /**
   * Advance the clock toward `target` and synchronously run every due callback
   * in `(deadline, seq)` order.
   *
   * - A throwing callback is recorded on its own expiry record, produces one
   *   timeout record, and does not stop the remaining due work.
   * - Callbacks may cancel/reschedule registrations or register new already-due
   *   ones; those changes are honoured by the very next selection.
   * - When `maxCallbacks` is reached with work still due, the clock stops at the
   *   last executed deadline, `hasMore` is true, and the next advance resumes
   *   exactly there.
   * - A jump over a large idle interval costs O(log n) plus the callbacks that
   *   actually fire; it never steps nanosecond by nanosecond nor scans
   *   registrations that are not due.
   */
  advance(options: AdvanceOptions = {}): AdvanceResult {
    if (this.advancing) {
      throw new Error('advance() cannot be called re-entrantly; mutate from callbacks instead');
    }
    const startClock = this.clock;
    const defaultTarget = this.pendingTarget ?? startClock;
    const requested =
      options.target === undefined ? defaultTarget : toNanoseconds(options.target, 'target');
    const target = requested < startClock ? startClock : requested;
    const budget = options.maxCallbacks;
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 0)) {
      throw new RangeError('maxCallbacks must be a non-negative integer');
    }
    const limit = budget === undefined ? Number.POSITIVE_INFINITY : budget;

    const heapBefore = this.heapAccesses;
    const mapBefore = this.mapLookups;
    const droppedBefore = this.deadDropped;

    const expired: ExpiryRecord[] = [];
    let hasMore = false;

    this.advancing = true;
    try {
      for (;;) {
        this.purgeDeadTop();
        const node = this.heap.length === 0 ? undefined : this.heap[0];
        if (node === undefined) {
          break;
        }
        this.heapAccesses++; // inspect the candidate
        if (node.deadline > target) {
          break;
        }
        if (expired.length >= limit) {
          hasMore = true;
          break;
        }
        // Commit: remove the live minimum and stop the clock on its deadline.
        this.popRoot();
        this.mapDelete(node.rpcId);
        if (node.deadline > this.clock) {
          this.clock = node.deadline;
        }
        const firedAt = this.clock;
        node.dead = true;

        let failed = false;
        let error: unknown;
        try {
          node.callback(freezeHandle(node));
        } catch (thrown) {
          failed = true;
          error = thrown;
        }

        const expiry: ExpiryRecord = Object.freeze({
          rpcId: node.rpcId,
          seq: node.seq,
          generation: node.generation,
          deadline: node.deadline,
          firedAt,
          indexInAdvance: expired.length,
          failed,
          supersededDuringCallback: this.generationSuperseded(node),
          ...(failed ? { error } : {}),
        });
        expired.push(expiry);
        this.expiryLog.push(expiry);
        if (failed) {
          this.timeoutLog.push(
            Object.freeze({
              rpcId: node.rpcId,
              seq: node.seq,
              generation: node.generation,
              deadline: node.deadline,
              firedAt,
              error,
            }),
          );
        }
        this.maybeRebuild();
      }
    } finally {
      this.advancing = false;
    }

    // With no remaining due work the clock may jump straight to the target.
    if (hasMore) {
      this.pendingTarget = target;
    } else {
      this.pendingTarget = undefined;
      if (this.clock < target) {
        this.clock = target;
      }
    }

    return {
      now: this.clock,
      callbacks: expired.length,
      expired,
      hasMore,
      purged: this.deadDropped - droppedBefore,
      activeCount: this.live.size,
      indexSize: this.heap.length,
      access: {
        heap: this.heapAccesses - heapBefore,
        map: this.mapLookups - mapBefore,
      },
    };
  }

  // -------------------------------------------------------------- internals

  private lookup(handle: DeadlineHandle): Node | undefined {
    const node = this.mapGet(handle.rpcId);
    if (node === undefined) {
      return undefined;
    }
    return node.generation === handle.generation && node.seq === handle.seq ? node : undefined;
  }

  /** True when the RPC id now names a different generation than `fired`. */
  private generationSuperseded(fired: Node): boolean {
    const live = this.mapGet(fired.rpcId);
    return live !== undefined && live.generation !== fired.generation;
  }

  /** Mark a live node dead (it must currently be in the heap). */
  private retire(node: Node): void {
    node.dead = true;
    this.deadInHeap++;
    this.maybeRebuild();
  }

  private mapGet(rpcId: string): Node | undefined {
    this.mapLookups++;
    return this.live.get(rpcId);
  }

  private mapSet(rpcId: string, node: Node): void {
    this.mapLookups++;
    this.live.set(rpcId, node);
  }

  private mapDelete(rpcId: string): void {
    this.mapLookups++;
    this.live.delete(rpcId);
  }

  private mapClear(): void {
    this.mapLookups++;
    this.live.clear();
  }

  // Heap maintenance.  `heapAccesses` counts every node visit and array write.

  private push(node: Node): void {
    this.heap.push(node);
    this.heapAccesses++;
    this.siftUp(this.heap.length - 1);
  }

  private popRoot(): void {
    const root = this.heap[0];
    const last = this.heap.pop()!;
    this.heapAccesses++;
    if (root.dead) {
      this.deadInHeap--;
    }
    if (this.heap.length === 0) {
      return; // that root was the only element
    }
    this.heap[0] = last;
    this.heapAccesses++;
    this.siftDown(0);
  }

  /** Drop dead nodes from the top of the heap (they can never be due first). */
  private purgeDeadTop(): number {
    let removed = 0;
    for (;;) {
      if (this.heap.length === 0) {
        break;
      }
      this.heapAccesses++; // visit the top
      if (!this.heap[0].dead) {
        break;
      }
      this.popRoot();
      removed++;
    }
    this.deadDropped += removed;
    return removed;
  }

  /**
   * Rebuild the heap dropping dead nodes once they outnumber live ones.  This
   * keeps `indexSize <= 2 * activeCount + 1` no matter how often a single
   * registration is rescheduled.  Amortized O(1) per dead node.
   */
  private maybeRebuild(): void {
    if (this.deadInHeap <= this.live.size) {
      return;
    }
    const liveNodes: Node[] = [];
    for (const node of this.heap) {
      this.heapAccesses++;
      if (!node.dead) {
        liveNodes.push(node);
      }
    }
    this.deadDropped += this.heap.length - liveNodes.length;
    this.heap = liveNodes;
    this.heapAccesses += liveNodes.length;
    this.deadInHeap = 0;
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  private siftUp(start: number): void {
    let i = start;
    const node = this.heap[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentNode = this.heap[parent];
      this.heapAccesses++;
      if (lessThan(node, parentNode)) {
        this.heap[i] = parentNode;
        this.heapAccesses++;
        i = parent;
      } else {
        break;
      }
    }
    this.heap[i] = node;
    this.heapAccesses++;
  }

  private siftDown(start: number): void {
    let i = start;
    const node = this.heap[i];
    const length = this.heap.length;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= length) {
        break;
      }
      const right = left + 1;
      let child = left;
      this.heapAccesses++;
      if (right < length && lessThan(this.heap[right], this.heap[left])) {
        child = right;
      }
      const childNode = this.heap[child];
      this.heapAccesses++;
      if (lessThan(childNode, node)) {
        this.heap[i] = childNode;
        this.heapAccesses++;
        i = child;
      } else {
        break;
      }
    }
    this.heap[i] = node;
    this.heapAccesses++;
  }
}

// -------------------------------------------------------------- node / utils

interface Node {
  readonly rpcId: string;
  readonly seq: number;
  readonly generation: number;
  deadline: bigint;
  readonly callback: DeadlineCallback;
  dead: boolean;
}

function lessThan(a: Node, b: Node): boolean {
  if (a.deadline !== b.deadline) {
    return a.deadline < b.deadline;
  }
  return a.seq < b.seq;
}

function freezeHandle(node: Node): DeadlineHandle {
  return Object.freeze({ rpcId: node.rpcId, seq: node.seq, generation: node.generation });
}
