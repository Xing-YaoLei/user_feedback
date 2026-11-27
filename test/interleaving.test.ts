import test from 'node:test';
import assert from 'node:assert/strict';

import { ConnectionLeasePool } from '../src/index.ts';
import type { AdapterErrorInfo, ConnectionLease } from '../src/index.ts';
import { Deferred, FakeClock, flush, observe } from './helpers.ts';

/**
 * A small deterministic PRNG so any failure is reproducible from its seed.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TestConnection {
  readonly id: number;
  session: string;
}

interface PendingOp {
  readonly kind: 'create' | 'reset' | 'close';
  readonly connection: TestConnection | undefined;
  settle(ok: boolean): void;
}

/**
 * Adapter that records every operation and keeps it pending until the driver
 * settles it. This gives the test full control over interleavings.
 */
class RecordingAdapter {
  private nextId = 0;
  readonly pending: PendingOp[] = [];
  /** Connections currently opened but not yet closed (best-effort view). */
  readonly opened = new Set<number>();
  readonly closed = new Set<number>();
  readonly resets: number[] = [];
  doubleClose = false;

  create(): Promise<TestConnection> {
    const deferred = new Deferred<TestConnection>();
    const connection: TestConnection = { id: ++this.nextId, session: '' };
    this.opened.add(connection.id);
    this.pending.push({
      kind: 'create',
      connection,
      settle: (ok) => {
        if (ok) deferred.resolve(connection);
        else {
          this.opened.delete(connection.id);
          deferred.reject(new Error(`create#${connection.id} failed`));
        }
      },
    });
    return deferred.promise;
  }

  reset(connection: TestConnection): Promise<void> {
    this.resets.push(connection.id);
    const deferred = new Deferred<void>();
    this.pending.push({
      kind: 'reset',
      connection,
      settle: (ok) => (ok ? deferred.resolve() : deferred.reject(new Error(`reset#${connection.id} failed`))),
    });
    return deferred.promise;
  }

  close(connection: TestConnection): Promise<void> {
    if (this.closed.has(connection.id)) {
      this.doubleClose = true;
    }
    this.closed.add(connection.id);
    this.opened.delete(connection.id);
    const deferred = new Deferred<void>();
    // Close failures are not exercised here; the dedicated tests cover them.
    this.pending.push({ kind: 'close', connection, settle: () => deferred.resolve() });
    return deferred.promise;
  }

  settle(kind: PendingOp['kind'] | 'any', ok = true): boolean {
    for (let index = 0; index < this.pending.length; index += 1) {
      const op = this.pending[index];
      if (kind !== 'any' && op.kind !== kind) {
        continue;
      }
      this.pending.splice(index, 1);
      op.settle(ok);
      return true;
    }
    return false;
  }

  find(kind: PendingOp['kind'], connectionId?: number): PendingOp | undefined {
    return this.pending.find(
      (op) => op.kind === kind && (connectionId === undefined || op.connection?.id === connectionId),
    );
  }
}

function assertInvariants(pool: ConnectionLeasePool<TestConnection>, leases: ConnectionLease<TestConnection>[], where: string) {
  const status = pool.status();
  assert.ok(status.used >= 0, `${where}: used must be non-negative`);
  assert.ok(status.used <= pool.capacity, `${where}: used ${status.used} exceeds capacity ${pool.capacity}`);
  assert.equal(
    status.used,
    status.creating + status.leased + status.idle + status.resetting + status.closing,
    `${where}: state breakdown must add up to used`,
  );
  assert.equal(status.available, status.capacity - status.used, `${where}: available mismatch`);
  assert.ok(status.retired <= status.leased + status.resetting, `${where}: too many retired`);
  assert.equal(status.allResourcesClosed, status.used === 0, `${where}: allResourcesClosed mismatch`);
  // Two live leases must never share one connection.
  const held = new Set(leases.map((lease) => lease.connection));
  assert.equal(held.size, leases.length, `${where}: two live leases reference the same connection`);
  // A resetting/closing connection is never simultaneously held.
  assert.equal(status.leased, leases.length, `${where}: lease bookkeeping drift`);
}

