import type { Clock } from './types.ts';

/**
 * Controllable clock for deterministic tests and scenarios.
 * Timers only fire while {@link advance} moves time forward.
 */
export class ManualClock implements Clock {
  #current = 0;
  #id = 0;
  #timers = new Map<
    number,
    { fn: () => void; at: number; delayMs: number; unrefed: boolean }
  >();

  now(): number {
    return this.#current;
  }

  setTimeout(fn: () => void, delayMs: number): { unref(): void; refresh(): void } {
    const id = ++this.#id;
    const entry = { fn, at: this.#current + Math.max(0, delayMs), delayMs, unrefed: false };
    this.#timers.set(id, entry);
    return {
      unref: () => {
        entry.unrefed = true;
      },
      refresh: () => {
        entry.at = this.#current + entry.delayMs;
      },
    };
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle);
  }

  /** Move the clock and synchronously run every due timer in time order. */
  advance(ms: number): void {
    this.#current += ms;
    // Timers may schedule more timers; loop until nothing is due.
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= this.#current)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) break;
      for (const [id, timer] of due) {
        if (!this.#timers.has(id)) continue;
        this.#timers.delete(id);
        timer.fn();
      }
    }
  }

  /** Test helper: number of pending timers. */
  get pendingTimers(): number {
    return this.#timers.size;
  }
}

/** Wall-clock implementation used by embedded production deployments. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, delayMs: number): { unref(): void; refresh(): void } {
    const handle = setTimeout(fn, delayMs);
    if (typeof handle.unref === 'function') handle.unref();
    return {
      unref: () => handle.unref(),
      refresh: () => handle.refresh(),
    };
  }
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
