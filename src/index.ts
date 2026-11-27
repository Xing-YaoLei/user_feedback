/**
 * Public entry points.
 *
 * A caller that receives a relative budget (protocol A milliseconds or
 * protocol B `value+unit`) calls `beginCall` / `withCall`. The budget is
 * converted to an absolute deadline on this process's monotonic clock
 * immediately, at the moment the call enters. Everything downstream then works
 * with absolute monotonic deadlines, so queueing delay is charged to the
 * call's own budget instead of silently extending it.
 */

import { DeadlineDispatcher, type QueuedCall, type SubmitSpec } from './adapter.ts';
import { systemMonotonicClock, type MonotonicClock } from './clock.ts';
import { currentScope, runInScope } from './context.ts';
import { ScopeEndedError, type ScopeEndEvent } from './errors.ts';
import { encodeBudget } from './protocol.ts';
import { Scope, type ScopeOptions } from './scope.ts';
import { parseRelativeDuration, type RelativeBudget } from './time.ts';

export interface BeginCallOptions {
  /** Relative budget as received from the caller's protocol. */
  readonly budget?: RelativeBudget | null;
  /** Absolute deadline already on this process's monotonic clock. */
  readonly deadline?: bigint | null;
  readonly clock?: MonotonicClock;
  readonly label?: string;
  /**
   * Explicit parent scope. Omit to use the async-context scope if one exists
   * (or become a root when none does). `null` forces a root scope.
   */
  readonly parent?: Scope | null;
  /** Run as a root scope even if an ambient scope exists. */
  readonly root?: boolean;
  readonly onEnd?: (event: ScopeEndEvent) => void;
}

/**
 * Start a call scope from a received relative budget.
 *
 * `withCall` runs `fn` inside that scope (via AsyncLocalStorage), so concurrent
 * calls each get their own scope and are shielded from one another.
 */
export function beginCall(options: BeginCallOptions = {}): Scope {
  if (options.root === true && options.parent != null) {
    throw new TypeError('Pass either `root: true` or an explicit `parent`, not both');
  }
  const scopeOptions: ScopeOptions = {
    budget: options.budget ?? null,
    deadline: options.deadline ?? null,
    label: options.label,
    onEnd: options.onEnd,
  };
  if (options.clock !== undefined) scopeOptions.clock = options.clock;
  if (options.root === true) {
    scopeOptions.parent = null;
  } else if (options.parent !== undefined) {
    scopeOptions.parent = options.parent;
  }
  return new Scope(scopeOptions);
}

export async function withCall<T>(
  options: BeginCallOptions,
  fn: (scope: Scope) => Promise<T> | T,
): Promise<T> {
  const scope = beginCall(options);
  const alreadyEnded = scope.endState;
  if (alreadyEnded !== null) {
    // Inherited ends (parent cancelled/expired) and zero budgets both mean the
    // call must never run its body.
    throw new ScopeEndedError(alreadyEnded);
  }
  try {
    return await runInScope(scope, () => fn(scope));
  } finally {
    if (!scope.ended) scope.complete();
  }
}

/**
 * The timeout a call should put on an outbound request, given only a relative
 * budget and an already-absolute deadline. Provided for callers that manage
 * their own transport: it samples the clock exactly once, does not extend the
 * deadline, and reports `null` when nothing should be sent.
 */
export function outgoingTimeout(
  remainingNanos: bigint,
  protocol: 'A' | 'B',
): { readonly wire: string; readonly encodedNanos: bigint; readonly lossNanos: bigint } | null {
  try {
    const budget = encodeBudget(remainingNanos, protocol);
    return {
      wire: budget.protocol === 'A' ? String(budget.milliseconds) : budget.wire,
      encodedNanos: budget.encodedNanos,
      lossNanos: budget.lossNanos,
    };
  } catch {
    return null;
  }
}

export {
  DeadlineDispatcher,
  type CallStatus,
  type DispatchOutcome,
  type DispatcherOptions,
  type QueuedCall,
  type QueuedCallSpec,
  type SentOutcome,
  type SubmitSpec,
  type UnsentOutcome,
} from './adapter.ts';
export { ManualClock, systemMonotonicClock, type MonotonicClock } from './clock.ts';
export { currentScope, runInScope } from './context.ts';
export {
  ExpiredBudgetError,
  InsufficientBudgetError,
  InvalidDurationError,
  ScopeEndedError,
  type EndCause,
  type EndReason,
  type ScopeEndEvent,
} from './errors.ts';
export {
  encodeBudget,
  parseProtocolABudget,
  parseProtocolBBudget,
  toWireString,
  type EncodedBudget,
  type ProtocolABudget,
  type ProtocolBBudget,
  type ProtocolId,
} from './protocol.ts';
export { Scope, openScope, type DeadlineOrigin, type ScopeOptions } from './scope.ts';
export {
  DURATION_UNITS,
  PROTOCOL_A_MAX_MILLISECONDS,
  PROTOCOL_B_MAX_VALUE,
  UNIT_NANOS,
  parseRelativeDuration,
  type DurationUnit,
  type RelativeBudget,
  type RelativeDuration,
} from './time.ts';

/**
 * Convenience: enqueue one downstream call on a dispatcher, inheriting the
 * parent deadline and optionally requesting a tighter one. The returned call
 * is settled by the transport's dequeue notification.
 */
export function enqueueCall(dispatcher: DeadlineDispatcher, spec: SubmitSpec): QueuedCall {
  return dispatcher.submit(spec);
}

/** Open a scope for a call that arrived with only a relative budget. */
export function receiveCall(budget: RelativeBudget, options: Omit<BeginCallOptions, 'budget'> = {}): Scope {
  return beginCall({ ...options, budget });
}

/** Exact nanosecond reading from the process monotonic clock. */
export function nowNanos(clock: MonotonicClock = systemMonotonicClock): bigint {
  return clock.now();
}

/** Add an exact nanosecond duration to a monotonic timestamp. */
export function deadlineFrom(now: bigint, duration: RelativeBudget): bigint {
  return now + parseRelativeDuration(duration);
}

/** The active scope in async context, if any. */
export function activeScope(): Scope | undefined {
  return currentScope();
}
