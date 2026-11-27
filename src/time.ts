/**
 * Exact nanosecond time handling.
 *
 * Nanoseconds are carried as `bigint` so deadlines beyond
 * `Number.MAX_SAFE_INTEGER` stay exact.  A `number` argument is accepted only
 * when it is a safe integer.
 */
export type TimeInput = bigint | number;

/** Convert a user-supplied time to exact bigint nanoseconds. */
export function toNanoseconds(value: TimeInput, label = 'time'): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(
      `${label} must be a bigint or a safe-integer number of nanoseconds; received ${String(value)}`,
    );
  }
  return BigInt(value);
}
