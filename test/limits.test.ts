import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { InMemoryNetwork } from '../src/network.ts';
import { MulticastSource } from '../src/source.ts';
import { MulticastReceiver } from '../src/receiver.ts';
import { seededRandom } from '../src/random.ts';
import type { Packet } from '../src/types.ts';

function rig(receiverOptions: Record<string, unknown> = {}) {
  const clock = new ManualClock();
  const random = seededRandom(1234);
  const network = new InMemoryNetwork({ clock, random, defaultPolicy: { delayMs: 1 } });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    random,
    repairWindowSize: 512,
    announceIntervalMs: 1_000,
  });
  const nacks: Packet[] = [];
  const resyncs: unknown[] = [];
  const delivered: number[] = [];
  network.subscribe('tap', (packet) => {
    if (packet.kind === 'nack') nacks.push(packet);
  });
  const receiver = new MulticastReceiver({
    sourceId: 's',
    receiverId: 'r',
    network,
    clock,
    random: seededRandom(9),
    initialNackDelayMs: 10,
    initialJitterMs: 0,
    repairWaitMs: 100,
    backoffBaseMs: 20,
    backoffMaxMs: 100,
    peerSuppressMs: 100,
    onPayload: (seq) => delivered.push(seq),
    onResyncRequired: (request) => resyncs.push(request),
    ...receiverOptions,
  });
  return { clock, network, source, receiver, nacks, resyncs, delivered };
}

/** Stop live data reaching the receiver so tests can feed packets by hand. */
function isolateReceiver(network: InMemoryNetwork, receiverId: string): void {
  network.when(
    (_from, to, packet) =>
      to === receiverId && (packet.kind === 'data' || packet.kind === 'repair'),
    { drop: 1 },
  );
}

test('receive cache is bounded and caps out-of-order buffering', () => {
  const { clock, network, source, receiver } = rig({ maxBufferedSeqs: 4 });
  isolateReceiver(network, 'r');
  const gen = source.currentGeneration;
  for (let seq = 1; seq <= 30; seq++) {
    source.publish(`p${seq}`);
  }
  // Feed 10..30 directly: seq 1..9 never arrive, so all of 10..30 are future.
  for (let seq = 10; seq <= 30; seq++) {
    receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq, payload: `p${seq}` }, 's');
    clock.advance(1);
  }
  assert.ok(receiver.stats.buffered <= 4, `buffered ${receiver.stats.buffered} exceeded cap`);
  assert.ok(receiver.stats.bufferOverflowDrops >= 1);
});

test('feedback backlog is bounded per NACK packet and per tick', () => {
  const { clock, network, source, receiver, nacks } = rig({
    maxBufferedSeqs: 512,
    maxNackRanges: 2,
    maxPendingFeedbackRanges: 3,
  });
  isolateReceiver(network, 'r');
  const gen = source.currentGeneration;
  // Publish seq 1..40, then feed odd sequences only, leaving many singleton gaps.
  for (let seq = 1; seq <= 40; seq++) source.publish(`p${seq}`);
  for (let seq = 1; seq <= 39; seq += 2) {
    receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq, payload: `p${seq}` }, 's');
  }
  clock.advance(20);
  assert.ok(nacks.length >= 1, 'expected feedback');
  for (const nack of nacks as { ranges: unknown[] }[]) {
    assert.ok(nack.ranges.length <= 2, `packet exceeded maxNackRanges: ${JSON.stringify(nack.ranges)}`);
  }
  assert.equal(receiver.stats.nacksSent >= 1, true);
});

test('a suppressed gap is not silently re-requested by range merging', () => {
  const { clock, network, source, receiver, nacks } = rig({
    maxNackRanges: 16,
    maxPendingFeedbackRanges: 16,
    peerSuppressMs: 10_000,
    initialNackDelayMs: 5,
    initialJitterMs: 0,
  });
  isolateReceiver(network, 'r');
  const gen = source.currentGeneration;
  for (let seq = 1; seq <= 10; seq++) source.publish(`p${seq}`);

  // Establish the generation with seq 1 so the peer NACK is not discarded.
  receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq: 1, payload: 'p1' }, 's');
  clock.advance(1);

  // A peer asks for 2..3 immediately; we will hold 4 as missing too.
  receiver.receive({
    kind: 'nack',
    sourceId: 's',
    generation: gen,
    receiverId: 'peer',
    ranges: [{ start: 2, end: 3 }],
    floor: 1,
    upperBound: 10,
  }, 'peer');
  clock.advance(1);

  // We buffer 5..10 but skip 2..4.
  for (let seq = 5; seq <= 10; seq++) {
    receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq, payload: `p${seq}` }, 's');
  }
  clock.advance(30);

  // Our NACK should request 4 only, never merging across the suppressed 2..3.
  assert.ok(nacks.length >= 1, 'expected a NACK for the unsuppressed gap');
  const ours = (nacks as { receiverId: string; ranges: { start: number; end: number }[] }[]).filter(
    (nack) => nack.receiverId === 'r',
  );
  assert.ok(ours.length >= 1);
  for (const nack of ours) {
    for (const range of nack.ranges) {
      assert.ok(
        range.end < 2 || range.start > 3,
        `NACK range ${range.start}-${range.end} re-requests the peer-suppressed gap`,
      );
    }
  }
  assert.ok(receiver.stats.deferredByPeer >= 1);
  // After the suppression window expires we do request the peer's gap.
  clock.advance(10_000);
  const later = (nacks as { receiverId: string; ranges: { start: number; end: number }[] }[])
    .filter((nack) => nack.receiverId === 'r')
    .some((nack) => nack.ranges.some((range) => range.start <= 2 && range.end >= 2));
  assert.equal(later, true, 'after peer suppression expires we must request 2..3 ourselves');
});
