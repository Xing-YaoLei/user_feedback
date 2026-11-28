import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';

const adapter = new InMemoryLogAdapter(['orders', 'payments']);

adapter.appendBatch([
  { partition: 'orders', value: 'o1', bytes: 10 },
  { partition: 'payments', value: 'p1', bytes: 10 },
  { partition: 'orders', value: 'o2', bytes: 10 },
  { partition: 'payments', value: 'p2', bytes: 10 },
  { partition: 'orders', value: 'o3', bytes: 10 },
]);

for (const partition of adapter.partitions()) {
  const snapshot = adapter.snapshot(partition);
  console.log(partition, snapshot.startOffset, '->', snapshot.nextOffset, snapshot.records.map((r) => r.value));
}

const unsubscribe = adapter.subscribe((change) => {
  console.log('change', change.revision, change.partitions.join(','));
}, adapter.snapshotRevision());

adapter.append('orders', 'o4', 10);
adapter.appendBatch([
  { partition: 'payments', value: 'p3', bytes: 10 },
  { partition: 'orders', value: 'o5', bytes: 10 },
]);

unsubscribe();
console.log('subscribers after unsubscribe:', adapter.subscriberCount);