test('capacity invariant holds across randomized interleavings', async () => {
  const totals = { granted: 0, releaseCompleted: 0, createFailed: 0, timeout: 0, retiredSeen: 0 };

  for (const seed of [1, 7, 42, 1234, 99999]) {
    const random = mulberry32(seed);
    const clock = new FakeClock();
    const adapter = new RecordingAdapter();
    const capacity = 1 + Math.floor(random() * 3);
    const maxLifetimeMs = random() < 0.5 ? Infinity : 300;
    const pool = new ConnectionLeasePool<TestConnection>({
      capacity,
      adapter,
      clock,
      maxLifetimeMs,
      acquireTimeoutMs: 200,
    });

    const leases: ConnectionLease<TestConnection>[] = [];
    const coverage = {
      granted: 0,
      releaseCompleted: 0,
      retiredSeen: 0,
      createFailed: 0,
      timeout: 0,
    };

    for (let step = 0; step < 150; step += 1) {
      const roll = random();
      const where = `seed ${seed} step ${step}`;

      if (roll < 0.3) {
        const outcome = observe(pool.acquire({ timeoutMs: 200 }));
        // Let synchronous scheduling run, then sometimes settle the first
        // creation so the borrow can complete, then finish the attempt.
        if (adapter.find('create') !== undefined && random() < 0.6) {
          adapter.settle('create', random() < 0.85);
        }
        await flush();
        if (outcome.settled && outcome.error === undefined) {
          leases.push(outcome.value!);
          coverage.granted += 1;
          assert.equal(outcome.value!.released, false, `${where}: fresh lease already released`);
        } else if (outcome.settled) {
          if ((outcome.error as { code?: string }).code === 'BORROW_TIMEOUT') coverage.timeout += 1;
          if ((outcome.error as { code?: string }).code === 'CREATE_FAILED') coverage.createFailed += 1;
        } else {
          // Still waiting: cancel the attempt so the test does not pile up.
          await flush();
          clock.advance(200);
          await flush();
          if (outcome.settled && outcome.error !== undefined) {
            if ((outcome.error as { code?: string }).code === 'BORROW_TIMEOUT') coverage.timeout += 1;
            if ((outcome.error as { code?: string }).code === 'CREATE_FAILED') coverage.createFailed += 1;
          }
        }
      } else if (roll < 0.6 && leases.length > 0) {
        const index = Math.floor(random() * leases.length);
        const lease = leases[index];
        leases.splice(index, 1);
        const release = observe(lease.release());
        await flush();
        if (adapter.find('reset', lease.connection.id) !== undefined && random() < 0.7) {
          adapter.settle('reset', random() < 0.8);
        }
        await flush();
        if (!release.settled) {
          // Reset still pending; release resolves when it settles.
          adapter.settle('reset');
          await flush();
        }
        if (release.settled && release.error === undefined) {
          coverage.releaseCompleted += 1;
        }
      } else if (roll < 0.85) {
        const kinds: PendingOp['kind'][] = ['create', 'reset', 'close'];
        const kind = kinds[Math.floor(random() * kinds.length)];
        adapter.settle(kind, random() < 0.8);
        await flush();
      } else {
        clock.advance(Math.floor(random() * 120));
        await flush();
      }

      assertInvariants(pool, leases, where);
      assert.equal(adapter.doubleClose, false, `${where}: a connection was closed twice`);
      if (pool.status().retired > 0) {
        coverage.retiredSeen += 1;
      }
    }

    // Each seed must have exercised real borrowing and cleanup; otherwise the
    // invariant checks above would be vacuous. Paths that depend on racing a
    // failure against a deadline are asserted in aggregate below.
    assert.ok(coverage.granted > 0, `seed ${seed}: no lease was ever granted`);
    assert.ok(adapter.resets.length > 0, `seed ${seed}: no connection was ever reset`);
    assert.ok(coverage.releaseCompleted > 0, `seed ${seed}: no release ever completed`);
    assert.ok(adapter.closed.size > 0, `seed ${seed}: no connection was ever closed`);

    totals.granted += coverage.granted;
    totals.releaseCompleted += coverage.releaseCompleted;
    totals.createFailed += coverage.createFailed;
    totals.timeout += coverage.timeout;
    totals.retiredSeen += coverage.retiredSeen;

    // Drain: give up outstanding borrow deadlines, settle everything, then
    // close and check that the pool reaches a fully closed state.
    clock.advance(1000);
    await flush();
    for (let guard = 0; guard < 5000; guard += 1) {
      if (adapter.pending.length === 0 && leases.length === 0 && pool.status().pendingBorrowers === 0) {
        break;
      }
      for (const lease of [...leases]) {
        const release = observe(lease.release());
        await flush();
        if (release.settled) {
          leases.splice(leases.indexOf(lease), 1);
        }
      }
      adapter.settle('any');
      await flush();
      if (leases.length > 0) {
        // Force any pending reset/close to settle.
        adapter.settle('reset');
        adapter.settle('close');
        await flush();
      }
      clock.advance(500);
      await flush();
    }

    const shutdown = observe(pool.close());
    for (let guard = 0; guard < 5000 && !shutdown.settled; guard += 1) {
      adapter.settle('any');
      await flush();
    }
    await shutdown.done;

    assert.equal(shutdown.error, undefined, `seed ${seed}: close rejected`);
    const final = pool.status();
    assert.equal(final.allResourcesClosed, true, `seed ${seed}: pool did not drain`);
    assert.equal(final.phase, 'closed');
    assert.equal(final.used, 0);
    assert.equal(adapter.pending.length, 0, `seed ${seed}: operations left pending after close`);
    assert.equal(adapter.doubleClose, false, `seed ${seed}: a connection was closed twice`);
    assert.equal(adapter.opened.size, 0, `seed ${seed}: connections left open`);
  }

  // Across all seeds the driver must have reached the interesting paths.
  assert.ok(totals.granted > 0, 'no lease was ever granted');
  assert.ok(totals.releaseCompleted > 0, 'no return ever completed its reset');
  assert.ok(totals.createFailed > 0, 'no creation failure was ever surfaced');
  assert.ok(totals.timeout > 0, 'no borrow deadline was ever enforced');
});

