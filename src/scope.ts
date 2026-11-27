/**
 * Deadline scopes.
 *
 * A scope owns one absolute deadline on a monotonic clock. The deadline is
 * derived at entry time from a relative budget received from the caller, or
 * supplied directly, and is always the earlier of the scope's own request and
 * its parent's effective deadline:
 *
 *     child.deadline = min(parent.deadline, now + child.budget)
 *
 * Scopes form a tree. Ending a scope ends all of its descendants, and removes
 * it from its parent. A child ending never touches its parent or its siblings.
 * Ending is final: nothing can revive an ended scope.
 */

import { systemMonotonicClock, type MonotonicClock } from './clock.ts';
import { currentScope } from './context.ts';
import { ScopeEndedError, type EndCause, type EndReason, type ScopeEndEvent } from './errors.ts';
import { minDeadline, parseRelativeDuration, type RelativeBudget } from './time.ts';

export type DeadlineOrigin = 'none' | 'own' | 'ancestor' | 'both';

let scopeCounter = 0;

export interface ScopeOptions {
  /**
   * Clock used for this scope. A child always shares its parent's clock; if
   * both are supplied they must be the identical object.
   */
  readonly clock?: MonotonicClock;
  /**
   * Parent scope. `undefined` means "the scope active in async context, if
   * any"; `null` explicitly creates a root scope.
   */
  readonly parent?: Scope | null;
  /** Relative budget received from the caller; resolved exactly at entry. */
  readonly budget?: RelativeBudget | null;
  /** Absolute deadline already expressed on this process's monotonic clock. */
  readonly deadline?: bigint | null;
  readonly label?: string;
  readonly onEnd?: (event: ScopeEndEvent) => void;
}

export class Scope {
  readonly id: string;
  readonly parent: Scope | null;
  readonly clock: MonotonicClock;
  readonly label: string | null;

  readonly #ownDeadline: bigint | null;
  readonly deadline: bigint | null;
  readonly deadlineOrigin: DeadlineOrigin;

  readonly #children = new Set<Scope>();
  readonly #cleanups = new Set<() => void>();
  readonly #listeners = new Set<(event: ScopeEndEvent) => void>();
  readonly #waiters: Array<(event: ScopeEndEvent) => void> = [];
  readonly #abort = new AbortController();

  #endState: ScopeEndEvent | null = null;

