/**
 * Deterministic virtual-clock scheduler.
 *
 * All Raft timers (heartbeats, election timeouts, client deadlines) and every
 * network delivery are scheduled here, so a run can be reproduced exactly by
 * reusing the same seed and the same sequence of external actions.
 *
 * Time is virtual: `advance()` / `runUntil()` process due events in
 * (time, sequence) order. Nothing depends on the real wall clock.
 */

export type TimerHandle = { readonly seq: number };

interface TimedEvent {
  seq: number;
  time: number;
  callback: () => void;
  cancelled: boolean;
}

/** Deterministic PRNG (mulberry32). Same seed → same stream. */
export class DeterministicRng {
  private state: number;

  constructor(seed: number) {
    // Force an unsigned 32-bit state; avoid the degenerate zero state.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

export interface SchedulerOptions {
  /** Virtual time of the first scheduled event is relative to 0. */
  now?: number;
}

export class Scheduler {
  private time = 0;
  private events: TimedEvent[] = [];
  private seqCounter = 0;
  readonly rng: DeterministicRng;

  constructor(seed = 1, _options: SchedulerOptions = {}) {
    this.rng = new DeterministicRng(seed);
  }

  currentTime(): number {
    return this.time;
  }

  /**
   * Schedule `callback` after `delayMs` virtual milliseconds.
   * Returns a handle usable with `cancel`.
   */
  schedule(delayMs: number, callback: () => void): TimerHandle {
    const event: TimedEvent = {
      seq: ++this.seqCounter,
      time: this.time + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.events.push(event);
    return { seq: event.seq };
  }

  cancel(handle: TimerHandle | undefined): void {
    if (!handle) return;
    const event = this.events.find((e) => e.seq === handle.seq);
    if (event) event.cancelled = true;
  }

  private popNext(): TimedEvent | undefined {
    let best = -1;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.cancelled) continue;
      if (best < 0 || e.time < this.events[best].time ||
        (e.time === this.events[best].time && e.seq < this.events[best].seq)) {
        best = i;
      }
    }
    if (best < 0) return undefined;
    const [event] = this.events.splice(best, 1);
    return event;
  }

  /** Advance virtual time by `ms`, firing every event due within the window. */
  async advance(ms: number): Promise<void> {
    const deadline = this.time + ms;
    for (;;) {
      const event = this.popNext();
      if (!event || event.time > deadline) {
        if (event) this.events.push(event);
        break;
      }
      this.time = event.time;
      event.callback();
      await this.drainMicrotasks();
    }
    this.time = Math.max(this.time, deadline);
    await this.drainMicrotasks();
  }

  /**
   * Run events until the predicate holds or no events remain / the safety
   * deadline is reached. The predicate is re-checked after every event and
   * after microtask drainage, so awaited promises resolved inside handlers
   * are observed deterministically.
   */
  async runUntil(
    predicate: () => boolean,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = this.time + timeoutMs;
    while (!predicate()) {
      const event = this.popNext();
      if (!event) {
        throw new Error(
          `runUntil: scheduler exhausted at t=${this.time} before predicate held`,
        );
      }
      if (event.time > deadline) {
        this.events.push(event);
        throw new Error(
          `runUntil: safety deadline reached at t=${this.time} (event at ${event.time})`,
        );
      }
      this.time = event.time;
      event.callback();
      await this.drainMicrotasks();
    }
  }

  /** Let all currently pending promise continuations run. */
  drainMicrotasks(): Promise<void> {
    // A couple of chained ticks flush nested awaits without involving timers.
    return Promise.resolve().then(() => Promise.resolve());
  }

  hasPending(): boolean {
    return this.events.some((e) => !e.cancelled);
  }

  pendingCount(): number {
    return this.events.filter((e) => !e.cancelled).length;
  }
}
