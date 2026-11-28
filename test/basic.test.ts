import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { InMemoryNetwork } from '../src/network.ts';
import { MulticastSource } from '../src/source.ts';
import { MulticastReceiver } from '../src/receiver.ts';
import type { ReceiverOptions } from '../src/receiver.ts';
import { seededRandom } from '../src/random.ts';

function setup(receiverOptions: Partial<ReceiverOptions> = {}) {
  const clock = new ManualClock();
  const random = seededRandom(7);
  const network = new InMemoryNetwork({ clock, random });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    random,
    repairWindowSize: 8,
    announceIntervalMs: 50,
    repairMode: 'multicast',
  });
  const delivered: { seq: number; payload: unknown }[] = [];
  const resyncs: unknown[] = [];
  const receiver = new MulticastReceiver({
    sourceId: 's',
    receiverId: 'r',
    network,
    clock,
    random: seededRandom(99),
    initialNackDelayMs: 10,
    initialJitterMs: 0,
    repairWaitMs: 100,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    peerSuppressMs: 80,
    onPayload: (seq, payload) => delivered.push({ seq, payload }),
    onResyncRequired: (request) => resyncs.push(request),
    ...receiverOptions,
  });
  return { clock, network, source, receiver, delivered, resyncs };
}

test('delivers a clean stream in order exactly once', () => {
  const { clock, source, delivered } = setup();
  for (let i = 1; i <= 5; i++) {
    source.publish(`p${i}`);
    clock.advance(5);
  }
  clock.advance(100);
  assert.deepEqual(
    delivered.map((d) => d.seq),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    delivered.map((d) => d.payload),
    ['p1', 'p2', 'p3', 'p4', 'p5'],
  );
});

test('buffers out-of-order data and delivers it in sequence once the gap is repaired', () => {
  const { clock, network, source, delivered } = setup();
  // Lose seq 2 for the receiver on the data channel only (repairs still work).
  network.when(
    (_from, to, packet) => to === 'r' && packet.kind === 'data' && packet.seq === 2,
    { drop: 1 },
  );
  for (let i = 1; i <= 4; i++) {
    source.publish(`p${i}`);
    clock.advance(5);
  }
  clock.advance(500);
  assert.deepEqual(
    delivered.map((d) => d.seq),
    [1, 2, 3, 4],
  );
});

test('merges multiple missing ranges into a single NACK', () => {
  const { clock, network, source, delivered } = setup({
    initialNackDelayMs: 40,
    initialJitterMs: 0,
  });
  const nacks: { ranges: readonly { start: number; end: number }[] }[] = [];
  // Observe NACKs by subscribing a passive probe to the multicast channel.
  network.subscribe('probe', (packet) => {
    if (packet.kind === 'nack') nacks.push(packet);
  });
  // Drop data 3,4 and 7 before the receiver ever buffers them.
  network.when(
    (_from, to, packet) =>
      to === 'r' && packet.kind === 'data' && (packet.seq === 3 || packet.seq === 4 || packet.seq === 7),
    { drop: 1 },
  );
  // Publish a burst so every gap is discovered during one evaluation pass and
  // therefore shares one NACK deadline.
  for (let i = 1; i <= 9; i++) source.publish(`p${i}`);
  clock.advance(0);
  clock.advance(60);
  const first = nacks[0];
  assert.ok(first, 'expected a NACK');
  assert.deepEqual(
    first!.ranges.map((r) => `${r.start}-${r.end}`).sort(),
    ['3-4', '7-7'],
  );
  clock.advance(1000);
  assert.deepEqual(
    delivered.map((d) => d.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(network.log.filter((e) => e.to === 'r' && e.packet.kind === 'data').length, 0);
});
