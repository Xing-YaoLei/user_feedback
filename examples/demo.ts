/**
 * A runnable example: three callers share one database-like connection, so the
 * pool serialises them. The adapter simulates session state that must be
 * cleared by the reset step before the next caller can use the connection.
 *
 *   npm run demo
 */

import {
  BorrowTimeoutError,
  ConnectionLeasePool,
  systemClock,
} from '../src/index.ts';
import type { Clock, PoolAdapter } from '../src/index.ts';

/** A stand-in for a real client (e.g. a database session). */
interface Session {
  readonly id: number;
  /** Leftover per-call state; reset() is expected to clear it. */
  leftover: string;
}

class FakeSessionAdapter implements PoolAdapter<Session> {
  private nextId = 0;
  opened = 0;
  closed = 0;

  async create(): Promise<Session> {
    await delay(20);
    this.opened += 1;
    return { id: ++this.nextId, leftover: '' };
  }

  async reset(session: Session): Promise<void> {
    await delay(10);
    if (session.leftover !== '') {
      console.log(`  reset clear session #${session.id} leftover=${JSON.stringify(session.leftover)}`);
    }
    session.leftover = '';
  }

  async close(session: Session): Promise<void> {
    await delay(10);
    this.closed += 1;
    console.log(`  closed session #${session.id}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one unit of work with the borrowed connection. */
async function work(name: string, pool: ConnectionLeasePool<Session>): Promise<void> {
  let lease;
  try {
    lease = await pool.acquire({ timeoutMs: 500 });
  } catch (error) {
    if (error instanceof BorrowTimeoutError) {
      console.log(`${name}: gave up waiting after ${error.timeoutMs}ms`);
      return;
    }
    throw error;
  }

  try {
    const session = lease.connection;
    // Dirty the session to show that reset is what protects the next caller.
    session.leftover = `${name}'s temporary table`;
    console.log(`${name}: using session #${session.id}`);
    await delay(15);
  } finally {
    // release() resolves once the session is reset back to idle (or closed).
    await lease.release();
  }
}

const adapter = new FakeSessionAdapter();
const clock: Clock = systemClock;
const pool = new ConnectionLeasePool<Session>({
  capacity: 1,
  adapter,
  clock,
  maxLifetimeMs: 60_000,
  acquireTimeoutMs: 1_000,
});

console.log('three callers, one connection of capacity:');
await Promise.all([work('alice', pool), work('bob', pool), work('carol', pool)]);

const status = pool.status();
console.log('after work:', {
  opened: adapter.opened,
  closed: adapter.closed,
  idle: status.idle,
  used: status.used,
});

console.log('closing pool...');
await pool.close();
console.log('after close:', pool.status().phase, 'allResourcesClosed=', pool.status().allResourcesClosed);
