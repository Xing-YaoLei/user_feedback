import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';
import { LongPollReader } from '../src/reader.ts';
import { makeReader, valuesOf } from './helpers.ts';

function build(): { adapter: InMemoryLogAdapter; reader: LongPollReader } {
  const adapter = new InMemoryLogAdapter(['a', 'b', 'c']);
  const reader = new LongPollReader(adapter);
  return { adapter, reader };
}

test('round-robin takes one record per partition per round, skipping empty ones', async () => {
  const { adapter, reader } = build();
  // a has 3, b has 1, c has 0.
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 1 },
    { partition: 'b', value: 'b0', bytes: 1 },
    { partition: 'a', value: 'a1', bytes: 1 },
    { partition: 'a', value: 'a2', bytes: 1 },
  ]);

  const result = await reader.read({
    partitions: ['a', 'b', 'c'],
    startOffsets: { a: 0, b: 0, c: 0 },
    minBytes: 4,
    maxBytes: 100,
    maxRecords: 100,
    waitMs: 0,
  });

  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['a0', 'a1', 'a2']);
  assert.deepEqual(valuesOf(result, 'b'), ['b0']);
  assert.deepEqual(valuesOf(result, 'c'), []);
  // Round 1: a0, b0. Round 2: a1 (c empty). Round 3: a2.
  assert.equal(result.bytes, 4);
});

test('stops when the next record does not fit, leaving it for the next read', async () => {
  const { adapter, reader } = build();
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 6 },
    { partition: 'b', value: 'b0', bytes: 6 },
    { partition: 'a', value: 'a1', bytes: 6 },
  ]);

  const result = await reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 100,
    maxBytes: 10,
    maxRecords: 100,
    waitMs: 0,
  });

  assert.equal(result.status, 'deadline');
  assert.equal(result.stopReason, 'max-bytes');
  assert.equal(result.bytes, 6);
  assert.equal(result.recordCount, 1);
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
  assert.deepEqual(valuesOf(result, 'b'), []);
  assert.deepEqual(result.nextOffsets, { a: 1, b: 0 });
});

test('a first record larger than the byte cap is returned alone', async () => {
  const { adapter, reader } = build();
  adapter.appendBatch([
    { partition: 'a', value: 'huge', bytes: 50 },
    { partition: 'b', value: 'small', bytes: 3 },
  ]);

  const result = await reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 60,
    maxBytes: 10,
    maxRecords: 100,
    waitMs: 0,
  });

  assert.equal(result.status, 'deadline');
  assert.equal(result.stopReason, 'max-bytes');
  assert.equal(result.recordCount, 1);
  assert.deepEqual(valuesOf(result, 'a'), ['huge']);
  assert.deepEqual(valuesOf(result, 'b'), []);
  assert.equal(result.bytes, 50);
  assert.deepEqual(result.nextOffsets, { a: 1, b: 0 });
});

test('maxRecords caps the pack exactly and preserves partition order', async () => {
  const { adapter, reader } = build();
  for (let i = 0; i < 3; i += 1) {
    adapter.appendBatch([
      { partition: 'a', value: `a${i}`, bytes: 1 },
      { partition: 'b', value: `b${i}`, bytes: 1 },
    ]);
  }

  const result = await reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 50,
    maxBytes: 1000,
    maxRecords: 3,
    waitMs: 0,
  });

  assert.equal(result.status, 'deadline');
  assert.equal(result.stopReason, 'max-records');
  assert.equal(result.recordCount, 3);
  assert.deepEqual(valuesOf(result, 'a'), ['a0', 'a1']);
  assert.deepEqual(valuesOf(result, 'b'), ['b0']);
  assert.deepEqual(result.nextOffsets, { a: 2, b: 1 });
});

test('reaching minBytes mid-round returns without packing the rest of that round', async () => {
  const { adapter, reader } = build();
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 4 },
    { partition: 'b', value: 'b0', bytes: 4 },
    { partition: 'a', value: 'a1', bytes: 4 },
    { partition: 'b', value: 'b1', bytes: 4 },
  ]);

  const result = await reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 4,
    maxBytes: 1000,
    maxRecords: 1000,
    waitMs: 0,
  });

  assert.equal(result.status, 'min-bytes');
  assert.equal(result.bytes, 4);
  assert.equal(result.recordCount, 1);
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
  assert.deepEqual(valuesOf(result, 'b'), []);
});

test('minBytes 0 returns immediately with whatever is available', async () => {
  const { adapter, reader } = build();
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 1 },
    { partition: 'b', value: 'b0', bytes: 1 },
  ]);
  const result = await reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 0,
    maxBytes: 100,
    maxRecords: 10,
    waitMs: 500,
  });
  assert.equal(result.status, 'min-bytes');
  // "Whatever is ready" is packed up to the caps, not a single record.
  assert.equal(result.recordCount, 2);
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
  assert.deepEqual(valuesOf(result, 'b'), ['b0']);
  assert.equal(result.revision, adapter.snapshotRevision());
});

test('an empty log parks and is woken by the first append', async () => {
  const { adapter, reader } = build();
  const pending = reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 5,
    maxBytes: 100,
    maxRecords: 10,
    waitMs: 500,
  });
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 10));
  adapter.append('a', 'a0', 10);
  const result = await pending;
  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
  assert.ok(Date.now() - started < 400, 'the append woke the read before the deadline');
});

