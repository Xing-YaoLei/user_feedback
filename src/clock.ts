/**
 * Clock, config copying and small helpers.
 */
import type { Clock, ConfigValue } from './types.ts';

/** Deterministic, manually advanced clock for tests and the demo. */
export class ManualClock implements Clock {
  #now: number;

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`clock can only advance by a finite non-negative amount, got ${ms}`);
    }
    this.#now += ms;
    return this.#now;
  }

  set(now: number): number {
    if (!Number.isFinite(now) || now < this.#now) {
      throw new RangeError(`clock cannot move backwards (now=${this.#now}, requested=${now})`);
    }
    this.#now = now;
    return this.#now;
  }
}

export function cloneConfig<T extends ConfigValue>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return structuredClone(value);
}
