import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { InMemoryNetwork } from '../src/network.ts';
import { MulticastSource } from '../src/source.ts';
import { MulticastReceiver } from '../src/receiver.ts';
import type { ResyncRequest } from '../src/receiver.ts';
import { seededRandom } from '../src/random.ts';
import type { Packet } from '../src/types.ts';

interface Harness {
  clock: ManualClock;
  network: InMemoryNetwork;
  source: MulticastSource;
  receiver: MulticastReceiver;
  delivered: { seq: number; payload: unknown }[];
  resyncs: ResyncRequest[];
  changes: { from: number; to: number }[];
  sent: Packet[];
}

function harness(options: {
  repairWindowSize?: number;
  receiver?: Record<string, unknown>;
  startAt?: number;
} = {}): Harness {
  const clock = new ManualClock();
  const random = seededRandom(42);
  const network = new InMemoryNetwork({
    clock,
    random,
    defaultPolicy: { delayMs: 1 },
  });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    random,
    repairWindowSize: options.repairWindowSize ?? 8,
    announceIntervalMs: 25,
    repairMode: 'unicast',
  });
  const delivered: { seq: number; payload: unknown }[] = [];
  const resyncs: ResyncRequest[] = [];
  const changes: { from: number; to: number }[] = [];
  const receiver = new MulticastReceiver({
    sourceId: 's',
    receiverId: 'r',
    network,
    clock,
    random: seededRandom(77),
    startAt: options.startAt ?? 1,
    initialNackDelayMs: 5,
    initialJitterMs: 0,
    repairWaitMs: 50,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    peerSuppressMs: 50,
    onPayload: (seq, payload) => delivered.push({ seq, payload }),
    onResyncRequired: (request) => resyncs.push(request),
    onGenerationChange: (change) => changes.push({ from: change.from, to: change.to }),
    ...(options.receiver as object | undefined),
  });
  const sent: Packet[] = [];
  network.subscribe('tap', (packet) => sent.push(packet));
  return { clock, network, source, receiver, delivered, resyncs, changes, sent };
}

test('source emits monotonic sequence numbers and a fixed payload', () => {
  const { source } = harness();
  const a = source.publish({ n: 1 });
  const b = source.publish({ n: 2 });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.deepEqual(a.payload, { n: 1 });
  assert.equal(source.stats.published, 2);
});

test('receiver de-duplicates a repeated data packet and does not deliver twice', () => {
  const { clock, source, receiver, delivered } = harness();
  source.publish('x');
  clock.advance(5);
  const gen = source.currentGeneration;
  receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq: 1, payload: 'x' }, 's');
  clock.advance(5);
  assert.deepEqual(delivered, [{ seq: 1, payload: 'x' }]);
  assert.equal(receiver.stats.duplicates, 1);
});

test('a gap is not delivered out of order while missing, and rejected stale NACKs do not leak', () => {
  const { clock, source, receiver, delivered } = harness();
  const gen = source.currentGeneration;
  // Manually deliver seq 2 before seq 1.
  receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq: 2, payload: 'two' }, 's');
  clock.advance(2);
  assert.deepEqual(delivered, []);
  assert.equal(receiver.nextSequence, 1);
  receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq: 1, payload: 'one' }, 's');
  clock.advance(2);
  assert.deepEqual(delivered, [
    { seq: 1, payload: 'one' },
    { seq: 2, payload: 'two' },
  ]);
  assert.equal(receiver.nextSequence, 3);
});

test('receiver rejects a packet from an older generation', () => {
  const { clock, source, receiver, delivered } = harness();
  source.publish('g1');
  clock.advance(5);
  const gen = source.currentGeneration;
  source.restart();
  source.publish('g2');
  clock.advance(5);
  // A late g1 packet must not be delivered.
  receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq: 2, payload: 'late' }, 's');
  clock.advance(5);
  assert.deepEqual(
    delivered.map((d) => d.payload),
    ['g1', 'g2'],
  );
  assert.ok(receiver.stats.staleGenerationPackets >= 1);
});

