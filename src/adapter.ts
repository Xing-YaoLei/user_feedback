/**
 * Transport adapter boundary.
 *
 * A queued call is *not* assigned an outgoing timeout when it is enqueued.
 * The transport adapter calls `dispatch()` at the instant the call actually
 * leaves the queue and is handed to the network; only then is the remaining
 * time sampled, and only then is the wire budget produced from that exact
 * remaining amount. Time spent waiting in the queue therefore always comes
 * out of the call's own budget.
 *
 * Calls whose scope ended (cancelled, expired, completed) are never sent, no
 * matter how late the dequeue notification arrives, and a late notification
 * never revives a scope.
 */

import { systemMonotonicClock, type MonotonicClock } from './clock.ts';
import {
  ExpiredBudgetError,
  InsufficientBudgetError,
  type ScopeEndEvent,
} from './errors.ts';
import { encodeBudget, toWireString, type EncodedBudget, type ProtocolId } from './protocol.ts';
import type { RelativeBudget } from './time.ts';
import type { Scope } from './scope.ts';

export type CallStatus =
  | 'queued'
  | 'sent'
  | 'expired'
  | 'cancelled'
  | 'completed'
  | 'insufficient'
  | 'no-deadline';

export interface SentOutcome {
  readonly status: 'sent';
  readonly callId: string;
  readonly protocol: ProtocolId;
  /** Wire representation, e.g. `"250"` (A) or `"250m"` (B). */
  readonly wire: string;
  readonly budget: EncodedBudget;
  readonly remainingNanos: bigint;
  readonly dispatchedAtNanos: bigint;
}

export interface UnsentOutcome {
  readonly status: 'expired' | 'cancelled' | 'completed' | 'insufficient' | 'no-deadline';
  readonly callId: string;
  readonly protocol: ProtocolId;
  readonly remainingNanos: bigint | null;
  readonly dispatchedAtNanos: bigint;
  readonly endState: ScopeEndEvent | null;
  /** Only present for `status === 'insufficient'`. */
  readonly minimumNanos?: bigint;
}

export type DispatchOutcome = SentOutcome | UnsentOutcome;

export type { ScopeEndEvent };

export interface QueuedCallSpec {
  /** The call's own scope; its deadline is already min(parent, own). */
  readonly scope: Scope;
  readonly protocol: ProtocolId;
  readonly payload?: unknown;
  readonly label?: string;
}

export interface SubmitSpec {
  readonly parent: Scope;
  readonly protocol: ProtocolId;
  /**
   * The deadline this call itself requires. `null`/omitted means it only
   * inherits the parent's deadline.
   */
  readonly budget?: RelativeBudget | null;
  /** Absolute deadline (monotonic ns) required by this call. */
  readonly deadline?: bigint | null;
  readonly payload?: unknown;
  readonly label?: string;
}

export interface DispatcherOptions {
  readonly clock?: MonotonicClock;
  readonly onSend?: (outcome: SentOutcome, call: QueuedCall) => void;
  readonly onExpire?: (outcome: UnsentOutcome, call: QueuedCall) => void;
  /** Override timer primitives; used for resource-cleanup tests. */
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /**
   * `'auto'` (default) arms real timers only when the clock is the system
   * monotonic clock; a manual clock never has its deadlines driven by wall
   * time. `true` forces timers, `false` disables them.
   */
  readonly deadlineTimers?: boolean | 'auto';
}

const MAX_TIMER_MILLISECONDS = 2_147_483_647n;

export class QueuedCall {
  readonly id: string;
  readonly scope: Scope;
  readonly protocol: ProtocolId;
  readonly payload: unknown;
  readonly label: string | null;
  readonly enqueuedAtNanos: bigint;

  #status: CallStatus = 'queued';
  #outcome: DispatchOutcome | null = null;
  #timer: unknown = undefined;

  constructor(id: string, spec: QueuedCallSpec, enqueuedAtNanos: bigint) {
    this.id = id;
    this.scope = spec.scope;
    this.protocol = spec.protocol;
    this.payload = spec.payload;
    this.label = spec.label ?? null;
    this.enqueuedAtNanos = enqueuedAtNanos;
  }

  get status(): CallStatus {
    return this.#status;
  }

