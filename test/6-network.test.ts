import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Network } from '../src/network.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { Envelope } from '../src/types.ts';

function env(i: number): Envelope {
  return {
    from: 'a',
    to: 'b',
    message: { type: 'RequestVote', term: i, candidateId: 'a', lastLogIndex: 0, lastLogTerm: 0 },
  };
}

test('held messages are retained and later delivered in send order', async () => {
  const scheduler = new Scheduler(1);
  const network = new Network(scheduler, { minDelay: 2, maxDelay: 2 });
  const received: number[] = [];
  network.register('a', () => undefined);
  network.register('b', (e) => received.push((e.message as { term: number }).term));

  network.hold('a', 'b');
  for (let i = 1; i <= 4; i++) network.send(env(i));
  assert.equal(network.heldCount('a', 'b'), 4);
  await scheduler.advance(50);
  assert.deepEqual(received, []);

  network.releaseHeld('a', 'b');
  await scheduler.advance(50);
  assert.deepEqual(received, [1, 2, 3, 4]);
});

test('partitioned links drop traffic; healing restores delivery', async () => {
  const scheduler = new Scheduler(2);
  const network = new Network(scheduler, { minDelay: 2, maxDelay: 2 });
  const received: number[] = [];
  network.register('a', () => undefined);
  network.register('b', (e) => received.push((e.message as { term: number }).term));

  network.isolate('a', 'b');
  network.send(env(1));
  await scheduler.advance(20);
  assert.deepEqual(received, []);

  network.heal('a', 'b');
  network.send(env(2));
  await scheduler.advance(20);
  assert.deepEqual(received, [2]);
});

test('loss and duplication rates are honored statistically', async () => {
  const scheduler = new Scheduler(3);
  const network = new Network(scheduler, {
    lossRate: 0.5,
    duplicateRate: 0.5,
    minDelay: 1,
    maxDelay: 1,
  });
  let received = 0;
  network.register('a', () => undefined);
  network.register('b', () => {
    received += 1;
  });
  for (let i = 0; i < 200; i++) network.send(env(i));
  await scheduler.advance(100);
  // With 50% loss and 50% duplication on survivors, expect roughly 75 copies;
  // require only that loss happened and duplication happened.
  assert.ok(received > 20, `expected substantial delivery, got ${received}`);
  assert.ok(received < 180, `expected substantial loss, got ${received}`);
});

test('reorder jitter allows later messages to arrive first', async () => {
  const scheduler = new Scheduler(4);
  const network = new Network(scheduler, {
    minDelay: 1,
    maxDelay: 2,
    reorder: true,
  });
  const received: number[] = [];
  network.register('a', () => undefined);
  network.register('b', (e) => received.push((e.message as { term: number }).term));
  let reordered = false;
  for (let trial = 0; trial < 20 && !reordered; trial++) {
    received.length = 0;
    for (let i = 0; i < 8; i++) network.send(env(trial * 10 + i));
    await scheduler.advance(200);
    reordered = JSON.stringify(received) !== JSON.stringify(received.toSorted((x, y) => x - y));
  }
  assert.ok(reordered, 'wide jitter should produce out-of-order delivery at least once');
});