test('receiver reports a resync request with boundaries when the floor passes it', () => {
  const { clock, network, source, receiver, delivered, resyncs } = harness({
    repairWindowSize: 3,
  });
  const gen = source.currentGeneration;
  // Cut the receiver off from live data and repairs so 1 and 2 stay missing
  // while the source advances far past its window.
  network.when((_from, to, packet) => to === 'r' && packet.kind !== 'announce', { drop: 1 });
  for (let i = 1; i <= 10; i++) source.publish(`p${i}`);
  // Feed seq 3..10 directly to the receiver; 1 and 2 are never seen.
  for (let seq = 3; seq <= 10; seq++) {
    receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq, payload: `p${seq}` }, 's');
    clock.advance(1);
  }
  for (let t = 0; t < 100; t++) {
    clock.advance(10);
    if (resyncs.length > 0) break;
  }
  assert.equal(delivered.length, 0);
  assert.equal(resyncs.length, 1);
  const request = resyncs[0]!;
  assert.equal(request.reason, 'window-lost');
  assert.equal(request.nextExpected, 1);
  assert.ok(request.lowestAvailable > 1);
  // 3..10 were buffered, so only 1..2 is genuinely unrepairable.
  assert.deepEqual(request.missing, [{ start: 1, end: 2 }]);
  assert.equal(request.buffered.length, 1);
  assert.equal(request.buffered[0]!.start, request.lowestAvailable);
  const bufferedEnd = request.buffered[0]!.end;
  assert.ok(request.lowestAvailable >= 8);

  // Resuming at the lowest available sequence delivers the buffered suffix
  // contiguously (10 may have been buffered after the request snapshot).
  receiver.resync(request.lowestAvailable);
  assert.equal(receiver.stats.awaitingResync, false);
  clock.advance(400);
  const seqs = delivered.map((d) => d.seq);
  assert.equal(seqs[0], request.lowestAvailable);
  assert.deepEqual(
    seqs,
    Array.from({ length: seqs.length }, (_, i) => request.lowestAvailable + i),
  );
  assert.ok(seqs.includes(bufferedEnd));
});

test('resync below the floor is rejected by the receiver', () => {
  const { clock, source, receiver, resyncs } = harness({ repairWindowSize: 2 });
  const gen = source.currentGeneration;
  for (let i = 1; i <= 10; i++) source.publish(`p${i}`);
  for (let t = 0; t < 100; t++) {
    clock.advance(10);
    if (resyncs.length > 0) break;
  }
  const floor = resyncs[0]?.lowestAvailable ?? 9;
  assert.throws(() => receiver.resync(floor - 1), /below the repair floor/);
});

test('a source announcement alone reveals tail loss', () => {
  const { clock, source, receiver, delivered } = harness();
  const gen = source.currentGeneration;
  source.publish('one');
  clock.advance(2);
  // Drop the tail packet, but announce an upper bound that includes it.
  source.publish('two');
  clock.advance(2);
  receiver.receive({
    kind: 'announce',
    sourceId: 's',
    generation: gen,
    upperBound: 2,
    floor: source.floor,
  }, 's');
  clock.advance(500);
  assert.deepEqual(
    delivered.map((d) => d.seq),
    [1, 2],
  );
});

test('source ignores NACKs addressed to another source or a stale generation', () => {
  const { clock, network, source } = harness();
  source.publish('one');
  const gen = source.currentGeneration;
  source.restart();
  const before = source.stats.staleNacksIgnored;
  // A stale-generation NACK broadcast on the feedback channel.
  network.broadcast('peer', {
    kind: 'nack',
    sourceId: 's',
    generation: gen,
    receiverId: 'peer',
    ranges: [{ start: 1, end: 1 }],
    floor: 1,
    upperBound: 1,
  });
  clock.advance(5);
  assert.equal(source.stats.staleNacksIgnored, before + 1);
  assert.equal(source.stats.repairsSent, 0);

  // A NACK for a different source is ignored outright.
  const foreignBefore = source.stats.foreignPacketsIgnored;
  network.broadcast('peer', {
    kind: 'nack',
    sourceId: 'other',
    generation: source.currentGeneration,
    receiverId: 'peer',
    ranges: [{ start: 1, end: 1 }],
    floor: 1,
    upperBound: 1,
  });
  clock.advance(5);
  assert.equal(source.stats.foreignPacketsIgnored, foreignBefore + 1);
});

test('unicast repair mode only sends repairs to the requester', () => {
  const { clock, network, source, receiver, delivered } = harness();
  const gen = source.currentGeneration;
  network.when(
    (_from, to, packet) => to === 'r' && packet.kind === 'data' && packet.seq === 2,
    { drop: 1 },
  );
  source.publish('one');
  source.publish('two');
  source.publish('three');
  clock.advance(500);
  assert.deepEqual(
    delivered.map((d) => d.seq),
    [1, 2, 3],
  );
  assert.equal(gen, source.currentGeneration);
  const repairEnvelopes = network.log.filter((e) => e.packet.kind === 'repair');
  assert.ok(repairEnvelopes.length >= 1);
  for (const envelope of repairEnvelopes) {
    assert.equal(envelope.to, 'r');
  }
  assert.equal(receiver.stats.repairsReceived >= 1, true);
});
