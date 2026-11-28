import type { Clock } from './types.ts';

/** Wall-clock implementation used in production. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback: () => void, delayMs: number): number {
    return setTimeout(callback, Math.max(0, delayMs)) as unknown as number;
  },
  clearTimeout(handle: number): void {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
};

type ManualTimer = {
  id: number;
  at: number;
  order: number;
  callback: () => void;
};

/**
 * Deterministic clock for tests and simulations. Time only advances when
 * `advance` is called; timers run in due-time order, and ties keep insertion
 * order.
 */
export class ManualClock implements Clock {
  private currentTime = 0;
  private nextId = 1;
  private nextOrder = 1;
  private readonly timers = new Map<number, ManualTimer>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    const base = Math.max(0, delayMs);
    this.timers.set(id, {
      id,
      at: this.currentTime + base,
      order: this.nextOrder++,
      callback,
    });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }

  /**
   * Advance virtual time by `deltaMs`, firing every timer that becomes due.
   * Throws if a runaway zero-delay chain exceeds the safety budget.
   */
  advance(deltaMs: number): void {
    const target = this.currentTime + Math.max(0, deltaMs);
    let fired = 0;
    for (;;) {
      let next: ManualTimer | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at > target) continue;
        if (
          next === undefined ||
          timer.at < next.at ||
          (timer.at === next.at && timer.order < next.order)
        ) {
          next = timer;
        }
      }
      if (next === undefined) break;
      this.timers.delete(next.id);
      this.currentTime = next.at;
      next.callback();
      fired++;
      if (fired > 1_000_000) {
        throw new Error('ManualClock.advance: runaway timer loop');
      }
    }
    this.currentTime = target;
  }

  /** Advance time without firing timers (useful for setup). */
  setNow(time: number): void {
    if (time < this.currentTime) {
      throw new Error('ManualClock cannot move backwards');
    }
    this.currentTime = time;
  }
}
