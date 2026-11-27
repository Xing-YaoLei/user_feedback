import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BorrowTimeoutError,
  ConnectionCreateError,
  ConnectionLeasePool,
  PoolClosedError,
} from '../src/index.ts';
import type { PoolAdapter } from '../src/index.ts';
import { Deferred, FakeClock, TestAdapter, flush, observe, rejectionOf } from './helpers.ts';
import type { TestConnection } from './helpers.ts';

function setup(options: { capacity?: number; maxLifetimeMs?: number; acquireTimeoutMs?: number } = {}) {
  const clock = new FakeClock();
  const adapter = new TestAdapter();
  const pool = new ConnectionLeasePool({
    capacity: options.capacity ?? 1,
    adapter,
    clock,
    maxLifetimeMs: options.maxLifetimeMs,
    acquireTimeoutMs: options.acquireTimeoutMs,
  });
  return { clock, adapter, pool };
}

async function borrow(pool: ConnectionLeasePool<TestConnection>, adapter: TestAdapter) {
  const outcome = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  adapter.fulfilCreate();
  await outcome.done;
  assert.equal(outcome.error, undefined);
  return outcome.value!;
}

/** Adapter whose create() always rejects; reset/close settle immediately. */
class FailingCreateAdapter implements PoolAdapter<TestConnection> {
  createCount = 0;
  readonly closes: TestConnection[] = [];

  create(): Promise<TestConnection> {
    this.createCount += 1;
    return Promise.reject(new Error(`create failure #${this.createCount}`));
  }

  reset(): Promise<void> {
    return Promise.resolve();
  }

  close(connection: TestConnection): Promise<void> {
    this.closes.push(connection);
    return Promise.resolve();
  }
}

test('close while creation is in flight rejects waiters and closes the late connection', async () => {
  const { adapter, pool } = setup({ capacity: 1 });

  const waiting = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  assert.equal(adapter.createCount, 1);

  const shutdown = observe(pool.close());
  await flush();

  assert.equal(waiting.settled, true);
  assert.ok(waiting.error instanceof PoolClosedError, 'pending waiters end when the pool closes');

  let status = pool.status();
  assert.equal(status.acceptingBorrows, false);
  assert.equal(status.allResourcesClosed, false, 'the in-flight creation is still a resource');
  assert.equal(status.phase, 'closing');
  assert.equal(status.creating, 1);
  assert.equal(status.used, 1);
  assert.equal(status.pendingBorrowers, 0);
  assert.equal(shutdown.settled, false, 'close waits for the in-flight creation to finish');

  const newAcquire = await rejectionOf(pool.acquire());
  assert.ok(newAcquire instanceof PoolClosedError);

  // The connection arrives after close was requested: it must be closed,
  // never lent out, and close() resolves only once that close completes.
  const connection = adapter.fulfilCreate();
  await flush();
  assert.equal(adapter.closeCount, 1);
  assert.equal(adapter.lastClose.connection, connection);
  status = pool.status();
  assert.equal(status.closing, 1);
  assert.equal(status.allResourcesClosed, false);
  assert.equal(shutdown.settled, false);

  adapter.lastClose.deferred.resolve();
  await shutdown.done;
  status = pool.status();
  assert.equal(shutdown.error, undefined);
  assert.equal(status.phase, 'closed');
  assert.equal(status.allResourcesClosed, true);
  assert.equal(status.acceptingBorrows, false);
  assert.equal(adapter.openCount, 1);
});

