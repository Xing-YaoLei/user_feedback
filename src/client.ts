/**
 * Asynchronous RPC routing client.
 *
 * A call is resolved against a shared {@link Router}. Owners may answer with a
 * redirect hint instead of executing the request; the transport contract
 * guarantees that such an attempt was *not* executed, so it is safe to follow.
 *
 * - Permanent hints are merged into the shared table, per point, by
 *   generation, and every other call sees the result immediately.
 * - Temporary hints are used only by the call that received them and never
 *   enter the shared table.
 * - Redirect chains share one deadline and one attempt budget.
 * - Within one call the same `address + owner generation` pair is never
 *   attempted twice, so forwarding cycles terminate and are reported together
 *   with the addresses already contacted.
 * - A call that already succeeded returns its value; later routing changes
 *   cannot retroactively invalidate it.
 */

import {
  Router,
  validatePermanentHint,
  validateTemporaryHint,
  type OwnerHint,
  type PermanentHint,
  type RouteSegment,
  type TemporaryHint,
} from './router.ts';

/** Where the address used by an attempt came from. */
export type AttemptSource = 'route' | 'permanent-hint' | 'temporary-hint';

export type AttemptOutcome = 'ok' | 'redirect' | 'error';

/** One transport attempt made while resolving a call. */
export interface AttemptRecord {
  readonly address: string;
  /**
   * Owner generation associated with the attempted address, or `null` when the
   * address came from a temporary hint, which carries no generation.
   */
  readonly generation: number | null;
  readonly source: AttemptSource;
  readonly outcome: AttemptOutcome;
  /** Present when the attempt failed or was rejected. */
  readonly error?: string;
}

/** Request handed to the transport adapter. */
export interface TransportRequest<TPayload = unknown> {
  /** Owner address to send the request to. */
  readonly address: string;
  /** Unsigned 32-bit shard key. */
  readonly key: number;
  readonly payload: TPayload;
  /** 1-based index of this attempt within the call. */
  readonly attempt: number;
  /** Owner generation, or `null` when the address came from a temporary hint. */
  readonly generation: number | null;
}

/** The owner executed the request; this is a terminal, successful result. */
export interface ExecutedResponse<TValue = unknown> {
  readonly kind: 'ok';
  readonly value: TValue;
}

/**
 * The owner declined to execute the request and points elsewhere.
 * The transport contract guarantees the request was not executed.
 */
export interface RedirectResponse {
  readonly kind: 'redirect';
  readonly hint: OwnerHint;
}

export type TransportResponse<TValue = unknown> =
  | ExecutedResponse<TValue>
  | RedirectResponse;

/**
 * Caller-supplied transport. Implementations must only resolve to a redirect
 * when the request is guaranteed not to have been executed.
 */
export interface TransportAdapter {
  send(
    request: TransportRequest,
    signal: AbortSignal,
  ): Promise<TransportResponse>;
}

export type HintStatus =
  | 'applied'
  | 'stale'
  | 'conflict'
  | 'invalid'
  | 'followed';

/** Outcome of a hint observed during a call. */
export interface HintRecord {
  readonly kind: OwnerHint['kind'];
  readonly address: string;
  readonly generation?: number;
  readonly start?: number;
  readonly end?: number;
  readonly status: HintStatus;
  readonly message: string;
}

export type CallFailureReason =
  | 'cycle'
  | 'attempt-budget'
  | 'deadline'
  | 'transport-error'
  | 'malformed-response'
  | 'invalid-hint'
  | 'route-conflict';

export interface CallSuccess<TValue = unknown> {
  readonly ok: true;
  readonly value: TValue;
  /** Address that executed the request. */
  readonly address: string;
  /** Owner generation of that address, or `null` for a temporary hop. */
  readonly generation: number | null;
  readonly attempts: readonly AttemptRecord[];
  readonly hints: readonly HintRecord[];
}

export interface CallFailure {
  readonly ok: false;
  readonly reason: CallFailureReason;
  readonly message: string;
  /** Every address actually contacted, in order. */
  readonly attempts: readonly AttemptRecord[];
  /** Same addresses as {@link attempts}, as plain strings. */
  readonly attemptedAddresses: readonly string[];
  readonly hints: readonly HintRecord[];
  /** Last transport error, when the failure came from the transport. */
  readonly error?: unknown;
}

