import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BorrowAbortedError,
  BorrowTimeoutError,
  ConnectionCreateError,
  ConnectionLeasePool,
  PoolClosedError,
} from '../src/index.ts';
import { FakeClock, TestAdapter, flush, observe } from './helpers.ts';
import type { TestConnection } from './helpers.ts';

/**
 * One capacity-one story that threads the three hazards the pool must survive:
 * a cancellation while the first creation is still in flight, a reset that
 * fails, and a close whose adapter call hangs. Along the way it checks the
 * real number of opened connections, what every waiter received, and which
 * connection each reset and close was applied to.
 */
test('capacity one: cancel during create, reset failure, and slow close, with full attribution', async () => {
  const clock = new FakeClock();
  const adapter = new TestAdapter();
  const pool = new ConnectionLeasePool<TestConnection>({
    capacity: 1,
    adapter,
    clock,
    maxLifetimeMs: Infinity,
  });

  // --- 1. A caller cancels while the first creation is still in flight. -----
  const controller = new AbortController();
  const cancelled = observe(pool.acquire({ signal: controller.signal, timeoutMs: 60_000 }));
  await flush();
  assert.equal(adapter.createCount, 1);
  assert.deepEqual(pool.status().creating, 1);
  assert.deepEqual(pool.status().available, 0, 'an in-flight creation consumes the only slot');

  // A second caller queues behind the cancelled one.
  const queued = observe(pool.acquire({ timeoutMs: 60_000 }));
  await flush();
  assert.equal(queued.settled, false);

  controller.abort('user navigated away');
  await cancelled.done;
  assert.ok(cancelled.error instanceof BorrowAbortedError);
  assert.equal((cancelled.error as BorrowAbortedError).reason, 'user navigated away');
  assert.equal(pool.status().pendingBorrowers, 1, 'only the queued caller remains');
  assert.equal(pool.status().creating, 1, 'the creation is not abandoned on cancellation');

  // The connection arrives after its original requester is gone. It must go to
  // the earliest still-valid waiter — the queued caller — not become orphaned.
  const connectionOne = adapter.fulfilCreate('stale-session');
  await queued.done;
  assert.equal(queued.error, undefined);
  assert.equal(queued.value?.connection, connectionOne, 'late connection serves the still-waiting caller');
  assert.equal(adapter.openCount, 1);

  // --- 2. Its reset fails; the connection must be closed, not recycled. -----
  const second = observe(pool.acquire({ timeoutMs: 60_000 }));
  await flush();
  assert.equal(second.settled, false, 'the only connection is currently leased');

  const firstRelease = observe(queued.value!.release());
  await flush();
  assert.equal(adapter.resetCount, 1);
  assert.equal(adapter.resetCalls[0].connection, connectionOne, 'reset belongs to the returned connection');

  adapter.resetCalls[0].deferred.reject(new Error('session cleanup failed'));
  await flush();

  assert.equal(adapter.closeCount, 1, 'a failed reset immediately starts closing');
  assert.equal(adapter.closeCalls[0].connection, connectionOne, 'close belongs to the connection whose reset failed');
  assert.equal(pool.status().resetFailures, 1);
  assert.equal(pool.status().used, 1, 'the closing connection still occupies capacity');
  assert.equal(second.settled, false, 'the failed-reset connection is never handed to the waiter');
  assert.equal(firstRelease.settled, false, 'release waits for the cleanup close');

  // Capacity frees only once the close finishes, and only then does a new
  // connection get opened for the waiting caller.
  adapter.closeCalls[0].deferred.resolve();
  await firstRelease.done;
  await flush();
  assert.equal(adapter.openCount, 1);

  assert.equal(adapter.createCount, 2, 'the waiter triggers a fresh creation');
  const connectionTwo = adapter.makeConnection('fresh');
  adapter.lastCreate.resolve(connectionTwo);
  await second.done;
  assert.equal(second.value?.connection, connectionTwo);
  assert.notEqual(second.value?.connection, connectionOne);
  assert.equal(adapter.openCount, 2, 'exactly two connections were ever opened');

  // --- 3. Close while the second connection is held; close itself hangs. ---
  const shutdown = observe(pool.close());
  await flush();
  assert.equal(pool.status().acceptingBorrows, false);
  assert.equal(pool.status().allResourcesClosed, false);
  assert.equal(pool.status().phase, 'closing');
  assert.equal(pool.status().retired, 1, 'the outstanding lease is marked for retirement');
  assert.equal(shutdown.settled, false);

  const lateBorrow = observe(pool.acquire({ timeoutMs: 60_000 }));
  await lateBorrow.done;
  assert.ok(lateBorrow.error instanceof PoolClosedError, 'no new borrow is accepted after close');

  const secondRelease = observe(second.value!.release());
  await flush();
  assert.equal(adapter.resetCount, 1, 'a return during shutdown is closed instead of reset');
  assert.equal(adapter.closeCount, 2);
  assert.equal(adapter.closeCalls[1].connection, connectionTwo, 'close belongs to the returned connection');
  assert.equal(secondRelease.settled, false, 'release resolves with the slow close');

  // The close adapter call lingers; queries keep telling "not lending" apart
  // from "resources still open".
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pool.status().closing, 1);
  assert.equal(pool.status().allResourcesClosed, false);
  assert.equal(pool.status().acceptingBorrows, false);
  assert.equal(shutdown.settled, false);

  adapter.closeCalls[1].deferred.resolve();
  await secondRelease.done;
  await shutdown.done;

  const final = pool.status();
  assert.equal(final.allResourcesClosed, true);
  assert.equal(final.acceptingBorrows, false);
  assert.equal(final.phase, 'closed');
  assert.equal(final.used, 0);
  assert.equal(adapter.openCount, 2, 'no extra connections were opened by any of the hazards');
  assert.equal(adapter.resetCount, 1, 'exactly one reset was attempted');
  assert.equal(adapter.closeCount, 2, 'exactly two closes were attempted');
});

