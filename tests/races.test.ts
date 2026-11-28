import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';
import { LongPollReader } from '../src/reader.ts';
import type { ReadRequest } from '../src/types.ts';
import { flush, makeReader, valuesOf, sleep } from './helpers.ts';

function request(overrides: Partial<ReadRequest> = {}): ReadRequest {
  return {
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 10,
    maxBytes: 1000,
    maxRecords: 1000,
    waitMs: 200,
    ...overrides,
  };
}

test('an append between the short-data decision and parking wakes the read', async () => {
  const { adapter, reader } = makeReader();
  adapter.append('a', 'a0', 1); // 1 byte, below minBytes

  const pending = reader.read(request());
  // The read has just judged "not enough" and is about to subscribe. This
  // synchronous append lands exactly in the decide-then-subscribe window.
  adapter.append('a', 'a1', 9);

  const result = await pending;
  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['a0', 'a1']);
  assert.equal(result.bytes, 10);
});

test('an append racing the subscription setup is replayed and never lost', async () => {
  let injected = false;
  const adapter: InMemoryLogAdapter = new InMemoryLogAdapter(['a', 'b'], {
    onSubscribe: (self, since) => {
      if (injected || since === undefined) return;
      injected = true;
      self.appendBatch([
        { partition: 'a', value: 'a0', bytes: 6 },
        { partition: 'b', value: 'b0', bytes: 6 },
      ]);
    },
  });
  const reader = new LongPollReader(adapter);

  const result = await reader.read(request({ waitMs: 100 }));
  assert.equal(injected, true);
  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
  assert.deepEqual(valuesOf(result, 'b'), ['b0']);
  assert.equal(result.revision, adapter.snapshotRevision());
});

test('the return decision uses one revision; later appends go to the next read', async () => {
  // Append during snapshot construction of the second partition: the pack must
  // stay pinned to the revision captured before the first snapshot.
  let injected = false;
  const adapter: InMemoryLogAdapter = new InMemoryLogAdapter(['a', 'b'], {
    onSnapshot: (self, partition, revision) => {
      if (injected) return;
      if (partition !== 'b') return;
      injected = true;
      // This append would be visible at the *next* revision only.
      self.append('a', 'a1', 1);
      assert.equal(revision, self.snapshotRevision() - 1);
    },
  });
  const reader = new LongPollReader(adapter);
  adapter.append('a', 'a0', 1);
  adapter.append('a', 'a1', 1);

  const result = await reader.read(request({ minBytes: 2, maxBytes: 10, maxRecords: 10, waitMs: 50 }));
  assert.equal(injected, true);
  // The first snapshot pinned revision; every subsequent snapshot in the same
  // round uses that revision, so `a` sees exactly the records present then.
  assert.equal(result.revision, adapter.snapshotRevision() - 1);
  assert.deepEqual(valuesOf(result, 'a'), ['a0', 'a1']);
});

test('a deadline result is pinned and does not consume records appended later', async () => {
  const { adapter, reader } = makeReader();
  adapter.append('a', 'a0', 2);
  const result = await reader.read(request({ minBytes: 10, waitMs: 20 }));
  assert.equal(result.status, 'deadline');
  assert.deepEqual(result.nextOffsets, { a: 1, b: 0 });
  const revisionAtReturn = result.revision;

  adapter.appendBatch([
    { partition: 'a', value: 'after-a', bytes: 2 },
    { partition: 'b', value: 'after-b', bytes: 2 },
  ]);
  // The committed pack is unchanged: records appended after the revision the
  // read decided at are left for the next read.
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
  assert.deepEqual(valuesOf(result, 'b'), []);
  assert.equal(result.revision, revisionAtReturn);
  assert.ok(adapter.snapshotRevision() > (revisionAtReturn as number));

  const next = await reader.read(
    request({ startOffsets: result.nextOffsets, minBytes: 4, waitMs: 0 }),
  );
  assert.deepEqual(valuesOf(next, 'a'), ['after-a']);
  assert.deepEqual(valuesOf(next, 'b'), ['after-b']);
});

test('concurrent reads share one subscription; the last one detaches it', async () => {
  const { adapter, reader } = makeReader();
  const first = reader.read(request({ waitMs: 100 }));
  const second = reader.read(request({ waitMs: 100 }));
  await flush();
  assert.equal(adapter.subscriberCount, 1);
  assert.equal(reader.activeSubscriptions, 1);
  assert.equal(reader.pendingReads, 2);

  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 6 },
    { partition: 'b', value: 'b0', bytes: 6 },
  ]);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 'min-bytes');
  assert.equal(two.status, 'min-bytes');
  // Both settled: no subscription lingers.
  assert.equal(adapter.subscriberCount, 0);
  assert.equal(reader.pendingReads, 0);
  assert.equal(reader.activeSubscriptions, 0);
});

