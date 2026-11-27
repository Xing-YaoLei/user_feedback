import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BorrowTimeoutError,
  ConnectionCreateError,
  ConnectionLeasePool,
  systemClock,
} from '../src/index.ts';
import type { ConnectionLease, PoolAdapter } from '../src/index.ts';
import { FakeClock, TestAdapter, flush, observe, rejectionOf } from './helpers.ts';
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

test('no deadline or lifetime elapses unless the injected clock advances', async () => {
  const { adapter, pool } = setup({ capacity: 1, maxLifetimeMs: 1000 });
  const lease = await borrow(pool, adapter);

  // Real time passing has no effect: only FakeClock.advance moves the pool.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pool.status().retired, 0);

  const waiter = observe(pool.acquire({ timeoutMs: 100 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(waiter.settled, false, 'borrow deadline is measured with the injected clock');
  assert.equal(pool.status().pendingBorrowers, 1);

  // Also confirm systemClock is only a default, never consulted when injected.
  const originalNow = systemClock.now;
  let consulted = 0;
  (systemClock as { now: () => number }).now = () => {
    consulted += 1;
    return originalNow();
  };
  try {
    const localClock = new FakeClock();
    const localAdapter = new TestAdapter();
    const localPool = new ConnectionLeasePool({
      capacity: 1,
      adapter: localAdapter,
      clock: localClock,
      maxLifetimeMs: 100,
    });
    const granted = observe(localPool.acquire({ timeoutMs: 50 }));
    await flush();
    localAdapter.fulfilCreate();
    await granted.done;
    const grantedRelease = granted.value!.release();
    await flush();
    localAdapter.lastReset.deferred.resolve();
    await grantedRelease;
    const shutdown = localPool.close();
    await flush();
    localAdapter.lastClose.deferred.resolve();
    await shutdown;
    assert.equal(consulted, 0, 'systemClock must not be consulted when a clock is injected');
  } finally {
    (systemClock as { now: () => number }).now = originalNow;
  }

  const release = observe(lease.release());
  await flush();
  adapter.lastReset.deferred.resolve();
  await release.done;

  // The pending waiter now owns the connection; return it fully so close can drain.
  await waiter.done;
  assert.equal(waiter.error, undefined);
  const waiterRelease = observe(waiter.value!.release());
  await flush();
  adapter.lastReset.deferred.resolve();
  await waiterRelease.done;
  assert.equal(pool.status().idle, 1);

  const shutdown = observe(pool.close());
  await flush();
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  await shutdown.done;
  assert.equal(pool.status().allResourcesClosed, true);
});

test('the pool clears every timer it armed once it has drained', async () => {
  const { clock, adapter, pool } = setup({ capacity: 2, maxLifetimeMs: 500 });

  const first = observe(pool.acquire({ timeoutMs: 10_000 }));
  const second = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  adapter.createRequests[0].resolve(adapter.makeConnection());
  adapter.createRequests[1].resolve(adapter.makeConnection());
  await first.done;
  await second.done;

  // A borrow that really does expire: both slots are leased.
  const timedOut = observe(pool.acquire({ timeoutMs: 120 }));
  await flush();
  clock.advance(120);
  await timedOut.done;
  assert.ok(timedOut.error instanceof BorrowTimeoutError, 'the third borrow ran out of time');

  // Return A, let its reset finish, and then let A's lifetime run out so the
  // idle connection starts closing. B is still leased and retired by close.
  const releaseA = first.value!.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await releaseA;
  clock.advance(500);
  assert.equal(pool.status().closing, 1, 'the idle connection reached its lifetime');

  const shutdown = observe(pool.close());
  await flush();
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  await flush();

  const releaseB = observe(second.value!.release());
  await flush();
  assert.equal(adapter.resetCount, 1, 'the shutdown path closes instead of resetting');
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  await releaseB.done;
  await shutdown.done;

  assert.equal(pool.status().allResourcesClosed, true);
  assert.equal(clock.scheduledTimers, 0, 'no lifetime or deadline timer may outlive the pool');
});

test('an adapter that resolves create() with undefined is treated as a create failure', async () => {
  const clock = new FakeClock();
  const adapter: PoolAdapter<undefined> = {
    create: async () => undefined,
    reset: async () => {},
    close: async () => {},
  };
  const pool = new ConnectionLeasePool<undefined>({ capacity: 1, adapter, clock });

  const outcome = observe(pool.acquire({ timeoutMs: 100 }));
  await outcome.done;

  assert.ok(outcome.error instanceof ConnectionCreateError);
  assert.equal(pool.status().used, 0, 'an unusable creation must not hold capacity');
  assert.equal(pool.status().createFailures, 1);
});

test('an adapter whose create() throws synchronously behaves like a rejection', async () => {
  const clock = new FakeClock();
  const pool = new ConnectionLeasePool<never>({
    capacity: 1,
    clock,
    adapter: {
      create: () => {
        throw new Error('sync boom');
      },
      reset: async () => {},
      close: async () => {},
    },
  });

  const outcome = observe(pool.acquire({ timeoutMs: 100 }));
  await outcome.done;
  assert.ok(outcome.error instanceof ConnectionCreateError);
  assert.equal(pool.status().used, 0);
});

test('status separates "no longer lending" from "all resources closed"', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const lease = await borrow(pool, adapter);

  let status = pool.status();
  assert.equal(status.acceptingBorrows, true);
  assert.equal(status.allResourcesClosed, false);
  assert.equal(status.phase, 'open');

  const shutdown = observe(pool.close());
  await flush();

  status = pool.status();
  assert.equal(status.acceptingBorrows, false, 'borrowing stops at the moment close() is called');
  assert.equal(status.allResourcesClosed, false, 'a leased connection is not closed yet');
  assert.equal(status.phase, 'closing');
  assert.equal(status.leased, 1);

  const release = lease.release();
  await flush();
  adapter.lastClose.deferred.resolve();
  await release;
  await shutdown.done;

  status = pool.status();
  assert.equal(status.acceptingBorrows, false);
  assert.equal(status.allResourcesClosed, true);
  assert.equal(status.phase, 'closed');
});

test('a borrower that releases twice cannot return a later borrow of the same connection', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const first = await borrow(pool, adapter);

  const firstRelease = first.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await firstRelease;

  const secondOutcome = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  await secondOutcome.done;
  const second = secondOutcome.value!;
  assert.equal(second.connection, first.connection, 'same physical connection, new borrow');

  // The old credential must not release the new borrow.
  const stale = await rejectionOf(first.release());
  assert.equal((stale as { code?: string }).code, 'LEASE_ALREADY_RELEASED');
  assert.equal(pool.status().leased, 1);
  assert.equal(second.released, false);

  const secondRelease = second.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await secondRelease;

  const shutdown = pool.close();
  await flush();
  adapter.lastClose.deferred.resolve();
  await shutdown;
  assert.equal(adapter.openCount, 1, 'one connection served both borrows');
});

test('two concurrent releases of the same lease produce exactly one reset', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const lease = await borrow(pool, adapter);

  // Both calls are made synchronously. Attach handlers to each immediately so
  // neither rejection is ever briefly unhandled.
  const settle = (promise: Promise<void>) =>
    promise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const firstOutcome = settle(lease.release());
  const duplicateOutcome = settle(lease.release());
  await flush();
  adapter.lastReset.deferred.resolve();

  const first = await firstOutcome;
  assert.equal(first.ok, true, 'exactly one of the two concurrent returns succeeds');
  const duplicate = await duplicateOutcome;
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal((duplicate.error as { code?: string }).code, 'LEASE_ALREADY_RELEASED');
  }

  assert.equal(adapter.resetCount, 1, 'a duplicate return must not trigger a second reset');
  await flush();

  const shutdown = pool.close();
  await flush();
  adapter.lastClose.deferred.resolve();
  await shutdown;
  assert.equal(adapter.closeCount, 1);
});

test('waiting borrowers are served one by one as each reset completes', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const holder = await borrow(pool, adapter);

  const waiters = [
    observe(pool.acquire({ timeoutMs: 10_000 })),
    observe(pool.acquire({ timeoutMs: 10_000 })),
  ];
  await flush();
  assert.equal(adapter.createCount, 1, 'no extra creation while an idle-handed path exists');

  let current: ConnectionLease<TestConnection> = holder;
  for (const waiter of waiters) {
    const release = current.release();
    await flush();
    assert.equal(waiter.settled, false, 'the next waiter must wait for the reset to finish');
    adapter.lastReset.deferred.resolve();
    await release;
    await waiter.done;
    assert.equal(waiter.value?.connection, holder.connection);
    current = waiter.value!;
  }

  const release = current.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await release;

  const shutdown = pool.close();
  await flush();
  adapter.lastClose.deferred.resolve();
  await shutdown;
  assert.equal(adapter.openCount, 1);
});
