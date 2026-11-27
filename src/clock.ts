/**
 * The pool never reads the wall clock directly. All time-based behaviour
 * (borrow deadlines and connection lifetimes) goes through this interface.
 *
 * Tests can supply a deterministic fake clock, while production code can use
 * `systemClock`. Timers must eventually invoke the callback; the pool clears
 * every timer it no longer needs.
 */

export type TimerHandle = unknown;

export interface Clock {
  /** Current time in milliseconds. Only differences are meaningful to the pool. */
  now(): number;
  /** Schedule `callback` after `delayMs` milliseconds. */
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  /** Cancel a handle returned by `setTimeout`. */
  clearTimeout(handle: TimerHandle): void;
}

/** Clock backed by Date.now and the global timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};