  constructor(options: ScopeOptions = {}) {
    const parent = options.parent === undefined ? (currentScope() ?? null) : options.parent;
    const clock = parent === null ? (options.clock ?? systemMonotonicClock) : parent.clock;

    if (parent !== null && options.clock !== undefined && options.clock !== parent.clock) {
      throw new TypeError('A child scope must use the same monotonic clock as its parent');
    }
    if (options.budget != null && options.deadline != null) {
      throw new TypeError('Pass either a relative budget or an absolute deadline, not both');
    }

    const now = clock.now();
    this.#ownDeadline =
      options.budget != null
        ? now + parseRelativeDuration(options.budget)
        : (options.deadline ?? null);
    if (this.#ownDeadline !== null) {
      if (typeof this.#ownDeadline !== 'bigint') {
        throw new TypeError('Absolute deadlines must be bigint nanosecond timestamps');
      }
      if (this.#ownDeadline < 0n) {
        throw new RangeError(`Deadline must be non-negative, got ${this.#ownDeadline}`);
      }
    }

    const inherited = parent === null ? null : parent.deadline;
    this.deadline = minDeadline(this.#ownDeadline, inherited);
    this.deadlineOrigin = describeOrigin(this.#ownDeadline, inherited, this.deadline);

    this.id = `scope-${++scopeCounter}`;
    this.parent = parent;
    this.clock = clock;
    this.label = options.label ?? null;

    if (options.onEnd !== undefined) {
      this.#listeners.add(options.onEnd);
    }

    const inheritedEnd = parent === null ? null : parent.endState;
    if (inheritedEnd !== null) {
      // A cancelled/expired parent can never produce a live child.
      this.#finish(inheritedEnd.reason, 'ancestor', inheritedEnd.atNanos);
      return;
    }

    if (parent !== null) {
      parent.#children.add(this);
    }

    if (this.deadline !== null && this.deadline <= now) {
      const cause: EndCause = this.deadlineOrigin === 'own' || this.deadlineOrigin === 'both'
        ? 'self'
        : 'ancestor';
      this.#finish('expired', cause, now);
    }
  }

  get endState(): ScopeEndEvent | null {
    return this.#endState;
  }

  get ended(): boolean {
    return this.#endState !== null;
  }

  /** Aborts when the scope ends; the reason is a `ScopeEndedError`. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /**
   * Remaining time in nanoseconds at this instant, or `null` when the scope
   * has no deadline. Once the scope has ended, remaining time is `0n`.
   * This is a pure query: it does not end an overdue scope.
   */
  remainingNanos(): bigint | null {
    if (this.#endState !== null) return 0n;
    if (this.deadline === null) return null;
    const remaining = this.deadline - this.clock.now();
    return remaining > 0n ? remaining : 0n;
  }

  /**
   * End the scope as expired if its deadline has been reached. `atNanos`
   * defaults to the clock's current reading but can be supplied by a caller
   * that already sampled the clock, so that budget arithmetic stays anchored
   * to one instant.
   */
  expireIfDue(atNanos: bigint = this.clock.now()): boolean {
    if (this.#endState !== null) return false;
    if (this.deadline === null || atNanos < this.deadline) return false;
    const cause: EndCause = this.deadlineOrigin === 'own' || this.deadlineOrigin === 'both'
      ? 'self'
      : 'ancestor';
    return this.#finish('expired', cause, atNanos);
  }

  /** Cancel this scope. Descendants end with cause `ancestor`. */
  cancel(): boolean {
    return this.#finish('cancelled', 'self', this.clock.now());
  }

  /** Complete this scope normally, releasing waiters and descendants. */
  complete(): boolean {
    return this.#finish('completed', 'self', this.clock.now());
  }

  /**
   * Open a child scope. Its deadline is the earlier of this scope's effective
   * deadline and its own requested budget/deadline. The parent defaults to
   * this scope (never to async context, which could be a different root).
   */
  createChild(options: Omit<ScopeOptions, 'parent'> = {}): Scope {
    if (options.clock !== undefined && options.clock !== this.clock) {
      throw new TypeError('A child scope must use the same monotonic clock as its parent');
    }
    return new Scope({ ...options, parent: this, clock: this.clock });
  }

  /**
   * Register a resource (timer, queued request, ...) to release when the
   * scope ends. If the scope has already ended the cleanup runs immediately.
   */
  addCleanup(cleanup: () => void): () => void {
    if (this.#endState !== null) {
      cleanup();
      return () => {};
    }
    this.#cleanups.add(cleanup);
    return () => {
      this.#cleanups.delete(cleanup);
    };
  }

  onEnd(listener: (event: ScopeEndEvent) => void): () => void {
    if (this.#endState !== null) {
      listener(this.#endState);
      return () => {};
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Resolves when the scope ends; ends immediately for an ended scope. */
  whenEnded(): Promise<ScopeEndEvent> {
    if (this.#endState !== null) {
      return Promise.resolve(this.#endState);
    }
    return new Promise<ScopeEndEvent>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #finish(reason: EndReason, cause: EndCause, atNanos: bigint): boolean {
    if (this.#endState !== null) return false;

    const event: ScopeEndEvent = Object.freeze({
      scopeId: this.id,
      reason,
      cause,
      atNanos,
    });
    this.#endState = event;

    if (this.parent !== null) {
      this.parent.#children.delete(this);
    }

    const cleanups = [...this.#cleanups];
    this.#cleanups.clear();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // A broken resource must not keep other resources or descendants alive.
      }
    }

    try {
      this.#abort.abort(new ScopeEndedError(event));
    } catch {
      // Abort listeners are user code; never let them block propagation.
    }

    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Isolate listener failures, same reasoning as cleanups.
      }
    }

    const waiters = this.#waiters.splice(0);
    for (const resolve of waiters) resolve(event);

    const children = [...this.#children];
    for (const child of children) {
      child.#finish(reason, 'ancestor', atNanos);
    }

    return true;
  }
}

function describeOrigin(
  own: bigint | null,
  inherited: bigint | null,
  effective: bigint | null,
): DeadlineOrigin {
  if (effective === null || own === null) {
    return effective === null ? 'none' : 'ancestor';
  }
  if (own !== effective) return 'ancestor';
  return inherited === own ? 'both' : 'own';
}

/** Open a scope; defaults to a root unless async context supplies a parent. */
export function openScope(options: ScopeOptions = {}): Scope {
  return new Scope(options);
}
