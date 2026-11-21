import type { Clock } from './types.ts';

/**
 * Deterministic, manually driven clock. Tests call {@link ManualClock.advance}
 * to push logical time forward; registered listeners fire synchronously so the
 * coordinator can process expirations at each observable time step.
 */
export class ManualClock implements Clock {
  private current: number;
  private readonly listeners = new Set<(now: number) => void>();

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  /** Move time forward by `delta` (must be non-negative) and fire listeners. */
  advance(delta: number): number {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new Error('clock advance must be a non-negative finite number');
    }
    this.current += delta;
    const t = this.current;
    // Copy to allow listener (un)registration during dispatch.
    for (const listener of [...this.listeners]) listener(t);
    return this.current;
  }

  /** Jump to an absolute time (must not go backwards) and fire listeners. */
  setTime(time: number): number {
    if (time < this.current) throw new Error('clock cannot move backwards');
    if (time === this.current) return this.current;
    this.current = time;
    for (const listener of [...this.listeners]) listener(time);
    return this.current;
  }

  onAdvance(listener: (now: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Clock backed by real time (milliseconds), for non-test adapters. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
