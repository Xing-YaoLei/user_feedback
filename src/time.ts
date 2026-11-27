/**
 * Exact-integer time helpers.
 *
 * Every duration and deadline in this package is a bigint count of
 * nanoseconds. No floating point arithmetic is ever used for protocol values,
 * deadline arithmetic or remaining-budget arithmetic.
 */

import { InvalidDurationError } from './errors.ts';

export const NS_PER_MICROSECOND = 1_000n;
export const NS_PER_MILLISECOND = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;
export const NS_PER_MINUTE = 60n * NS_PER_SECOND;
export const NS_PER_HOUR = 60n * NS_PER_MINUTE;

/** Protocol A: integer milliseconds, at most 2^31 - 1. */
export const PROTOCOL_A_MAX_MILLISECONDS = 2_147_483_647n;

/** Protocol B: at most eight decimal digits followed by a unit letter. */
export const PROTOCOL_B_MAX_VALUE = 99_999_999n;

export type DurationUnit = 'H' | 'M' | 'S' | 'm' | 'u' | 'n';

/**
 * All protocol-B units, from the finest to the coarsest. Order matters for
 * the "same duration, prefer the finer unit" tie-break when encoding.
 */
export const DURATION_UNITS: readonly DurationUnit[] = ['n', 'u', 'm', 'S', 'M', 'H'];

export const UNIT_NANOS: Readonly<Record<DurationUnit, bigint>> = {
  H: NS_PER_HOUR,
  M: NS_PER_MINUTE,
  S: NS_PER_SECOND,
  m: NS_PER_MILLISECOND,
  u: NS_PER_MICROSECOND,
  n: 1n,
};

export function isDurationUnit(value: unknown): value is DurationUnit {
  return (
    value === 'H' || value === 'M' || value === 'S' || value === 'm' || value === 'u' || value === 'n'
  );
}

/**
 * A relative budget in a shape that can be received from the wire: a
 * protocol-B style `{ value, unit }` object, a protocol-B string such as
 * `"250m"` or `"99999999n"`, or an exact bigint nanosecond count (useful when
 * the caller already decoded the budget itself).
 */
export interface RelativeDuration {
  readonly value: bigint;
  readonly unit: DurationUnit;
}

export type RelativeBudget = RelativeDuration | string | bigint;

const PROTOCOL_B_PATTERN = /^([0-9]{1,8})([HMSmun])$/;

/**
 * Convert a received relative budget into an exact nanosecond count.
 *
 * Rules:
 * - numeric values must be bigint; `number` is rejected so that no budget can
 *   silently pass through a float;
 * - protocol-B strings and objects are limited to eight digits, matching the
 *   wire format;
 * - negative values are rejected, zero is allowed (it means "already due").
 */
export function parseRelativeDuration(input: RelativeBudget): bigint {
  if (typeof input === 'bigint') {
    if (input < 0n) {
      throw new InvalidDurationError(`Duration must not be negative: ${input}n`);
    }
    return input;
  }

  if (typeof input === 'string') {
    const match = PROTOCOL_B_PATTERN.exec(input);
    if (match === null) {
      throw new InvalidDurationError(
        `Invalid protocol-B duration "${input}": expected 1-8 digits followed by H, M, S, m, u or n`,
      );
    }
    return BigInt(match[1]) * UNIT_NANOS[match[2] as DurationUnit];
  }

  if (typeof input === 'object' && input !== null) {
    const candidate = input as Partial<RelativeDuration>;
    if (typeof candidate.value !== 'bigint' || !isDurationUnit(candidate.unit)) {
      throw new InvalidDurationError(
        'Duration objects need an integer bigint value and a unit of H, M, S, m, u or n',
      );
    }
    if (candidate.value < 0n) {
      throw new InvalidDurationError(
        `Duration must not be negative: ${candidate.value}${candidate.unit}`,
      );
    }
    if (candidate.value > PROTOCOL_B_MAX_VALUE) {
      throw new InvalidDurationError(
        `Protocol-B values are limited to 8 digits (max ${PROTOCOL_B_MAX_VALUE}), got ${candidate.value}`,
      );
    }
    return candidate.value * UNIT_NANOS[candidate.unit];
  }

  throw new InvalidDurationError(
    'Duration must be a protocol-B string, { value, unit } object or bigint',
  );
}

/** Earliest of two optional absolute deadlines. */
export function minDeadline(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