export type CallResult<TValue = unknown> = CallSuccess<TValue> | CallFailure;

export interface RoutingClientOptions {
  readonly router: Router;
  readonly transport: TransportAdapter;
  /** Total attempts allowed across the whole redirect chain. Default 8. */
  readonly maxAttempts?: number;
  /** Total wall-clock budget in milliseconds across the chain. Default 5000. */
  readonly deadlineMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface CallOptions {
  readonly maxAttempts?: number;
  readonly deadlineMs?: number;
}

interface NextAttempt {
  readonly address: string;
  readonly generation: number | null;
  readonly source: AttemptSource;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTimeout(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    value > 0 &&
    (Number.isFinite(value) || value === Number.POSITIVE_INFINITY)
  );
}

/**
 * De-duplication key for "address + owner generation".
 * A `null` generation is only produced by temporary hints.
 */
function comboKey(address: string, generation: number | null): string {
  return `${address}\u0000${generation === null ? '?' : generation}`;
}

function describeAttempt(next: NextAttempt): string {
  return next.generation === null
    ? next.address
    : `${next.address}@${next.generation}`;
}

export class RoutingClient {
  readonly #router: Router;
  readonly #transport: TransportAdapter;
  readonly #maxAttempts: number;
  readonly #deadlineMs: number;
  readonly #now: () => number;

  constructor(options: RoutingClientOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('RoutingClient options are required');
    }
    if (!(options.router instanceof Router)) {
      throw new TypeError('options.router must be a Router instance');
    }
    if (
      options.transport === null ||
      typeof options.transport !== 'object' ||
      typeof options.transport.send !== 'function'
    ) {
      throw new TypeError('options.transport must implement send()');
    }

    const maxAttempts = options.maxAttempts ?? 8;
    if (!isPositiveInteger(maxAttempts)) {
      throw new TypeError('maxAttempts must be a positive integer');
    }

    const deadlineMs = options.deadlineMs ?? 5000;
    if (!isTimeout(deadlineMs)) {
      throw new TypeError('deadlineMs must be a positive number');
    }

    this.#router = options.router;
    this.#transport = options.transport;
    this.#maxAttempts = maxAttempts;
    this.#deadlineMs = deadlineMs;
    this.#now = options.now ?? Date.now;
  }

  /** Shared routing table observed and updated by this client. */
  get router(): Router {
    return this.#router;
  }

