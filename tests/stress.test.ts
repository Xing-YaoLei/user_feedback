import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';
import { LongPollReader } from '../src/reader.ts';
import type { ReadResult } from '../src/types.ts';

test('stress: interleaved appends, deadlines and cancellations settle once with no leaks', async () => {
  const partitions = ['a', 'b', 'c'];
  const adapter = new InMemoryLogAdapter(partitions);
  const reader = new LongPollReader(adapter);

  const results: ReadResult[] = [];
  const controllers: AbortController[] = [];
  const promises: Promise<ReadResult>[] = [];

  for (let i = 0; i < 60; i += 1) {
    const controller = new AbortController();
    controllers.push(controller);
    const selected = partitions.filter((_, index) => (index + i) % 2 === 0);
    promises.push(
      reader.read({
        partitions: selected.length > 0 ? selected : ['a'],
        startOffsets: Object.fromEntries(
          (selected.length > 0 ? selected : ['a']).map((name) => [
            name,
            adapter.offsets(name).nextOffset,
          ]),
        ),
        minBytes: 4 + (i % 5) * 2,
        maxBytes: 40,
        maxRecords: 20,
        waitMs: 5 + (i % 7),
        signal: i % 3 === 0 ? controller.signal : undefined,
      }),
    );
  }

  // Drive appends from a different turn, cancelling some reads as we go.
  for (let step = 0; step < 80; step += 1) {
    const name = partitions[step % partitions.length] as string;
    adapter.append(name, `v${step}`, 1 + (step % 6));
    if (step % 4 === 0) controllers[step % controllers.length]?.abort();
    if (step % 9 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  for (const [index, controller] of controllers.entries()) {
    if (index % 6 === 5) controller.abort();
  }

  for (const promise of promises) results.push(await promise);

  assert.equal(results.length, 60);
  for (const result of results) {
    assert.ok(['min-bytes', 'deadline', 'cancelled'].includes(result.status));
    assert.ok(result.bytes <= 40 || result.recordCount === 1, 'pack exceeded maxBytes');
    assert.ok(result.recordCount <= 20, 'pack exceeded maxRecords');
    assert.equal(result.bytes, result.partitions.reduce((sum, part) => sum + part.bytes, 0));
    assert.equal(
      result.recordCount,
      result.partitions.reduce((sum, part) => sum + part.records.length, 0),
    );
    if (result.status === 'cancelled') {
      assert.equal(result.revision, null);
      assert.equal(result.recordCount, 0);
    }
  }
  assert.equal(adapter.subscriberCount, 0);
  assert.equal(reader.pendingReads, 0);
  assert.equal(reader.activeSubscriptions, 0);
});

test('stress: repeated short reads drain every record exactly once', async () => {
  const adapter = new InMemoryLogAdapter(['a', 'b']);
  const reader = new LongPollReader(adapter);
  const expected: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const name = i % 3 === 0 ? 'b' : 'a';
    const value = `${name}${i}`;
    expected.push(value);
    adapter.append(name, value, 1 + (i % 4));
  }

  const offsets: Record<string, number> = { a: 0, b: 0 };
  const collectedA: unknown[] = [];
  const collectedB: unknown[] = [];
  for (let guard = 0; guard < 300; guard += 1) {
    const result = await reader.read({
      partitions: ['a', 'b'],
      startOffsets: offsets,
      minBytes: 3,
      maxBytes: 6,
      maxRecords: 6,
      waitMs: 0,
    });
    for (const part of result.partitions) {
      if (part.partition === 'a') collectedA.push(...part.records.map((r) => r.value));
      else collectedB.push(...part.records.map((r) => r.value));
      offsets[part.partition] = part.nextOffset;
    }
    const remainingA = adapter.offsets('a').nextOffset - (offsets.a as number);
    const remainingB = adapter.offsets('b').nextOffset - (offsets.b as number);
    if (remainingA <= 0 && remainingB <= 0) break;
  }

  for (const partition of ['a', 'b'] as const) {
    const collected = partition === 'a' ? collectedA : collectedB;
    const expectedFor = expected
      .filter((value) => value.startsWith(partition))
      .map((value) => value);
    assert.deepEqual(collected, expectedFor, `${partition} drained in order, no duplicates`);
  }
});