test('an empty partition list resolves immediately', async () => {
  const { reader } = build();
  const started = Date.now();
  const result = await reader.read({
    partitions: [],
    startOffsets: {},
    minBytes: 0,
    maxBytes: 100,
    maxRecords: 10,
    waitMs: 500,
  });
  assert.equal(result.status, 'min-bytes');
  assert.equal(result.recordCount, 0);
  assert.ok(Date.now() - started < 100);

  // With a positive minimum and no partitions, waiting cannot help either.
  const unreachable = await reader.read({
    partitions: [],
    startOffsets: {},
    minBytes: 5,
    maxBytes: 100,
    maxRecords: 10,
    waitMs: 500,
  });
  assert.equal(unreachable.status, 'deadline');
  assert.ok(Date.now() - started < 200);
});

test('deadline returns what fit when the minimum is never reached', async () => {
  const { adapter, reader } = build();
  adapter.appendBatch([{ partition: 'a', value: 'a0', bytes: 2 }]);
  const started = Date.now();
  const result = await reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 10,
    maxBytes: 100,
    maxRecords: 100,
    waitMs: 30,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'deadline');
  assert.ok(elapsed >= 25, `waited ${elapsed}ms`);
  assert.deepEqual(valuesOf(result, 'a'), ['a0']);
  assert.deepEqual(result.nextOffsets, { a: 1, b: 0 });
});

test('resuming from nextOffsets continues exactly where the last read stopped', async () => {
  const { adapter, reader } = build();
  for (let i = 0; i < 5; i += 1) adapter.append('a', `a${i}`, 1);

  let offsets = { a: 0, b: 0 };
  const collected: unknown[] = [];
  for (let round = 0; round < 5; round += 1) {
    const result = await reader.read({
      partitions: ['a', 'b'],
      startOffsets: offsets,
      minBytes: 2,
      maxBytes: 2,
      maxRecords: 10,
      waitMs: 0,
    });
    collected.push(...valuesOf(result, 'a'));
    offsets = { a: result.nextOffsets.a as number, b: result.nextOffsets.b as number };
  }
  assert.deepEqual(collected, ['a0', 'a1', 'a2', 'a3', 'a4']);
});

test('a read requesting an offset ahead of the head waits for it to arrive', async () => {
  const { adapter, reader } = build();
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 1 },
    { partition: 'a', value: 'a1', bytes: 1 },
  ]);

  // Deadline of 0: the requested offset is ahead of the head, nothing fits.
  const immediate = await reader.read({
    partitions: ['a'],
    startOffsets: { a: 5 },
    minBytes: 1,
    maxBytes: 10,
    maxRecords: 10,
    waitMs: 0,
  });
  assert.equal(immediate.recordCount, 0);
  assert.equal(immediate.status, 'deadline');
  assert.equal(immediate.partitions[0].nextOffset, 5);
  assert.equal(immediate.partitions[0].firstOffset, 5);

  // With a positive deadline the read parks and is woken when offset 5 lands.
  const pending = reader.read({
    partitions: ['a'],
    startOffsets: { a: 5 },
    minBytes: 1,
    maxBytes: 10,
    maxRecords: 10,
    waitMs: 200,
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 2; i <= 5; i += 1) adapter.append('a', `a${i}`, 1);
  const result = await pending;
  assert.equal(result.status, 'min-bytes');
  assert.deepEqual(valuesOf(result, 'a'), ['a5']);
  assert.equal(result.nextOffsets.a, 6);
});

test('a read requesting a trimmed offset starts at the retained window bottom', async () => {
  const { adapter, reader } = build();
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 1 },
    { partition: 'a', value: 'a1', bytes: 1 },
    { partition: 'a', value: 'a2', bytes: 1 },
  ]);
  adapter.trim('a', 2);

  const result = await reader.read({
    partitions: ['a'],
    startOffsets: { a: 0 },
    minBytes: 1,
    maxBytes: 10,
    maxRecords: 10,
    waitMs: 0,
  });
  assert.equal(result.partitions[0].firstOffset, 2);
  assert.deepEqual(valuesOf(result, 'a'), ['a2']);
  assert.equal(result.nextOffsets.a, 3);
});

test('invalid requests are rejected synchronously', () => {
  const { reader } = build();
  assert.throws(
    () =>
      reader.read({
        partitions: ['a', 'a'],
        startOffsets: { a: 0 },
        minBytes: 0,
        maxBytes: 1,
        maxRecords: 1,
        waitMs: 0,
      }),
    /duplicate partition/,
  );
  assert.throws(
    () =>
      reader.read({
        partitions: ['a'],
        startOffsets: {},
        minBytes: 0,
        maxBytes: 1,
        maxRecords: 1,
        waitMs: 0,
      }),
    /startOffsets\[a\]/,
  );
  assert.throws(
    () =>
      reader.read({
        partitions: ['a'],
        startOffsets: { a: 0 },
        minBytes: -1,
        maxBytes: 1,
        maxRecords: 1,
        waitMs: 0,
      }),
    /minBytes/,
  );
});
