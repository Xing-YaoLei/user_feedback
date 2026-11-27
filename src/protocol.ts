/**
 * Wire encodings for the two downstream protocols.
 *
 * Both encoders are "round inward": the encoded duration is always less than
 * or equal to the true remaining time. A value that rounds up would push the
 * child deadline past the parent's deadline, which is exactly the bug this
 * package exists to prevent.
 */

import { InsufficientBudgetError, ExpiredBudgetError, InvalidDurationError } from './errors.ts';
import {
  DURATION_UNITS,
  PROTOCOL_A_MAX_MILLISECONDS,
  PROTOCOL_B_MAX_VALUE,
  UNIT_NANOS,
  parseRelativeDuration,
  type DurationUnit,
} from './time.ts';

export type ProtocolId = 'A' | 'B';

export interface ProtocolABudget {
  readonly protocol: 'A';
  /** Whole milliseconds, never above 2^31 - 1. */
  readonly milliseconds: number;
  readonly encodedNanos: bigint;
  /** How much representable time was given up by rounding down. */
  readonly lossNanos: bigint;
}

export interface ProtocolBBudget {
  readonly protocol: 'B';
  /** Integer digit count is at most eight. */
  readonly value: number;
  readonly unit: DurationUnit;
  readonly wire: string;
  readonly encodedNanos: bigint;
  readonly lossNanos: bigint;
}

export type EncodedBudget = ProtocolABudget | ProtocolBBudget;

/**
 * Encode a positive remaining budget for `protocol`.
 *
 * Protocol A has millisecond granularity, so a positive budget below 1ms can
 * only be encoded as `0`, which means "no deadline" on the wire. That case is
 * rejected with `InsufficientBudgetError` rather than turned into an infinite
 * wait. A budget that has already reached zero is rejected with
 * `ExpiredBudgetError`; callers must not send it at all.
 *
 * Protocol B has a nanosecond unit, so every positive integer nanosecond
 * budget is representable; the encoder still validates and throws if that
 * ever stops being true.
 */
export function encodeBudget(remainingNanos: bigint, protocol: ProtocolId): EncodedBudget {
  if (remainingNanos <= 0n) {
    throw new ExpiredBudgetError(protocol, remainingNanos);
  }

  if (protocol === 'A') {
    return encodeProtocolA(remainingNanos);
  }
  if (protocol === 'B') {
    return encodeProtocolB(remainingNanos);
  }
  throw new RangeError(`Unknown protocol: ${String(protocol)}`);
}

function encodeProtocolA(remainingNanos: bigint): ProtocolABudget {
  const milliseconds = remainingNanos / 1_000_000n;

  if (milliseconds <= 0n) {
    // 1..999_999 ns are positive but below the smallest A unit.
    throw new InsufficientBudgetError('A', remainingNanos, 1_000_000n);
  }

  const clamped = milliseconds > PROTOCOL_A_MAX_MILLISECONDS ? PROTOCOL_A_MAX_MILLISECONDS : milliseconds;
  const encodedNanos = clamped * 1_000_000n;
  return {
    protocol: 'A',
    milliseconds: Number(clamped),
    encodedNanos,
    lossNanos: remainingNanos - encodedNanos,
  };
}

function encodeProtocolB(remainingNanos: bigint): ProtocolBBudget {
  let bestUnit: DurationUnit | null = null;
  let bestValue = 0n;
  let bestEncoded = 0n;

  // DURATION_UNITS is ordered fine -> coarse, so a strict `>` comparison keeps
  // the finer unit when two units encode the same duration.
  for (const unit of DURATION_UNITS) {
    const unitNanos = UNIT_NANOS[unit];
    if (remainingNanos < unitNanos) {
      continue;
    }
    let value = remainingNanos / unitNanos;
    if (value > PROTOCOL_B_MAX_VALUE) {
      value = PROTOCOL_B_MAX_VALUE;
    }
    const encoded = value * unitNanos;
    if (bestUnit === null || encoded > bestEncoded) {
      bestUnit = unit;
      bestValue = value;
      bestEncoded = encoded;
    }
  }

  if (bestUnit === null) {
    // No protocol-B unit is small enough for this positive budget.
    throw new InsufficientBudgetError('B', remainingNanos, 1n);
  }

  return {
    protocol: 'B',
    value: Number(bestValue),
    unit: bestUnit,
    wire: `${bestValue}${bestUnit}`,
    encodedNanos: bestEncoded,
    lossNanos: remainingNanos - bestEncoded,
  };
}

/** Render an encoded budget as the literal sent on the wire. */
export function toWireString(budget: EncodedBudget): string {
  return budget.protocol === 'A' ? String(budget.milliseconds) : budget.wire;
}

/**
 * Decode a budget received in protocol A.
 *
 * Protocol A carries an integer millisecond count no greater than
 * 2^31 - 1. `number` inputs must be integers; `bigint` and decimal `string`
 * inputs are accepted so the boundary value can be handled exactly.
 * Returns an exact nanosecond count.
 */
export function parseProtocolABudget(input: number | bigint | string): bigint {
  let milliseconds: bigint;
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new InvalidDurationError(`Protocol A budgets must be whole milliseconds, got ${input}`);
    }
    milliseconds = BigInt(input);
  } else if (typeof input === 'bigint') {
    milliseconds = input;
  } else if (typeof input === 'string' && /^[0-9]+$/.test(input)) {
    milliseconds = BigInt(input);
  } else {
    throw new InvalidDurationError(
      `Protocol A budget must be a whole millisecond count, got ${String(input)}`,
    );
  }

  if (milliseconds < 0n) {
    throw new InvalidDurationError(`Protocol A budget must not be negative: ${milliseconds}`);
  }
  if (milliseconds > PROTOCOL_A_MAX_MILLISECONDS) {
    throw new InvalidDurationError(
      `Protocol A budgets are limited to ${PROTOCOL_A_MAX_MILLISECONDS}ms, got ${milliseconds}`,
    );
  }
  return milliseconds * 1_000_000n;
}

/**
 * Decode a budget received in protocol B (`1-8 digits` + unit). Returns an
 * exact nanosecond count.
 */
export function parseProtocolBBudget(wire: string): bigint {
  if (typeof wire !== 'string') {
    throw new InvalidDurationError('Protocol B budgets must be strings such as "250m"');
  }
  return parseRelativeDuration(wire);
}

