/**
 * Clock and clock-skew helpers.
 *
 * Every physical clock reading is an approximation of one shared true
 * timeline.  The caller supplies an upper bound `maxSkewMs` on the deviation
 * between any node clock and the coordinator clock:
 *
 *     |nodeReading - coordinatorReading| <= skewMs
 *
 * All lease and window decisions in this project are made conservatively with
 * respect to that bound:
 *
 *   - a lease is usable by a node only while `reading - skew >= windowStart`
 *     (the operation cannot have happened before the window) and
 *     `reading + skew <= expiresAt` (the operation cannot have happened after
 *     the lease deadline);
 *   - the coordinator only grants leases that still leave at least
 *     `2 * skew` of usable lifetime and never extend past
 *     `windowEnd - skew`, so the node-side check above always implies the real
 *     operation happened strictly inside the fixed window.
 *
 * No code compares timestamps from different clocks for equality.  Timestamps
 * only ever feed the interval arithmetic below.
 */

export interface Clock {
  /** Current wall-clock reading in milliseconds. */
  now(): number;
}

/** A mutable clock with an explicit value (used by tests and simulations). */
export class ManualClock implements Clock {
  private valueMs: number;

  constructor(startMs = 0) {
    this.valueMs = startMs;
  }

  now(): number {
    return this.valueMs;
  }

  advance(ms: number): void {
    this.valueMs += ms;
  }

  set(ms: number): void {
    this.valueMs = ms;
  }
}

/**
 * A clock that follows a shared true-time source with a fixed offset.
 * Used to model node clock skew in the simulation.
 */
export class OffsetClock implements Clock {
  private readonly source: Clock;
  private readonly offsetMs: number;

  constructor(source: Clock, offsetMs = 0) {
    this.source = source;
    this.offsetMs = offsetMs;
  }

  now(): number {
    return this.source.now() + this.offsetMs;
  }
}

/** A frozen clock useful for pure boundary tests. */
export class FixedClock implements Clock {
  private readonly at: number;

  constructor(at: number) {
    this.at = at;
  }

  now(): number {
    return this.at;
  }
}

/** The interval of true time consistent with a single clock reading. */
export interface TimeInterval {
  earliest: number;
  latest: number;
}

export function readingInterval(reading: number, maxSkewMs: number): TimeInterval {
  return { earliest: reading - maxSkewMs, latest: reading + maxSkewMs };
}

/**
 * Conservative "definitely passed" test: even the *latest* true time
 * consistent with `reading` has reached `boundary`.  Used for deadlines.
 */
export function definitelyAtOrAfter(reading: number, boundary: number, maxSkewMs: number): boolean {
  return reading + maxSkewMs >= boundary;
}

/**
 * Conservative "definitely started" test: even the *earliest* true time
 * consistent with `reading` is already at or beyond `boundary`.  Note this is
 * the reverse margin from `definitelyAtOrAfter`: it is used when a value must
 * not be used before an interval begins.
 */
export function definitelyStarted(reading: number, boundary: number, maxSkewMs: number): boolean {
  return reading - maxSkewMs >= boundary;
}

/**
 * Conservative remaining lifetime of a lease observed through `reading`.
 * Worst case the observer's clock is ahead of true time by the skew bound.
 * Never returns a negative value.
 */
export function conservativeRemainingMs(
  reading: number,
  deadline: number,
  maxSkewMs: number,
): number {
  return Math.max(0, deadline - reading - maxSkewMs);
}

/**
 * Can a node that reads `reading` safely perform an operation that must occur
 * at or after `notBefore` and at or before `deadline`?
 *
 *     reading - skew >= notBefore   (definitely after the interval starts)
 *     reading + skew <= deadline    (definitely before the interval ends)
 */
export function insideConservativeInterval(
  reading: number,
  notBefore: number,
  deadline: number,
  maxSkewMs: number,
): boolean {
  return reading - maxSkewMs >= notBefore && reading + maxSkewMs <= deadline;
}

/** Index of the fixed window containing a coordinator reading. */
export function windowIndexAt(reading: number, windowMs: number): number {
  return Math.floor(reading / windowMs);
}

/** Start (inclusive) of the fixed window with `index`. */
export function windowStartAt(index: number, windowMs: number): number {
  return index * windowMs;
}

/** End (exclusive) of the fixed window with `index`. */
export function windowEndAt(index: number, windowMs: number): number {
  return (index + 1) * windowMs;
}

/**
 * The node-side safe interval for a window.  Each end is pulled in by one
 * skew bound so that even an adversarial clock offset cannot place the
 * operation outside the coordinator's window.
 */
export function nodeSafeWindow(
  index: number,
  windowMs: number,
  maxSkewMs: number,
): { notBefore: number; deadline: number } {
  return {
    notBefore: windowStartAt(index, windowMs) + maxSkewMs,
    deadline: windowEndAt(index, windowMs) - maxSkewMs,
  };
}
