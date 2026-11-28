/**
 * End-to-end demo: a consumer long-polls two partitions, a producer appends
 * on one of them, and a second read resumes from the returned offsets.
 *
 * Run with `npm start`.
 */
import { InMemoryLogAdapter } from '../src/adapters/in-memory.ts';
import { LongPollReader } from '../src/reader.ts';
import type { ReadResult } from '../src/types.ts';

function summarize(result: ReadResult): string {
  const parts = result.partitions
    .map((part) => `${part.partition}=${part.records.map((r) => String(r.value)).join(',') || '-'}`)
    .join(' ');
  return `${result.status} rev=${result.revision} bytes=${result.bytes} records=${result.recordCount} (${parts})`;
}

const adapter = new InMemoryLogAdapter(['orders', 'payments']);
const reader = new LongPollReader(adapter);

// Producer: two orders, then a payment shortly after.
adapter.appendBatch([
  { partition: 'orders', value: 'order-1', bytes: 8 },
  { partition: 'orders', value: 'order-2', bytes: 8 },
]);

const first = reader.read({
  partitions: ['orders', 'payments'],
  startOffsets: { orders: 0, payments: 0 },
  minBytes: 24,
  maxBytes: 64,
  maxRecords: 8,
  waitMs: 100,
});
console.log('read #1 parked on orders/payments …');

setTimeout(() => {
  adapter.append('payments', 'payment-1', 8);
}, 20);

console.log(await first.then(summarize));

// The consumer resumes exactly where the first read stopped and long-polls.
const controller = new AbortController();
const second = reader.read({
  partitions: ['orders', 'payments'],
  startOffsets: { orders: 2, payments: 1 },
  minBytes: 16,
  maxBytes: 64,
  maxRecords: 8,
  waitMs: 1000,
  signal: controller.signal,
});

setTimeout(() => {
  adapter.appendBatch([
    { partition: 'orders', value: 'order-3', bytes: 8 },
    { partition: 'payments', value: 'payment-2', bytes: 8 },
  ]);
}, 30);

console.log(await second.then(summarize));

// A third read parks, then is cancelled; no subscription is left behind.
const controller3 = new AbortController();
const third = reader.read({
  partitions: ['orders'],
  startOffsets: { orders: adapter.offsets('orders').nextOffset },
  minBytes: 8,
  maxBytes: 64,
  maxRecords: 4,
  waitMs: 5000,
  signal: controller3.signal,
});
setTimeout(() => controller3.abort(), 10);
console.log(await third.then(summarize));

console.log('live adapter subscriptions:', adapter.subscriberCount);