test('close waits for a borrower and closes the connection on return without resetting', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const lease = await borrow(pool, adapter);

  const shutdown = observe(pool.close());
  await flush();

  assert.equal(pool.status().leased, 1);
  assert.equal(pool.status().retired, 1, 'an outstanding lease is marked retired');
  assert.equal(adapter.closeCount, 0, 'the holder keeps its connection until it returns');
  assert.equal(shutdown.settled, false);

  const release = observe(lease.release());
  await flush();
  assert.equal(adapter.resetCount, 0, 'a pool that is closing does not reset for reuse');
  assert.equal(adapter.closeCount, 1);
  assert.equal(adapter.lastClose.connection, lease.connection);
  assert.equal(release.settled, false, 'release resolves only when the close has completed');
  assert.equal(shutdown.settled, false);

  adapter.lastClose.deferred.resolve();
  await release.done;
  await shutdown.done;
  assert.equal(release.error, undefined);
  assert.equal(pool.status().phase, 'closed');
  assert.equal(pool.status().allResourcesClosed, true);
});

test('close waits for an in-flight reset, then closes instead of pooling', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const lease = await borrow(pool, adapter);

  const release = observe(lease.release());
  await flush();
  assert.equal(adapter.resetCount, 1);
  assert.equal(pool.status().resetting, 1);

  const shutdown = observe(pool.close());
  await flush();
  assert.equal(pool.status().resetting, 1);
  assert.equal(pool.status().retired, 1);
  assert.equal(pool.status().phase, 'closing');
  assert.equal(adapter.closeCount, 0);

  adapter.lastReset.deferred.resolve();
  await flush();
  assert.equal(adapter.closeCount, 1);
  assert.equal(pool.status().idle, 0, 'the reset connection is not kept as idle after close');
  assert.equal(release.settled, false, 'release waits for the close it triggered');

  adapter.lastClose.deferred.resolve();
  await release.done;
  await shutdown.done;
  assert.equal(pool.status().allResourcesClosed, true);
});

test('a reset failure closes the connection and the slot frees only after close completes', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const lease = await borrow(pool, adapter);
  const connection = lease.connection;

  const waiter = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  assert.equal(waiter.settled, false);

  const release = observe(lease.release());
  await flush();
  assert.equal(adapter.resetCalls[0].connection, connection);

  adapter.resetCalls[0].deferred.reject(new Error('reset exploded'));
  await flush();

  assert.equal(adapter.closeCount, 1);
  assert.equal(adapter.lastClose.connection, connection, 'close is applied to the connection whose reset failed');
  assert.equal(pool.status().resetFailures, 1);
  assert.equal(pool.status().idle, 0);
  assert.equal(pool.status().closing, 1);
  assert.equal(waiter.settled, false, 'a failed reset is never followed by a hand-off');
  assert.equal(adapter.createCount, 1, 'capacity is still held by the closing connection');
  assert.equal(release.settled, false, 'release waits for the cleanup close to finish');

  adapter.lastClose.deferred.resolve();
  await release.done;
  await flush();
  assert.equal(adapter.createCount, 2, 'capacity freed only when close completed');

  const replacement = adapter.fulfilCreate();
  await waiter.done;
  assert.equal(waiter.value?.connection, replacement);
  assert.notEqual(waiter.value?.connection, connection);

  const finalRelease = waiter.value!.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await finalRelease;
  const shutdown = pool.close();
  await flush();
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  await shutdown;
});

test('a reset failure during shutdown still lets close() drain', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const lease = await borrow(pool, adapter);

  const release = observe(lease.release());
  await flush();
  const shutdown = observe(pool.close());
  await flush();
  assert.equal(shutdown.settled, false);

  adapter.lastReset.deferred.reject(new Error('reset failed while closing'));
  await flush();
  assert.equal(adapter.closeCount, 1);
  assert.equal(release.settled, false);
  adapter.lastClose.deferred.resolve();
  await release.done;
  await shutdown.done;
  assert.equal(pool.status().allResourcesClosed, true);
});