  /** The settled outcome, once dispatched or released. */
  get outcome(): DispatchOutcome | null {
    return this.#outcome;
  }

  /** @internal Settles the call; a settled outcome is never replaced. */
  setOutcomeInternal(outcome: DispatchOutcome): void {
    this.#outcome = outcome;
    this.#status = outcome.status;
  }

  /** @internal */
  get timerInternal(): unknown {
    return this.#timer;
  }

  /** @internal */
  set timerInternal(handle: unknown) {
    this.#timer = handle;
  }
}

let callCounter = 0;

export class DeadlineDispatcher {
  readonly clock: MonotonicClock;
  readonly #queue: QueuedCall[] = [];
  readonly #onSend?: (outcome: SentOutcome, call: QueuedCall) => void;
  readonly #onExpire?: (outcome: UnsentOutcome, call: QueuedCall) => void;
  readonly #setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #timersEnabled: boolean;

  constructor(options: DispatcherOptions = {}) {
    this.clock = options.clock ?? systemMonotonicClock;
    this.#onSend = options.onSend;
    this.#onExpire = options.onExpire;
    this.#setTimer =
      options.setTimer ??
      ((callback, milliseconds) => {
        const handle = setTimeout(callback, milliseconds);
        if (typeof (handle as { unref?: unknown }).unref === 'function') {
          (handle as { unref: () => void }).unref();
        }
        return handle;
      });
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const timers = options.deadlineTimers ?? 'auto';
    this.#timersEnabled =
      timers === 'auto' ? this.clock === systemMonotonicClock : timers;
  }

  /** Calls still waiting in the adapter queue, in FIFO order. */
  get pending(): readonly QueuedCall[] {
    return this.#queue;
  }

  /** Create a child scope for the call and place it on the queue. */
  submit(spec: SubmitSpec): QueuedCall {
    const child = spec.parent.createChild({
      budget: spec.budget ?? null,
      deadline: spec.deadline ?? null,
      label: spec.label,
    });
    return this.enqueue({
      scope: child,
      protocol: spec.protocol,
      payload: spec.payload,
      label: spec.label,
    });
  }

  enqueue(spec: QueuedCallSpec): QueuedCall {
    const call = new QueuedCall(`call-${++callCounter}`, spec, this.clock.now());
    this.#queue.push(call);

    // Ending the scope releases the queue slot and the deadline timer.
    call.scope.addCleanup(() => {
      this.#removeFromQueue(call);
      this.#clearDeadlineTimer(call);
      if (call.status === 'queued') {
        this.#settleUnsent(call, this.#outcomeForEndedScope(call, this.clock.now()));
      }
    });

    this.#armDeadlineTimer(call);
    return call;
  }

