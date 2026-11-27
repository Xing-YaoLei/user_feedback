/**
 * Deterministic clock and controllable adapter used by the test suite.
 *
 * These helpers are intentionally dependency-free: the tests run with the
 * Node.js built-in test runner and its built-in TypeScript support.
 */

import type { Clock, TimerHandle } from '../src/clock.ts';
import type { PoolAdapter } from '../src/connection-lease-pool.ts';

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = (value: T) => {
        if (this.settled) return;
        this.settled = true;
        resolve(value);
      };
      this.reject = (reason?: unknown) => {
        if (this.settled) return;
        this.settled = true;
        reject(reason);
      };
    });
  }
}

interface FakeTimer {
  at: number;
  callback: () => void;
}

/** A manual clock: time only moves when `advance` is called. */
export class FakeClock implements Clock {
  private current = 0;
  private sequence = 0;
  private readonly timers = new Map<number, FakeTimer>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Number of timers still scheduled (deadlines and lifetimes). */
  get scheduledTimers(): number {
    return this.timers.size;
  }

  /** Move time forward, firing every timer whose deadline is reached, in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === undefined) {
        break;
      }
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      if (timer === undefined) {
        continue;
      }
      this.current = Math.max(this.current, timer.at);
      timer.callback();
    }
    this.current = target;
  }
}

export interface TestConnection {
  readonly id: number;
  /** Arbitrary per-call state, used to show that reset clears it. */
  session: string;
}

export interface ResetCall {
  connection: TestConnection;
  deferred: Deferred<void>;
}

export interface CloseCall {
  connection: TestConnection;
  deferred: Deferred<void>;
}

/**
 * An adapter whose every operation stays pending until the test settles it.
 * This makes creation/reset/close interleavings fully controllable.
 */
export class TestAdapter implements PoolAdapter<TestConnection> {
  readonly createRequests: Deferred<TestConnection>[] = [];
  readonly resetCalls: ResetCall[] = [];
  readonly closeCalls: CloseCall[] = [];

  private nextConnectionId = 0;

  create(): Promise<TestConnection> {
    const deferred = new Deferred<TestConnection>();
    this.createRequests.push(deferred);
    return deferred.promise;
  }

  reset(connection: TestConnection): Promise<void> {
    const deferred = new Deferred<void>();
    this.resetCalls.push({ connection, deferred });
    return deferred.promise;
  }

  close(connection: TestConnection): Promise<void> {
    const deferred = new Deferred<void>();
    this.closeCalls.push({ connection, deferred });
    return deferred.promise;
  }

  makeConnection(session = ''): TestConnection {
    this.nextConnectionId += 1;
    return { id: this.nextConnectionId, session };
  }

  get openCount(): number {
    return this.nextConnectionId;
  }

  get createCount(): number {
    return this.createRequests.length;
  }

  get resetCount(): number {
    return this.resetCalls.length;
  }

  get closeCount(): number {
    return this.closeCalls.length;
  }

  get lastCreate(): Deferred<TestConnection> {
    const request = this.createRequests.at(-1);
    if (request === undefined) {
      throw new Error('No create request has been made.');
    }
    return request;
  }

  get lastReset(): ResetCall {
    const call = this.resetCalls.at(-1);
    if (call === undefined) {
      throw new Error('No reset call has been made.');
    }
    return call;
  }

  get lastClose(): CloseCall {
    const call = this.closeCalls.at(-1);
    if (call === undefined) {
      throw new Error('No close call has been made.');
    }
    return call;
  }

  /** Fulfil the most recent pending creation with a fresh connection. */
  fulfilCreate(session = ''): TestConnection {
    const connection = this.makeConnection(session);
    this.lastCreate.resolve(connection);
    return connection;
  }
}

/** Allows queued promise callbacks and adapter continuations to run. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Capture a rejection without leaving an unhandled promise behind. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it fulfilled.');
}

/**
 * Observe a promise without awaiting it, so tests can assert intermediate
 * states. Always returns a promise that never rejects.
 */
export interface Outcome<T> {
  settled: boolean;
  value?: T;
  error?: unknown;
}

export function observe<T>(promise: Promise<T>): Outcome<T> & { done: Promise<void> } {
  const outcome: Outcome<T> & { done: Promise<void> } = {
    settled: false,
    done: Promise.resolve(),
  };
  outcome.done = promise.then(
    (value) => {
      outcome.settled = true;
      outcome.value = value;
    },
    (error) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return outcome;
}
