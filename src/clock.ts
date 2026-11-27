/**
 * Monotonic clock abstraction.
 *
 * Production code uses `process.hrtime.bigint()`, which is monotonic and
 * unaffected by wall-clock adjustments. Tests inject a controllable clock so
 * that a call can be "left in the adapter queue" for an exact number of
 * nanoseconds without sleeping.
 */

export interface MonotonicClock {
  /** Current monotonic time in nanoseconds. */
  now(): bigint;
}

export const systemMonotonicClock: MonotonicClock = {
  now: () => process.hrtime.bigint(),
};

/**
 * Deterministic clock for tests and simulations.
 *
 * `advance` is the only way time moves; it never moves backwards and accepts
 * exact nanosecond counts.
 */
export class ManualClock implements MonotonicClock {
  #now: bigint;

  constructor(startNanos: bigint = 0n) {
    if (startNanos < 0n) {
      throw new RangeError(`ManualClock start must be non-negative, got ${startNanos}`);
    }
    this.#now = startNanos;
  }

  now(): bigint {
    return this.#now;
  }

  advance(nanos: bigint): bigint {
    if (nanos < 0n) {
      throw new RangeError(`ManualClock cannot move backwards by ${nanos}ns`);
    }
    this.#now += nanos;
    return this.#now;
  }
}
