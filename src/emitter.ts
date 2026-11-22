type Listener<T extends unknown[]> = (...args: T) => void;

/** Minimal typed event emitter (no external dependencies). */
export class Emitter<EventMap extends Record<string, unknown[]>> {
  #listeners = new Map<keyof EventMap, Set<Listener<never>>>();

  on<K extends keyof EventMap>(event: K, fn: (...args: EventMap[K]) => void): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return this;
  }

  off<K extends keyof EventMap>(event: K, fn: (...args: EventMap[K]) => void): this {
    this.#listeners.get(event)?.delete(fn as Listener<never>);
    return this;
  }

  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      (fn as (...a: EventMap[K]) => void)(...args);
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