  /**
   * Resolve and execute one call.
   *
   * @param key unsigned 32-bit shard key
   * @throws RangeError when `key` is outside [0, 2^32)
   */
  async call<TValue = unknown, TPayload = unknown>(
    key: number,
    payload: TPayload,
    options: CallOptions = {},
  ): Promise<CallResult<TValue>> {
    // Validates the key and captures the initial owner.
    let pending: NextAttempt | null = this.#routeFor(key);

    const effectiveOptions: CallOptions =
      options === null || typeof options !== 'object' ? {} : options;

    const maxAttempts = effectiveOptions.maxAttempts ?? this.#maxAttempts;
    if (!isPositiveInteger(maxAttempts)) {
      throw new TypeError('maxAttempts must be a positive integer');
    }

    const deadlineMs = effectiveOptions.deadlineMs ?? this.#deadlineMs;
    if (!isTimeout(deadlineMs)) {
      throw new TypeError('deadlineMs must be a positive number');
    }

    const deadlineAt =
      deadlineMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : this.#now() + deadlineMs;

    const attempts: AttemptRecord[] = [];
    const hints: HintRecord[] = [];
    // De-duplication is per call, keyed by address + owner generation, so a
    // cycle always terminates. Temporary hops carry no generation; they are
    // keyed by address with an empty generation, which still catches loops.
    const seen = new Set<string>();

    // Explains why a redirect could not move this key forward, so cycle reports
    // are actionable instead of merely repetitive.
    let blockedReason: string | undefined;

    const record = (
      target: NextAttempt,
      outcome: AttemptOutcome,
      error?: string,
    ): void => {
      attempts.push({
        address: target.address,
        generation: target.generation,
        source: target.source,
        outcome,
        ...(error === undefined ? {} : { error }),
      });
    };

    const fail = (
      reason: CallFailureReason,
      message: string,
      error?: unknown,
    ): CallFailure => {
      const copy = [...attempts];
      const base = {
        ok: false as const,
        reason,
        message,
        attempts: copy,
        attemptedAddresses: copy.map((attempt) => attempt.address),
        hints: [...hints],
      };
      return error === undefined ? base : { ...base, error };
    };

    for (;;) {
      // A temporary hint pins exactly one hop. Otherwise the key is resolved
      // again on every round, so this call also picks up permanent hints that
      // concurrent calls learned while it was in flight.
      const target: NextAttempt = pending ?? this.#routeFor(key);
      pending = null;

      const combo = comboKey(target.address, target.generation);
      if (seen.has(combo)) {
        return fail(
          'cycle',
          `forwarding cycle: ${describeAttempt(target)} was already attempted` +
            (blockedReason === undefined ? '' : ` (${blockedReason})`),
        );
      }
      if (attempts.length >= maxAttempts) {
        return fail(
          'attempt-budget',
          `attempt budget of ${maxAttempts} exhausted; ` +
            `next would have been ${describeAttempt(target)}`,
        );
      }
      if (this.#now() >= deadlineAt) {
        return fail(
          'deadline',
          `deadline of ${deadlineMs}ms exhausted after ${attempts.length} attempts; ` +
            `next would have been ${describeAttempt(target)}`,
        );
      }

      seen.add(combo);

      const controller = new AbortController();
      const timer = this.#armDeadline(controller, deadlineAt);

      let raw: unknown;
      try {
        raw = await this.#transport.send(
          {
            address: target.address,
            key,
            payload,
            attempt: attempts.length + 1,
            generation: target.generation,
          },
          controller.signal,
        );
      } catch (error) {
        // Attribute the failure to the deadline only when our timer fired or
        // the injected clock says the budget is gone; otherwise it is a plain
        // transport error from the adapter.
        const timedOut =
          controller.signal.aborted ||
          (deadlineAt !== Number.POSITIVE_INFINITY && this.#now() >= deadlineAt);
        record(
          target,
          'error',
          error instanceof Error ? error.message : String(error),
        );
        return timedOut
          ? fail(
              'deadline',
              `deadline of ${deadlineMs}ms exhausted while waiting for ` +
                describeAttempt(target),
              error,
            )
          : fail(
              'transport-error',
              `transport failed for ${describeAttempt(target)}`,
              error,
            );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      // A response that arrives is honoured even at the deadline boundary: an
      // executed result must never be discarded, and a redirect still carries
      // useful routing information. The deadline is re-checked before the next
      // attempt instead.
      const response = raw as Partial<TransportResponse> | null;

      if (response === null || typeof response !== 'object') {
        record(target, 'error', 'transport returned a non-object response');
        return fail(
          'malformed-response',
          `transport returned a non-object response (from ${describeAttempt(target)})`,
        );
      }

      if (response.kind === 'ok') {
        // Terminal: the value is kept even if routing changes afterwards.
        record(target, 'ok');
        return {
          ok: true,
          value: response.value as TValue,
          address: target.address,
          generation: target.generation,
          attempts: [...attempts],
          hints: [...hints],
        };
      }

      if (response.kind !== 'redirect') {
        const kind = String((response as { kind?: unknown }).kind);
        record(target, 'error', `unknown response kind ${kind}`);
        return fail(
          'malformed-response',
          `unknown response kind ${kind} (from ${describeAttempt(target)})`,
        );
      }

      const hint = (response as RedirectResponse).hint;
      if (hint === null || typeof hint !== 'object') {
        record(target, 'error', 'redirect carried no hint');
        return fail(
          'malformed-response',
          `redirect carried no hint (from ${describeAttempt(target)})`,
        );
      }

      if (hint.kind === 'temporary') {
        const invalidReason = validateTemporaryHint(hint as TemporaryHint);
        if (invalidReason !== null) {
          hints.push({
            kind: 'temporary',
            address:
              typeof (hint as TemporaryHint).address === 'string'
                ? (hint as TemporaryHint).address
                : '',
            status: 'invalid',
            message: invalidReason,
          });
          record(target, 'error', invalidReason);
          return fail(
            'invalid-hint',
            `invalid temporary hint from ${describeAttempt(target)}: ${invalidReason}`,
          );
        }

        const temporary: TemporaryHint = hint as TemporaryHint;
        hints.push({
          kind: 'temporary',
          address: temporary.address,
          status: 'followed',
          message: `forwarding this call only to ${temporary.address}`,
        });
        record(target, 'redirect');

        // Never written to the shared table. A temporary hint names an address
        // but not an owner generation, so the hop is de-duplicated by address
        // alone (generation `null`) rather than guessing one from the table.
        pending = {
          address: temporary.address,
          generation: null,
          source: 'temporary-hint',
        };
        continue;
      }

      if (hint.kind === 'permanent') {
        const invalidReason = validatePermanentHint(hint as PermanentHint);
        if (invalidReason !== null) {
          hints.push({
            kind: 'permanent',
            address:
              typeof (hint as PermanentHint).address === 'string'
                ? (hint as PermanentHint).address
                : '',
            status: 'invalid',
            message: invalidReason,
          });
          record(target, 'error', invalidReason);
          return fail(
            'invalid-hint',
            `invalid permanent hint from ${describeAttempt(target)}: ${invalidReason}`,
          );
        }

        const permanent: PermanentHint = hint as PermanentHint;
        const applied = this.#router.applyPermanentHint(permanent);
        hints.push({
          kind: 'permanent',
          address: permanent.address,
          generation: permanent.generation,
          start: permanent.start,
          end: permanent.end,
          status: applied.status,
          message: applied.message,
        });

        if (applied.status === 'conflict' || applied.status === 'invalid') {
          record(target, 'error', applied.message);
          return fail(
            applied.status === 'conflict' ? 'route-conflict' : 'invalid-hint',
            applied.message,
          );
        }

        record(target, 'redirect');

        // Judge this key by its own range and generation, never by a global
        // generation counter: a hint for one range must not be ignored just
        // because a disjoint range already learned a higher generation. The
        // table is the source of truth, so re-resolving also follows a newer
        // local owner when the hint was stale, and leaves the key where it was
        // when the hint does not cover it.
        if (applied.status === 'stale') {
          blockedReason =
            `hint ${permanent.address}@${permanent.generation} was not newer ` +
            `than the route covering key ${key}`;
        } else if (key < permanent.start || key >= permanent.end) {
          blockedReason =
            `hint range [${permanent.start}, ${permanent.end}) does not cover ` +
            `key ${key}, so the table is unchanged for this key`;
        } else {
          blockedReason = `the table already routed key ${key} to ${describeAttempt(target)}`;
        }

        // Re-resolve the key from the table, which is now the source of truth.
        // If the route changed, the next attempt is directly attributable to
        // the hint that was just adopted; if it did not change, the same
        // owner/generation pair repeats and the loop terminates as a cycle.
        const route: RouteSegment = this.#router.lookup(key);
        const routeCombo = comboKey(route.address, route.generation);
        if (routeCombo !== combo) {
          blockedReason = undefined;
          pending = {
            address: route.address,
            generation: route.generation,
            source: 'permanent-hint',
          };
        } else {
          pending = null;
        }
        continue;      }

      record(target, 'error', `unknown hint kind ${String((hint as OwnerHint).kind)}`);
      return fail(
        'malformed-response',
        `unknown hint kind ${String((hint as OwnerHint).kind)} ` +
          `(from ${describeAttempt(target)})`,
      );
    }
  }

  #routeFor(key: number): NextAttempt {
    const segment: RouteSegment = this.#router.lookup(key);
    return {
      address: segment.address,
      generation: segment.generation,
      source: 'route',
    };
  }

  #armDeadline(
    controller: AbortController,
    deadlineAt: number,
  ): ReturnType<typeof setTimeout> | undefined {
    if (deadlineAt === Number.POSITIVE_INFINITY) return undefined;
    // setTimeout clamps and warns above 2^31-1 ms; clamp explicitly.
    const MAX_TIMER = 2_147_483_647;
    const remaining = Math.min(MAX_TIMER, Math.max(0, deadlineAt - this.#now()));
    return setTimeout(() => {
      controller.abort(new Error('deadline exceeded'));
    }, remaining);
  }
}
