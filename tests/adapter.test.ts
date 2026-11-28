import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';

test('snapshot pinning excludes later appends and keeps per-partition order', () => {
  const adapter = new InMemoryLogAdapter(['a', 'b']);
  adapter.appendBatch([
    { partition: 'a', value: 'a0', bytes: 5 },
    { partition: 'b', value: 'b0', bytes: 5 },
  ]);
  const pinned = adapter.snapshotRevision();

  adapter.appendBatch([
    { partition: 'a', value: 'a1', bytes: 5 },
    { partition: 'b', value: 'b1', bytes: 5 },
  ]);

  const aNow = adapter.snapshot('a', adapter.snapshotRevision());
  assert.deepEqual(aNow.records.map((r) => r.value), ['a0', 'a1']);
  const aPinned = adapter.snapshot('a', pinned);
  assert.deepEqual(aPinned.records.map((r) => r.value), ['a0']);
  assert.equal(aPinned.nextOffset, 1);
  assert.equal(aPinned.revision, pinned);

  // Pinned snapshots of different partitions agree on what had landed.
  const bPinned = adapter.snapshot('b', pinned);
  assert.equal(bPinned.nextOffset, 1);
  assert.deepEqual(bPinned.records.map((r) => r.value), ['b0']);
});

test('subscribe replays changes after the baseline revision', () => {
  const adapter = new InMemoryLogAdapter(['a', 'b']);
  adapter.append('a', 'a0', 5);
  const baseline = adapter.snapshotRevision();
  adapter.append('b', 'b0', 5);
  adapter.appendBatch([
    { partition: 'a', value: 'a1', bytes: 5 },
    { partition: 'b', value: 'b1', bytes: 5 },
  ]);

  const seen: { revision: number; partitions: string[] }[] = [];
  const unsubscribe = adapter.subscribe((change) => {
    seen.push({ revision: change.revision, partitions: [...change.partitions] });
  }, baseline);
  unsubscribe();

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { revision: 2, partitions: ['b'] });
  assert.deepEqual(seen[1], { revision: 3, partitions: ['a', 'b'] });
});

test('subscribe replays a change appended inside the subscription setup window', () => {
  let injected = false;
  const adapter: InMemoryLogAdapter = new InMemoryLogAdapter(['a'], {
    onSubscribe: (self, since) => {
      if (injected || since === undefined) return;
      injected = true;
      self.append('a', 'late', 5);
    },
  });
  const baseline = adapter.snapshotRevision();
  const seen: number[] = [];
  adapter.subscribe((change) => seen.push(change.revision), baseline);
  assert.equal(injected, true);
  assert.deepEqual(seen, [1]);
  assert.equal(adapter.snapshot('a').nextOffset, 1);
});

test('unsubscribe stops delivery and is idempotent', () => {
  const adapter = new InMemoryLogAdapter(['a']);
  const seen: number[] = [];
  const unsubscribe = adapter.subscribe((change) => seen.push(change.revision));
  adapter.append('a', 'a0', 5);
  unsubscribe();
  unsubscribe();
  adapter.append('a', 'a1', 5);
  assert.deepEqual(seen, [1]);
  assert.equal(adapter.subscriberCount, 0);
});

test('trim moves the retained window and pinned snapshots stay consistent', () => {
  const adapter = new InMemoryLogAdapter(['a']);
  adapter.append('a', 'a0', 5);
  adapter.append('a', 'a1', 5);
  adapter.append('a', 'a2', 5);
  adapter.trim('a', 2);
  const snapshot = adapter.snapshot('a');
  assert.equal(snapshot.startOffset, 2);
  assert.equal(snapshot.nextOffset, 3);
  assert.deepEqual(snapshot.records.map((r) => r.value), ['a2']);
  assert.equal(adapter.trimmedRecords, 2);

  // A snapshot pinned before the trim cannot recover trimmed records, but it
  // must never report an offset below the retained window.
  const pinned = adapter.snapshot('a', 1);
  assert.equal(pinned.startOffset, 2);
  assert.ok(pinned.nextOffset >= pinned.startOffset);
});
