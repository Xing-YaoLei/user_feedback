import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BorrowAbortedError,
  BorrowTimeoutError,
  ConnectionLeasePool,
  LeaseAlreadyReleasedError,
  PoolClosedError,
  PoolConfigurationError,
  systemClock,
} from '../src/index.ts';
import type { ConnectionLease } from '../src/index.ts';
import { FakeClock, TestAdapter, flush, observe, rejectionOf } from './helpers.ts';

interface SetupOptions {
  capacity?: number;
  maxLifetimeMs?: number;
  acquireTimeoutMs?: number;
}

function setup(options: SetupOptions = {}) {
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

function usage(pool: ConnectionLeasePool<unknown>) {
  const status = pool.status();
  return {
    creating: status.creating,
    leased: status.leased,
    idle: status.idle,
    resetting: status.resetting,
    closing: status.closing,
    used: status.used,
    available: status.available,
    pending: status.pendingBorrowers,
  };
}

async function borrowed(pool: ConnectionLeasePool<never> | any, adapter: TestAdapter) {
  const outcome = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  const connection = adapter.fulfilCreate();
  await outcome.done;
  if (outcome.error !== undefined) {
    throw outcome.error;
  }
  return outcome.value as ConnectionLease<any>;
}

test('capacity counts creating, leased, idle, resetting and closing connections', async () => {
  const { adapter, pool } = setup({ capacity: 2 });

  const first = observe(pool.acquire({ timeoutMs: 10_000 }));
  const second = observe(pool.acquire({ timeoutMs: 10_000 }));
  const third = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();

  assert.equal(adapter.createCount, 2, 'only capacity-many creations may be in flight');
  assert.deepEqual(usage(pool), {
    creating: 2,
    leased: 0,
    idle: 0,
    resetting: 0,
    closing: 0,
    used: 2,
    available: 0,
    pending: 3,
  });

  const connectionA = adapter.makeConnection('a');
  adapter.createRequests[0].resolve(connectionA);
  await first.done;
  assert.equal(second.settled, false);

  const connectionB = adapter.makeConnection('b');
  adapter.createRequests[1].resolve(connectionB);
  await second.done;
  await flush();

  assert.equal(first.value?.connection, connectionA);
  assert.equal(second.value?.connection, connectionB);
  assert.equal(third.settled, false);
  assert.deepEqual(usage(pool), {
    creating: 0,
    leased: 2,
    idle: 0,
    resetting: 0,
    closing: 0,
    used: 2,
    available: 0,
    pending: 1,
  });

  // Returning a connection does not free a slot: it is resetting first.
  const releaseA = observe(first.value!.release());
  await flush();
  assert.equal(adapter.resetCount, 1);
  assert.equal(adapter.resetCalls[0].connection, connectionA);
  assert.deepEqual(usage(pool), {
    creating: 0,
    leased: 1,
    idle: 0,
    resetting: 1,
    closing: 0,
    used: 2,
    available: 0,
    pending: 1,
  });
  assert.equal(third.settled, false, 'a connection mid-reset must not be handed out');

  adapter.resetCalls[0].deferred.resolve();
  await releaseA.done;
  await third.done;
  await flush();

  assert.equal(third.value?.connection, connectionA);
  assert.equal(adapter.createCount, 2, 'the reset connection satisfies the waiter');
  assert.deepEqual(usage(pool), {
    creating: 0,
    leased: 2,
    idle: 0,
    resetting: 0,
    closing: 0,
    used: 2,
    available: 0,
    pending: 0,
  });

  // Drain and close cleanly.
  const releaseRest = [third.value!.release(), second.value!.release()];
  await flush();
  for (const call of adapter.resetCalls.slice(1)) {
    call.deferred.resolve();
  }
  await Promise.all(releaseRest);
  const closed = pool.close();
  await flush();
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  await closed;
  assert.equal(pool.status().allResourcesClosed, true);
  assert.equal(adapter.openCount, 2, 'exactly two connections were ever opened');
});

test('waiters are served strictly in arrival order', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const holder = await borrowed(pool, adapter);

  const order: string[] = [];
  const w1 = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  const w2 = observe(pool.acquire({ timeoutMs: 10_000 }));
  const w3 = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  w1.done.then(() => order.push('w1'));
  w2.done.then(() => order.push('w2'));
  w3.done.then(() => order.push('w3'));

  let current = holder;
  for (const expected of ['w1', 'w2', 'w3']) {
    const release = observe(current.release());
    await flush();
    adapter.lastReset.deferred.resolve();
    await release.done;
    const outcome = expected === 'w1' ? w1 : expected === 'w2' ? w2 : w3;
    await outcome.done;
    assert.equal(outcome.error, undefined);
    current = outcome.value!;
    assert.deepEqual(order.at(-1), expected, `${expected} must be served in turn`);
    assert.equal(adapter.createCount, 1, 'FIFO hand-offs reuse one connection');
  }

  const release = observe(current.release());
  await flush();
  adapter.lastReset.deferred.resolve();
  await release.done;
  assert.deepEqual(order, ['w1', 'w2', 'w3']);
});