test('cancelling before creation completes leaves the late connection idle, not owned', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const controller = new AbortController();

  const cancelled = observe(pool.acquire({ signal: controller.signal, timeoutMs: 10_000 }));
  await flush();
  assert.equal(adapter.createCount, 1);
  assert.deepEqual(
    [pool.status().creating, pool.status().pendingBorrowers],
    [1, 1],
    'the creation consumed capacity even though the caller is about to leave',
  );

  controller.abort();
  await cancelled.done;
  assert.equal(pool.status().creating, 1, 'cancelling a waiter does not abort the creation');
  assert.equal(pool.status().pendingBorrowers, 0);

  const connection = adapter.fulfilCreate();
  await flush();
  assert.equal(pool.status().idle, 1, 'the late connection becomes idle');

  // The cancelled waiter must not be able to receive it retroactively.
  assert.equal(cancelled.value, undefined);

  const next = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  await next.done;
  assert.equal(next.value?.connection, connection);
  assert.equal(adapter.createCount, 1, 'the idle connection is reused, nothing new is opened');
  assert.equal(adapter.openCount, 1);
});

test('a failed creation is attributed to the waiter that requested it', async () => {
  const adapter = new FailingCreateAdapter();
  const pool = new ConnectionLeasePool({ capacity: 1, adapter });

  const outcome = observe(pool.acquire({ timeoutMs: 10_000 }));
  await outcome.done;

  assert.ok(outcome.error instanceof ConnectionCreateError);
  assert.equal((outcome.error as ConnectionCreateError).code, 'CREATE_FAILED');
  assert.equal(adapter.createCount, 1);

  const status = pool.status();
  assert.equal(status.createFailures, 1);
  assert.equal(status.used, 0, 'creation failure frees the slot');
  assert.equal(status.available, 1);
  assert.equal(status.pendingBorrowers, 0);
});

test('a creation that fails after its requester timed out reports to a waiter, not the departed one', async () => {
  const { clock, adapter, pool } = setup({ capacity: 1 });

  const first = observe(pool.acquire({ timeoutMs: 100 }));
  await flush();
  const second = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  assert.equal(adapter.createCount, 1, 'one in-flight creation covers both waiters');

  clock.advance(100);
  await first.done;
  assert.ok(first.error instanceof BorrowTimeoutError);
  assert.equal(second.settled, false);

  adapter.lastCreate.reject(new Error('create failed late'));
  await flush();

  assert.ok(
    second.error instanceof ConnectionCreateError,
    'the failure is reported to the still-waiting caller rather than silently retried forever',
  );
  assert.equal(pool.status().pendingBorrowers, 0);
  assert.equal(pool.status().used, 0, 'creation failure frees the slot');
  assert.equal(pool.status().createFailures, 1);
});

test('a persistently failing adapter fails each waiting caller instead of retrying forever', async () => {
  const clock = new FakeClock();
  const adapter = new FailingCreateAdapter();
  const pool = new ConnectionLeasePool({ capacity: 2, adapter, clock });

  const outcomes = [
    observe(pool.acquire({ timeoutMs: 10_000 })),
    observe(pool.acquire({ timeoutMs: 10_000 })),
    observe(pool.acquire({ timeoutMs: 10_000 })),
  ];
  await flush();
  await Promise.all(outcomes.map((outcome) => outcome.done));
  await flush();

  for (const outcome of outcomes) {
    assert.ok(outcome.error instanceof ConnectionCreateError);
  }
  assert.equal(pool.status().pendingBorrowers, 0);
  assert.equal(pool.status().used, 0);
  assert.equal(pool.status().createFailures, 3, 'each caller gets exactly one failure, no storm');
});

