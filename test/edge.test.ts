import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { InMemoryNetwork } from '../src/network.ts';
import { MulticastSource } from '../src/source.ts';
import { MulticastReceiver } from '../src/receiver.ts';
import { seededRandom } from '../src/random.ts';

function rig(startAt: number) {
  const clock = new ManualClock();
  const network = new InMemoryNetwork({ clock, random: seededRandom(5), defaultPolicy: { delayMs: 1 } });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    repairWindowSize: 64,
    announceIntervalMs: 20,
  });
  const delivered: number[] = [];
  const receiver = new MulticastReceiver({
    sourceId: 's',
    receiverId: 'r',
    network,
    clock,
    random: seededRandom(6),
    startAt,
    initialNackDelayMs: 5,
    initialJitterMs: 0,
    repairWaitMs: 40,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    onPayload: (seq) => delivered.push(seq),
  });
  return { clock, network, source, receiver, delivered };
}

test('a receiver starting late delivers from its requested start point', () => {
  const { clock, source, delivered } = rig(6);
  for (let i = 1; i <= 3; i++) {
    source.publish(`p${i}`);
    clock.advance(2);
  }
  clock.advance(100);
  assert.deepEqual(delivered, [], 'nothing before the requested start point');
  for (let i = 4; i <= 12; i++) {
    source.publish(`p${i}`);
    clock.advance(2);
  }
  clock.advance(500);
  assert.deepEqual(delivered, [6, 7, 8, 9, 10, 11, 12]);
});

test('data arriving before the start point is treated as irrelevant, not a gap', () => {
  const { clock, source, receiver, delivered } = rig(4);
  for (let i = 1; i <= 8; i++) {
    source.publish(`p${i}`);
    clock.advance(2);
  }
  clock.advance(300);
  assert.deepEqual(delivered, [4, 5, 6, 7, 8]);
  // Packets 1..3 arrived ahead of start (before the generation was known) and
  // were never requests; no spurious NACK for them.
  assert.equal(receiver.stats.nacksSent, 0);
});

test('a NACK spanning below the floor and above the upper bound is served only within the window', () => {
  const clock = new ManualClock();
  const network = new InMemoryNetwork({ clock, defaultPolicy: { delayMs: 1 } });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    repairWindowSize: 4,
    announceIntervalMs: 1_000,
  });
  const repairs: number[] = [];
  network.subscribe('tap', (packet) => {
    if (packet.kind === 'repair') repairs.push(packet.seq);
  });
  for (let i = 1; i <= 10; i++) source.publish(`p${i}`);
  // floor = 7, upper = 10. Ask for 1..20.
  network.broadcast('r', {
    kind: 'nack',
    sourceId: 's',
    generation: source.currentGeneration,
    receiverId: 'r',
    ranges: [{ start: 1, end: 20 }],
    floor: 1,
    upperBound: 20,
  });
  clock.advance(10);
  assert.deepEqual(repairs.sort((a, b) => a - b), [7, 8, 9, 10]);
  assert.equal(source.stats.unavailableRepairs, 6);
});

test('a source with the announcement timer disabled still answers directed NACKs', () => {
  const clock = new ManualClock();
  const network = new InMemoryNetwork({ clock, defaultPolicy: { delayMs: 1 } });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    repairWindowSize: 8,
    announceIntervalMs: 0,
  });
  const delivered: number[] = [];
  network.when((_f, to, p) => to === 'r' && p.kind === 'data' && p.seq === 2, { drop: 1 });
  const receiver = new MulticastReceiver({
    sourceId: 's',
    receiverId: 'r',
    network,
    clock,
    random: seededRandom(8),
    initialNackDelayMs: 5,
    initialJitterMs: 0,
    repairWaitMs: 40,
    onPayload: (seq) => delivered.push(seq),
  });
  for (let i = 1; i <= 4; i++) {
    source.publish(`p${i}`);
    clock.advance(2);
  }
  clock.advance(500);
  assert.deepEqual(delivered, [1, 2, 3, 4]);
  assert.equal(source.stats.announcesSent, 1, 'only the initial announce was sent');
  assert.equal(receiver.stats.nacksSent >= 1, true);
});

test('restart resets numbering and the receiver requests from 1 again', () => {
  const { clock, source, receiver, delivered } = rig(1);
  for (let i = 1; i <= 5; i++) {
    source.publish(`p${i}`);
    clock.advance(2);
  }
  clock.advance(100);
  assert.deepEqual(delivered, [1, 2, 3, 4, 5]);
  const gen = source.restart();
  for (let i = 1; i <= 3; i++) {
    source.publish(`q${i}`);
    clock.advance(2);
  }
  clock.advance(200);
  assert.equal(receiver.currentGeneration, gen);
  assert.deepEqual(delivered, [1, 2, 3, 4, 5, 1, 2, 3]);
});

test('close() detaches the receiver from the network', () => {
  const { clock, source, receiver, delivered } = rig(1);
  source.publish('p1');
  clock.advance(5);
  assert.deepEqual(delivered, [1]);
  receiver.close();
  source.publish('p2');
  clock.advance(50);
  assert.deepEqual(delivered, [1]);
});
