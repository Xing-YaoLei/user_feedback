import type { Clock } from './types.ts';

interface TimerEntry {
  id: number;
  at: number;
  fn: () => void;
  cancelled: boolean;
}

/**
 * Deterministic virtual clock. Time only advances when `advance` is called,
 * and all due timers run synchronously in chronological order. Timers
 * scheduled with zero delay during a run execute before `advance` returns.
 */
export class VirtualClock implements Clock {
  private current = 0;
  private timers: TimerEntry[] = [];
  private nextId = 1;

  now(): number {
    return this.current;
  }

  setTimer(delayMs: number, fn: () => void): () => void {
    if (delayMs < 0) throw new Error('timer delay must be non-negative');
    const entry: TimerEntry = {
      id: this.nextId++,
      at: this.current + delayMs,
      fn,
      cancelled: false,
    };
    this.timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Advance virtual time by `ms`, running every timer that becomes due. */
  advance(ms: number): void {
    if (ms < 0) throw new Error('cannot advance backwards');
    const target = this.current + ms;
    // Loop because timers can schedule further zero-delay work.
    for (;;) {
      const pending = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => (a.at !== b.at ? a.at - b.at : a.id - b.id));
      if (pending.length === 0) break;
      for (const timer of pending) {
        if (timer.cancelled) continue;
        this.current = timer.at;
        timer.cancelled = true;
        timer.fn();
      }
    }
    this.timers = this.timers.filter((t) => !t.cancelled);
    this.current = target;
  }

  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}