test('onAdapterError observes adapter failures without breaking accounting', async () => {
  const errors: AdapterErrorInfo<string>[] = [];
  const clock = new FakeClock();
  let mode: 'create' | 'reset' | 'close' | 'none' = 'none';

  const pool = new ConnectionLeasePool<string>({
    capacity: 1,
    clock,
    adapter: {
      create: async () => {
        if (mode === 'create') throw new Error('create boom');
        return 'conn';
      },
      reset: async () => {
        if (mode === 'reset') throw new Error('reset boom');
      },
      close: async () => {
        if (mode === 'close') throw new Error('close boom');
      },
    },
    onAdapterError: (info) => {
      errors.push(info);
    },
  });

  mode = 'create';
  await pool.acquire({ timeoutMs: 100 }).catch(() => undefined);
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].operation, 'create');
  assert.equal(errors[0].connection, undefined);

  mode = 'reset';
  const lease = await pool.acquire({ timeoutMs: 100 });
  await lease.release();
  assert.equal(errors.at(-1)?.operation, 'reset');
  assert.equal(errors.at(-1)?.connection, 'conn');
  assert.equal(pool.status().resetFailures, 1);
  assert.equal(pool.status().allResourcesClosed, true, 'the failed connection was closed');

  mode = 'close';
  const second = await pool.acquire({ timeoutMs: 100 });
  await second.release();
  await flush();
  const shutdown = pool.close();
  await shutdown;
  assert.equal(errors.at(-1)?.operation, 'close');
  assert.equal(pool.status().closeFailures, 1);
  // A failed close must still release capacity so the pool can drain.
  assert.equal(pool.status().allResourcesClosed, true);

  // A throwing observer must not corrupt the pool.
  const throwing = new ConnectionLeasePool<string>({
    capacity: 1,
    clock: new FakeClock(),
    adapter: {
      create: () => Promise.reject(new Error('nope')),
      reset: async () => {},
      close: async () => {},
    },
    onAdapterError: () => {
      throw new Error('observer exploded');
    },
  });
  await throwing.acquire({ timeoutMs: 100 }).catch(() => undefined);
  await flush();
  assert.equal(throwing.status().createFailures, 1);
  assert.equal(throwing.status().used, 0);
});
