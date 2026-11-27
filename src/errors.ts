/**
 * Errors and end-state vocabulary shared by scopes, clocks and the transport
 * adapter.
 */

import type { ProtocolId } from './protocol.ts';

export type EndReason = 'cancelled' | 'expired' | 'completed';

/**
 * `self` means the scope ended because of its own deadline or an explicit
 * cancel/complete. `ancestor` means the end was propagated down from a parent.
 */
export type EndCause = 'self' | 'ancestor';

export interface ScopeEndEvent {
  readonly scopeId: string;
  readonly reason: EndReason;
  readonly cause: EndCause;
  /** Monotonic-clock nanosecond timestamp at which the scope ended. */
  readonly atNanos: bigint;
}

export class InvalidDurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDurationError';
  }
}

export class ScopeEndedError extends Error {
  readonly scopeId: string;
  readonly reason: EndReason;
  readonly endCause: EndCause;
  readonly atNanos: bigint;

  constructor(event: ScopeEndEvent) {
    super(
      `Scope ${event.scopeId} already ended (${event.reason}, ${event.cause}) at ${event.atNanos}ns`,
    );
    this.name = 'ScopeEndedError';
    this.scopeId = event.scopeId;
    this.reason = event.reason;
    this.endCause = event.cause;
    this.atNanos = event.atNanos;
  }
}

/** No time left at all; the call must not be emitted. */
export class ExpiredBudgetError extends Error {
  readonly protocol: ProtocolId;
  readonly remainingNanos: bigint;

  constructor(protocol: ProtocolId, remainingNanos: bigint) {
    super(
      `Protocol ${protocol} cannot encode a non-positive budget (${remainingNanos}ns remain)`,
    );
    this.name = 'ExpiredBudgetError';
    this.protocol = protocol;
    this.remainingNanos = remainingNanos;
  }
}

/**
 * A positive budget exists, but it is smaller than the protocol's smallest
 * representable duration. This is always an explicit failure: encoding it as
 * zero would mean "no deadline" / an infinite wait on the wire.
 */
export class InsufficientBudgetError extends Error {
  readonly protocol: ProtocolId;
  readonly remainingNanos: bigint;
  readonly minimumNanos: bigint;

  constructor(protocol: ProtocolId, remainingNanos: bigint, minimumNanos: bigint) {
    super(
      `Protocol ${protocol} cannot represent a positive budget of ${remainingNanos}ns ` +
        `(smallest unit is ${minimumNanos}ns)`,
    );
    this.name = 'InsufficientBudgetError';
    this.protocol = protocol;
    this.remainingNanos = remainingNanos;
    this.minimumNanos = minimumNanos;
  }
}