test('each borrow has its own credential; duplicates and stale tokens are rejected', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const first = await borrowed(pool, adapter);

  const releaseFirst = first.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await releaseFirst;
  assert.equal(first.released, true);

  const secondOutcome = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  await secondOutcome.done;
  const second = secondOutcome.value!;
  assert.equal(second.connection, first.connection);
  assert.notEqual(second.id, first.id, 'a new borrow gets a new credential');
  assert.equal(second.released, false);

  const stale = await rejectionOf(first.release());
  assert.ok(stale instanceof LeaseAlreadyReleasedError);
  assert.equal((stale as LeaseAlreadyReleasedError).code, 'LEASE_ALREADY_RELEASED');
  assert.equal(pool.status().leased, 1, 'the stale credential must not disturb the new lease');

  const firstReturn = second.release();
  const duplicate = await rejectionOf(second.release());
  assert.ok(duplicate instanceof LeaseAlreadyReleasedError);
  assert.equal((duplicate as LeaseAlreadyReleasedError).code, 'LEASE_ALREADY_RELEASED');

  await flush();
  assert.equal(adapter.resetCount, 2, 'only the first return triggers a reset');
  adapter.lastReset.deferred.resolve();
  await firstReturn;
  assert.equal(pool.status().idle, 1);
});

test('a borrow deadline rejects the waiter and late capacity is never attributed to it', async () => {
  const { clock, adapter, pool } = setup({ capacity: 1 });

  const late = observe(pool.acquire({ timeoutMs: 100 }));
  await flush();
  assert.equal(adapter.createCount, 1, 'creation started for the waiter');

  clock.advance(100);
  await late.done;
  const timeout = late.error;
  assert.ok(timeout instanceof BorrowTimeoutError);
  assert.equal((timeout as BorrowTimeoutError).code, 'BORROW_TIMEOUT');
  assert.equal(pool.status().pendingBorrowers, 0);
  assert.equal(pool.status().creating, 1, 'the in-flight creation still consumes capacity');

  // The now-unwanted connection must become idle, not stay "owned" by the
  // waiter that already gave up.
  const connection = adapter.fulfilCreate();
  await flush();
  assert.deepEqual(usage(pool), {
    creating: 0,
    leased: 0,
    idle: 1,
    resetting: 0,
    closing: 0,
    used: 1,
    available: 0,
    pending: 0,
  });
  assert.equal(pool.status().creating, 0);

  // An idle connection is reused by whoever shows up next.
  const next = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  await next.done;
  assert.equal(next.value?.connection, connection);
  assert.equal(adapter.createCount, 1);
});

test('a late-arriving connection goes to the earliest still-valid waiter', async () => {
  const { clock, adapter, pool } = setup({ capacity: 1 });

  const first = observe(pool.acquire({ timeoutMs: 100 }));
  await flush();
  const second = observe(pool.acquire({ timeoutMs: 10_000 }));
  const third = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();

  clock.advance(100);
  await flush();
  assert.equal(first.settled, true);
  assert.equal(first.error instanceof BorrowTimeoutError, true);
  assert.equal(second.settled, false);
  assert.equal(third.settled, false);

  const connection = adapter.fulfilCreate();
  await second.done;
  assert.equal(second.value?.connection, connection, 'earliest valid waiter is served first');
  assert.equal(third.settled, false);
  assert.equal(adapter.createCount, 1);
});

test('an AbortSignal cancels a pending borrow without leaving demand behind', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const controller = new AbortController();

  const waiter = observe(pool.acquire({ signal: controller.signal, timeoutMs: 10_000 }));
  await flush();
  assert.equal(adapter.createCount, 1);

  controller.abort(new Error('caller went away'));
  await waiter.done;
  const aborted = waiter.error;
  assert.ok(aborted instanceof BorrowAbortedError);
  assert.equal((aborted as BorrowAbortedError).code, 'BORROW_ABORTED');
  assert.equal(pool.status().pendingBorrowers, 0);

  const connection = adapter.fulfilCreate();
  await flush();
  assert.equal(pool.status().idle, 1);
  assert.equal(pool.status().leased, 0);
  assert.equal(connection.session, '', 'no borrow was ever granted');

  const preAborted = new AbortController();
  preAborted.abort();
  const duringCreate = adapter.createCount;
  const rejected = await rejectionOf(pool.acquire({ signal: preAborted.signal }));
  assert.ok(rejected instanceof BorrowAbortedError);
  assert.equal(adapter.createCount, duringCreate, 'an already-aborted borrow starts no work');
});