test('cancelling one read leaves the shared subscription for the other', async () => {
  const { adapter, reader } = makeReader();
  const controller = new AbortController();
  const cancelled = reader.read(request({ waitMs: 500, signal: controller.signal }));
  const survivor = reader.read(request({ waitMs: 500 }));
  await flush();

  controller.abort();
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.status, 'cancelled');
  assert.equal(cancelledResult.revision, null);
  assert.equal(cancelledResult.recordCount, 0);
  // The survivor still holds the subscription.
  assert.equal(adapter.subscriberCount, 1);
  assert.equal(reader.pendingReads, 1);

  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 6 },
    { partition: 'b', value: 'b0', bytes: 6 },
  ]);
  const survivorResult = await survivor;
  assert.equal(survivorResult.status, 'min-bytes');
  assert.equal(adapter.subscriberCount, 0);
});

test('cancelling the only read withdraws the subscription', async () => {
  const { adapter, reader } = makeReader();
  const controller = new AbortController();
  const pending = reader.read(request({ waitMs: 500, signal: controller.signal }));
  await flush();
  assert.equal(adapter.subscriberCount, 1);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(adapter.subscriberCount, 0);
  assert.equal(reader.activeSubscriptions, 0);
});

test('a pre-aborted signal settles immediately as cancelled without waiting', async () => {
  const { adapter, reader } = makeReader();
  adapter.append('a', 'a0', 1); // not enough data
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await reader.read(request({ waitMs: 5000, signal: controller.signal }));
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.revision, null);
  assert.ok(elapsed < 1000, `took ${elapsed}ms`);
  assert.equal(adapter.subscriberCount, 0);
});

test('partition updates only wake readers interested in that partition', async () => {
  const { adapter, reader } = makeReader(['a', 'b', 'c']);
  const readerA = reader.read(request({ partitions: ['a'], startOffsets: { a: 0 }, waitMs: 300 }));
  let aSettled = false;
  void readerA.then(() => {
    aSettled = true;
  });
  await flush();

  adapter.append('c', 'c0', 20); // irrelevant partition
  await sleep(10);
  assert.equal(aSettled, false, 'an unrelated partition must not wake the read');

  adapter.append('a', 'a0', 20);
  const result = await readerA;
  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
});

test('a batch touching an interested partition wakes the read once', async () => {
  const { adapter, reader } = makeReader();
  const pending = reader.read(request({ partitions: ['a'], startOffsets: { a: 0 }, waitMs: 100 }));
  await flush();
  adapter.appendBatch([
    { partition: 'b', value: 'b0', bytes: 100 },
    { partition: 'a', value: 'a0', bytes: 10 },
  ]);
  const result = await pending;
  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
});

test('a read satisfied on the first round never opens a subscription', async () => {
  const { adapter, reader } = makeReader();
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 10 },
    { partition: 'b', value: 'b0', bytes: 10 },
  ]);
  const result = await reader.read(request({ minBytes: 10, waitMs: 500 }));
  assert.equal(result.status, 'min-bytes');
  assert.equal(adapter.subscriberCount, 0);
  assert.equal(reader.activeSubscriptions, 0);
});

test('a read never settles twice when append, deadline and cancel interleave', async () => {
  for (let round = 0; round < 20; round += 1) {
    const { adapter, reader } = makeReader();
    const controller = new AbortController();
    const pending = reader.read(request({ minBytes: 5, waitMs: 5, signal: controller.signal }));
    // Interleave appends, aborts and timer boundaries from several turns.
    adapter.append('a', `x${round}`, 1);
    setTimeout(() => controller.abort(), round % 3 === 0 ? 0 : 2);
    adapter.append('a', `y${round}`, 4);
    const result = await pending;
    assert.ok(['min-bytes', 'deadline', 'cancelled'].includes(result.status));
    assert.equal(adapter.subscriberCount, 0, `round ${round}: subscription leaked`);
    assert.equal(reader.pendingReads, 0);
  }
});

test('subscription baseline resumes from the snapshot revision, not from park time', async () => {
  // The reader must not miss a change that lands after the snapshot revision
  // but before the subscription exists; the adapter's replay covers it.
  let appends = 0;
  const adapter: InMemoryLogAdapter = new InMemoryLogAdapter(['a'], {
    onSubscribe: (self) => {
      if (appends > 0) return;
      appends += 1;
      self.append('a', 'racing', 50);
    },
  });
  const reader = new LongPollReader(adapter);
  const result = await reader.read(request({ partitions: ['a'], startOffsets: { a: 0 }, waitMs: 100 }));
  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['racing']);
});

test('reads with different baselines each see every change after their snapshot', async () => {
  const { adapter, reader } = makeReader();
  const early = reader.read(request({ minBytes: 20, waitMs: 200 }));
  await flush();
  adapter.append('a', 'a0', 5); // below minBytes: early read re-parks
  const late = reader.read(request({ minBytes: 20, waitMs: 200 }));
  await flush();

  adapter.appendBatch([
    { partition: 'a', value: 'a1', bytes: 10 },
    { partition: 'b', value: 'b0', bytes: 5 },
  ]);
  const [earlyResult, lateResult] = await Promise.all([early, late]);

  for (const result of [earlyResult, lateResult]) {
    assert.equal(result.status, 'min-bytes');
    assert.equal(result.bytes >= 20, true);
  }
  assert.equal(adapter.subscriberCount, 0);
});
