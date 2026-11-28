import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';
import { LongPollReader } from '../src/reader.ts';
import { flush, makeReader, valuesOf } from './helpers.ts';

test('appends received while parked never push the pack past maxBytes', async () => {
  const { adapter, reader } = makeReader();
  // One 6-byte record already present; minBytes is 20 (never satisfiable
  // under maxBytes 10 while only 6-byte records exist).
  adapter.append('a', 'a0', 6);

  const pending = reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 20,
    maxBytes: 10,
    maxRecords: 100,
    waitMs: 40,
  });
  await flush();

  // Several appends land during the wait. Every fresh pack rebuilds from the
  // requested offsets against the same 10-byte budget, so none may exceed it.
  adapter.append('b', 'b0', 4);
  adapter.append('a', 'a1', 4);
  adapter.append('b', 'b1', 4);

  const result = await pending;
  assert.equal(result.status, 'deadline');
  assert.ok(result.bytes <= 10, `packed ${result.bytes} bytes, cap 10`);
  // Round 1 takes a0 (6) then b0 would be 10 — exactly the cap, so both fit;
  // a 3rd record would overflow and end the pack.
  assert.ok(result.recordCount >= 1);
  for (const part of result.partitions) {
    assert.ok(part.bytes <= 10);
  }
});

test('the oversized-first rule still respects maxRecords = 1', async () => {
  const { adapter, reader } = makeReader();
  adapter.appendBatch([
    { partition: 'a', value: 'huge', bytes: 50 },
    { partition: 'b', value: 'small', bytes: 1 },
  ]);

  const result = await reader.read({
    partitions: ['a', 'b'],
    startOffsets: { a: 0, b: 0 },
    minBytes: 60,
    maxBytes: 5,
    maxRecords: 1,
    waitMs: 0,
  });

  assert.equal(result.recordCount, 1);
  assert.deepEqual(valuesOf(result, 'a'), ['huge']);
  assert.deepEqual(valuesOf(result, 'b'), []);
  assert.equal(result.bytes, 50);
});