test('a connection that hits its lifetime while leased is only marked, then closed on return', async () => {
  const { clock, adapter, pool } = setup({ capacity: 1, maxLifetimeMs: 1000 });
  const lease = await borrowed(pool, adapter);
  const connection = lease.connection;

  clock.advance(999);
  assert.equal(pool.status().retired, 0);
  clock.advance(1);
  assert.equal(pool.status().retired, 1, 'lifetime boundary flags the lease for retirement');
  assert.equal(pool.status().leased, 1);
  assert.equal(adapter.closeCount, 0, 'a borrowed connection is never closed underneath its holder');

  const waiter = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();

  const release = observe(lease.release());
  await flush();
  assert.equal(adapter.resetCount, 1, 'return still performs the normal reset step');
  adapter.lastReset.deferred.resolve();
  await flush();

  assert.equal(adapter.closeCount, 1, 'a retired connection is closed instead of reused');
  assert.equal(adapter.lastClose.connection, connection);
  assert.equal(pool.status().idle, 0);
  assert.equal(pool.status().closing, 1);
  assert.equal(waiter.settled, false, 'a fresh connection is required for the waiter');
  assert.equal(release.settled, false, 'release resolves once the retirement close finishes');

  adapter.lastClose.deferred.resolve();
  await release.done;
  assert.equal(adapter.createCount, 2, 'capacity frees only after close completes, then a new create starts');

  const second = adapter.fulfilCreate();
  await waiter.done;
  assert.equal(waiter.value?.connection, second);
  assert.notEqual(waiter.value?.connection, connection);

  const finalRelease = second === undefined ? undefined : observe(waiter.value!.release());
  await flush();
  adapter.lastReset.deferred.resolve();
  await finalRelease!.done;
  const closed = pool.close();
  await flush();
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  await closed;
});

test('an idle connection that reaches its lifetime is closed rather than lent out', async () => {
  const { clock, adapter, pool } = setup({ capacity: 1, maxLifetimeMs: 1000 });
  const lease = await borrowed(pool, adapter);
  const connection = lease.connection;
  const release = lease.release();
  await flush();
  adapter.lastReset.deferred.resolve();
  await release;
  assert.equal(pool.status().idle, 1);

  clock.advance(1000);
  assert.equal(adapter.closeCount, 1);
  assert.equal(adapter.lastClose.connection, connection);
  assert.equal(pool.status().idle, 0);
  assert.equal(pool.status().closing, 1);

  const waiter = observe(pool.acquire({ timeoutMs: 10_000 }));
  await flush();
  assert.equal(adapter.createCount, 1, 'capacity is still consumed until close completes');

  adapter.lastClose.deferred.resolve();
  await flush();
  assert.equal(adapter.createCount, 2);
  adapter.fulfilCreate();
  await waiter.done;
  assert.notEqual(waiter.value?.connection, connection);

  const closed = pool.close();
  await flush();
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  // The waiter's lease is still outstanding; close must wait for the holder.
  let resolved = false;
  closed.then(() => {
    resolved = true;
  });
  await flush();
  assert.equal(resolved, false);
  const releaseLast = observe(waiter.value!.release());
  await flush();
  assert.equal(adapter.resetCount, 1, 'no reset happens for a connection returned during shutdown');
  assert.equal(adapter.closeCount, 2, 'the returned connection is closed');
  assert.equal(adapter.lastClose.connection, waiter.value!.connection);
  for (const call of [...adapter.closeCalls]) {
    call.deferred.resolve();
  }
  await releaseLast.done;
  await closed;
  assert.equal(resolved, true);
  assert.equal(pool.status().allResourcesClosed, true);
});

test('configuration is validated', () => {
  const adapter = new TestAdapter();
  assert.throws(() => new ConnectionLeasePool({ capacity: 0, adapter }), PoolConfigurationError);
  assert.throws(() => new ConnectionLeasePool({ capacity: 1.5, adapter }), PoolConfigurationError);
  assert.throws(
    () => new ConnectionLeasePool({ capacity: 1, adapter, maxLifetimeMs: -1 }),
    PoolConfigurationError,
  );
  assert.throws(
    () => new ConnectionLeasePool({ capacity: 1, adapter, maxLifetimeMs: 0 }),
    PoolConfigurationError,
  );
  assert.throws(
    () => new ConnectionLeasePool({ capacity: 1, adapter, acquireTimeoutMs: Number.NaN }),
    PoolConfigurationError,
  );

  const pool = new ConnectionLeasePool({ capacity: 1, adapter, clock: new FakeClock() });
  const invalid = pool.acquire({ timeoutMs: -5 });
  return rejectionOf(invalid).then((error) => {
    assert.ok(error instanceof PoolConfigurationError);
  });
});

test('systemClock is a usable default time source', () => {
  assert.equal(typeof systemClock.now(), 'number');
  const handle = systemClock.setTimeout(() => {}, 1000);
  systemClock.clearTimeout(handle);
});

test('acquiring after close fails immediately', async () => {
  const { adapter, pool } = setup({ capacity: 1 });
  const closed = pool.close();
  await closed;

  const error = await rejectionOf(pool.acquire());
  assert.ok(error instanceof PoolClosedError);
  assert.equal((error as PoolClosedError).code, 'POOL_CLOSED');
  assert.equal(adapter.createCount, 0);
});