test('a close that takes a long time is observable and does not strand waiters', async () => {
  const { adapter, pool } = setup({ capacity: 2 });
  const lease = await borrow(pool, adapter);

  // Second slot is idle after a return.
  const secondLease = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  adapter.fulfilCreate();
  await secondLease.done;
  const secondRelease = secondLease.value!.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await secondRelease;

  assert.equal(pool.status().idle, 1);
  const waitersBefore = pool.status().pendingBorrowers;

  const shutdown = observe(pool.close());
  await flush();

  let status = pool.status();
  assert.equal(status.idle, 0, 'idle connections start closing immediately');
  assert.equal(status.closing, 1);
  assert.equal(status.leased, 1);
  assert.equal(status.retired, 1);
  assert.equal(status.acceptingBorrows, false);
  assert.equal(status.allResourcesClosed, false);
  assert.equal(status.phase, 'closing');
  assert.equal(status.pendingBorrowers, waitersBefore);

  // The idle connection's close hangs for a long time; queries must reflect
  // that the pool stopped borrowing while resources are not yet all closed.
  await flush();
  assert.equal(shutdown.settled, false);
  assert.equal(pool.status().closing, 1);

  adapter.lastClose.deferred.resolve();
  await flush();
  assert.equal(shutdown.settled, false, 'the borrower still holds the second connection');

  const release = lease.release();
  await flush();
  assert.equal(adapter.closeCount, 2);
  adapter.lastClose.deferred.resolve();
  await release;
  await shutdown.done;

  status = pool.status();
  assert.equal(status.phase, 'closed');
  assert.equal(status.allResourcesClosed, true);
  assert.equal(status.used, 0);
  assert.equal(adapter.openCount, 2);
});

test('reset and close calls are attributable to the exact connections that were lent out', async () => {
  const { adapter, pool } = setup({ capacity: 2 });

  const a = observe(pool.acquire({ timeoutMs: 10_000 }));
  const b = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  const connA = adapter.makeConnection('A');
  const connB = adapter.makeConnection('B');
  adapter.createRequests[0].resolve(connA);
  adapter.createRequests[1].resolve(connB);
  await a.done;
  await b.done;

  assert.equal(a.value?.connection, connA);
  assert.equal(b.value?.connection, connB);

  const releaseB = b.value!.release();
  const releaseA = a.value!.release();
  await flush();

  assert.equal(adapter.resetCount, 2);
  assert.equal(adapter.resetCalls[0].connection, connB, 'returns are reset in call order');
  assert.equal(adapter.resetCalls[1].connection, connA);

  adapter.resetCalls[1].deferred.reject(new Error('reset of A failed'));
  adapter.resetCalls[0].deferred.resolve();
  await releaseB;
  await flush();

  assert.equal(adapter.closeCount, 1, 'only the connection whose reset failed is closed now');
  assert.equal(adapter.lastClose.connection, connA);
  assert.equal(pool.status().idle, 1);
  assert.equal(pool.status().closing, 1);
  assert.equal(pool.status().used, 2, 'both slots are still accounted for');

  adapter.lastClose.deferred.resolve();
  await releaseA;
  assert.equal(pool.status().used, 1, 'only after close completes does the slot free');

  const shutdown = pool.close();
  await flush();
  assert.equal(adapter.closeCount, 2);
  assert.equal(adapter.lastClose.connection, connB, 'shutdown closes the idle connection');
  adapter.lastClose.deferred.resolve();
  await shutdown;
  assert.equal(pool.status().allResourcesClosed, true);
});

test('a connection retired during an in-flight reset is closed once the reset settles', async () => {
  const { clock, adapter, pool } = setup({ capacity: 1, maxLifetimeMs: 1000 });
  const lease = await borrow(pool, adapter);
  const connection = lease.connection;

  const release = observe(lease.release());
  await flush();
  assert.equal(adapter.resetCount, 1);

  clock.advance(1000);
  assert.equal(pool.status().retired, 1, 'the lifetime boundary applies during reset too');
  assert.equal(adapter.closeCount, 0);

  adapter.lastReset.deferred.resolve();
  await flush();

  assert.equal(adapter.closeCount, 1);
  assert.equal(adapter.lastClose.connection, connection);
  assert.equal(pool.status().idle, 0);
  assert.equal(release.settled, false, 'release resolves when the retirement close completes');
  adapter.lastClose.deferred.resolve();
  await release.done;
  assert.equal(pool.status().used, 0);
});

test('double close returns the same shutdown promise', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const shutdownA = pool.close();
  const shutdownB = pool.close();
  assert.equal(shutdownA, shutdownB);
  await shutdownA;
  await shutdownB;
  assert.equal(adapter.createCount, 0);
  assert.equal(pool.status().phase, 'closed');
});