  /**
   * Called by the transport adapter when the call truly leaves the queue.
   * Samples the clock, computes remaining time from the call's absolute
   * deadline, and only then encodes the outgoing budget.
   */
  dispatch(call: QueuedCall): DispatchOutcome {
    const settled = call.outcome;
    if (settled !== null && call.status !== 'queued') {
      return settled;
    }

    const now = this.clock.now();
    call.scope.expireIfDue(now);

    if (call.scope.ended) {
      const outcome = this.#outcomeForEndedScope(call, now);
      return call.outcome ?? this.#settleUnsent(call, outcome);
    }

    const deadline = call.scope.deadline;
    if (deadline === null) {
      return this.#settleUnsent(call, {
        status: 'no-deadline',
        callId: call.id,
        protocol: call.protocol,
        remainingNanos: null,
        dispatchedAtNanos: now,
        endState: null,
      });
    }

    const remaining = deadline - now;
    if (remaining <= 0n) {
      // expireIfDue should have ended the scope; this is a defensive path.
      return this.#settleUnsent(call, {
        status: 'expired',
        callId: call.id,
        protocol: call.protocol,
        remainingNanos: 0n,
        dispatchedAtNanos: now,
        endState: call.scope.endState,
      });
    }

    let budget: EncodedBudget;
    try {
      budget = encodeBudget(remaining, call.protocol);
    } catch (error) {
      if (error instanceof InsufficientBudgetError) {
        return this.#settleUnsent(call, {
          status: 'insufficient',
          callId: call.id,
          protocol: call.protocol,
          remainingNanos: remaining,
          dispatchedAtNanos: now,
          endState: call.scope.endState,
          minimumNanos: error.minimumNanos,
        });
      }
      if (error instanceof ExpiredBudgetError) {
        return this.#settleUnsent(call, {
          status: 'expired',
          callId: call.id,
          protocol: call.protocol,
          remainingNanos: remaining,
          dispatchedAtNanos: now,
          endState: call.scope.endState,
        });
      }
      throw error;
    }

    // Defence in depth: rounding must never grow the budget.
    if (budget.encodedNanos > remaining) {
      throw new Error(
        `Internal invariant violated: protocol ${call.protocol} encoded ${budget.encodedNanos}ns ` +
          `from only ${remaining}ns remaining`,
      );
    }

    this.#removeFromQueue(call);
    this.#clearDeadlineTimer(call);

    const outcome: SentOutcome = {
      status: 'sent',
      callId: call.id,
      protocol: call.protocol,
      wire: toWireString(budget),
      budget,
      remainingNanos: remaining,
      dispatchedAtNanos: now,
    };
    call.setOutcomeInternal(outcome);
    this.#onSend?.(outcome, call);
    return outcome;
  }

  /** Dispatch the call at the head of the queue, if any. */
  dispatchNext(): DispatchOutcome | null {
    const next = this.#queue[0];
    if (next === undefined) return null;
    return this.dispatch(next);
  }

  /** Remove a call without sending it (e.g. the caller aborted the request). */
  abandon(call: QueuedCall): DispatchOutcome | null {
    if (call.status !== 'queued') return call.outcome;
    // Completing the scope runs the cleanup registered in `enqueue`, which
    // removes the queue slot, clears the timer and settles the call.
    if (!call.scope.ended) call.scope.complete();
    return call.outcome;
  }

  #outcomeForEndedScope(call: QueuedCall, atNanos: bigint): UnsentOutcome {
    const endState = call.scope.endState;
    const status: UnsentOutcome['status'] =
      endState === null
        ? 'cancelled'
        : endState.reason === 'expired'
          ? 'expired'
          : endState.reason === 'completed'
            ? 'completed'
            : 'cancelled';
    return {
      status,
      callId: call.id,
      protocol: call.protocol,
      remainingNanos: call.scope.remainingNanos(),
      dispatchedAtNanos: atNanos,
      endState,
    };
  }

  #settleUnsent(call: QueuedCall, outcome: UnsentOutcome): UnsentOutcome {
    this.#removeFromQueue(call);
    this.#clearDeadlineTimer(call);
    call.setOutcomeInternal(outcome);
    this.#onExpire?.(outcome, call);
    return outcome;
  }

  #removeFromQueue(call: QueuedCall): void {
    const index = this.#queue.indexOf(call);
    if (index >= 0) this.#queue.splice(index, 1);
  }

  #armDeadlineTimer(call: QueuedCall): void {
    if (!this.#timersEnabled || call.scope.ended) return;
    const deadline = call.scope.deadline;
    if (deadline === null) return;

    const remaining = deadline - this.clock.now();
    if (remaining <= 0n) return;

    // Round up: a timer must never fire before the deadline.
    const milliseconds = (remaining + 999_999n) / 1_000_000n;
    if (milliseconds > MAX_TIMER_MILLISECONDS) return; // far-future deadline

    const handle = this.#setTimer(() => {
      if (call.status !== 'queued') return;
      call.timerInternal = undefined;
      const now = this.clock.now();
      call.scope.expireIfDue(now);
      if (call.status !== 'queued') return; // the scope end settled it

      if (call.scope.deadline !== null && now < call.scope.deadline) {
        // The timer fired early (setTimeout is not exact). Never expire a
        // call before its actual deadline; wait for the remainder instead.
        this.#armDeadlineTimer(call);
        return;
      }

      this.#settleUnsent(call, {
        status: 'expired',
        callId: call.id,
        protocol: call.protocol,
        remainingNanos: 0n,
        dispatchedAtNanos: now,
        endState: call.scope.endState,
      });
    }, Number(milliseconds));
    call.timerInternal = handle;
  }

  #clearDeadlineTimer(call: QueuedCall): void {
    const handle = call.timerInternal;
    if (handle !== undefined) {
      call.timerInternal = undefined;
      this.#clearTimer(handle);
    }
  }
}