test('capacity one: the original waiter times out while creation is pending and a later wait survives', async () => {
  const clock = new FakeClock();
  const adapter = new TestAdapter();
  const pool = new ConnectionLeasePool<TestConnection>({ capacity: 1, adapter, clock });

  const timedOut = observe(pool.acquire({ timeoutMs: 50 }));
  await flush();
  const survivor = observe(pool.acquire({ timeoutMs: 60_000 }));
  await flush();

  clock.advance(50);
  await timedOut.done;
  assert.ok(timedOut.error instanceof BorrowTimeoutError);
  assert.equal(survivor.settled, false);

  const connection = adapter.fulfilCreate();
  await survivor.done;
  assert.equal(survivor.value?.connection, connection, 'the late connection is not stranded under a finished wait');
  assert.equal(pool.status().pendingBorrowers, 0);

  const release = survivor.value!.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await release;
  assert.equal(pool.status().idle, 1);

  const shutdown = pool.close();
  await flush();
  adapter.lastClose.deferred.resolve();
  await shutdown;
  assert.equal(adapter.openCount, 1);
});

test('capacity one: a waiter owing its slot to nothing gets the create error when the adapter fails', async () => {
  const clock = new FakeClock();
  const adapter = new TestAdapter();
  const pool = new ConnectionLeasePool<TestConnection>({ capacity: 1, adapter, clock });

  const outcome = observe(pool.acquire({ timeoutMs: 60_000 }));
  await flush();
  adapter.lastCreate.reject(new Error('dial failed'));
  await outcome.done;

  assert.ok(outcome.error instanceof ConnectionCreateError);
  assert.equal(pool.status().used, 0, 'the failed creation released the only slot');
  assert.equal(pool.status().available, 1);
  assert.equal(adapter.openCount, 0, 'a rejected creation never counts as an opened connection');

  const shutdown = pool.close();
  await shutdown;
  assert.equal(pool.status().phase, 'closed');
});
