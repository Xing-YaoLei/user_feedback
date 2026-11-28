import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from './helpers/sim.ts';

/**
 * The required end-to-end scenario, built on an injectable clock, an injectable
 * seeded RNG (per receiver), and a datagram adapter with scripted faults:
 *
 *   - four receivers, with several *overlapping* loss ranges,
 *   - the first NACK of every receiver is lost,
 *   - a share of repair packets is lost,
 *   - repairs are duplicated and therefore interleave with live data,
 *   - the repair window evicts a gap before it can be repaired, producing an
 *     explicit resync request with boundaries,
 *   - the source restarts (new generation), and stale-generation traffic is
 *     injected to check it cannot enter the new sequence.
 *
 * Then it verifies: in-order exactly-once delivery, the resync signal and its
 * boundary, and that feedback was both suppressed (peer overlap) and
 * retransmitted (lost repair / lost first NACK).
 */
test('overlapping loss, lost first NACKs, lost repairs, window eviction, restart', () => {
  const sim = new Simulation({
    sourceId: 'src',
    seed: 20261128,
    repairWindowSize: 40,
    announceIntervalMs: 20,
  });

  const ids = ['r1', 'r2', 'r3', 'r4'];
  for (const [index, id] of ids.entries()) {
    sim.addReceiver(id, {
      seed: 1000 + index * 7,
      initialNackDelayMs: 15,
      initialJitterMs: 30,
      repairWaitMs: 80,
      backoffBaseMs: 20,
      backoffMaxMs: 160,
      peerSuppressMs: 180,
      maxBufferedSeqs: 96,
      // r1 needs manual resync so the test can inspect the boundary before
      // the caller picks a new start point.
      autoResync: id !== 'r1',
    });
  }

  const generation = sim.source.currentGeneration;
  const total = 200;

  // --- overlapping loss: same sequences missing at several receivers ---
  sim.dropData(generation, [10, 11, 12, 13, 14], ['r1', 'r2', 'r3']);
  sim.dropData(generation, [12, 13, 14, 15, 16, 17, 18], ['r2', 'r3', 'r4']);
  sim.dropData(generation, [40, 41, 42], ['r1', 'r4']);
  sim.dropData(generation, [41, 42, 43, 44, 45, 46], ['r3']);
  sim.dropData(generation, [70, 71, 72, 73], ['r2', 'r4']);

  // Every receiver's first NACK is dropped once.
  sim.dropFirstNackFrom(ids);

  // Lose the first whole multicast repair for the overlapping ranges. Because
  // repairs are multicast, every receiver must retry rather than assume the
  // repair was delivered.
  sim.dropRepairTransmissions(generation, [10, 11, 12, 13, 14, 40, 41, 42], 1);

  // A subset of repairs travels twice, so duplicates interleave with live data.
  sim.duplicateRepairs(generation, [12, 13, 14, 41, 42]);

  // Window eviction: r1 loses 85..87 and their repairs never arrive, so the
  // repair window moves past them. That is the only unrecoverable gap.
  const evicted = [85, 86, 87];
  sim.dropData(generation, evicted, ['r1']);
  sim.withholdRepairs(generation, evicted, Number.POSITIVE_INFINITY);

  sim.publishSeries(total, 12);

  // Run until r1 has fallen out of the window for the evicted gap.
  const r1Rec = sim.receivers.get('r1')!;
  const reachedResync = sim.advanceUntil(
    () => r1Rec.receiver.stats.awaitingResync,
    6_000,
  );
  assert.equal(reachedResync, true, 'r1 must eventually fall out of the repair window');

  // Let the announcement floor advance past the whole evicted block so the
  // reported boundary is stable and complete.
  sim.advanceUntil(
    () => (r1Rec.receiver.resyncRequest?.lowestAvailable ?? 0) > evicted[evicted.length - 1]!,
    2_000,
  );
  const request = r1Rec.receiver.resyncRequest;
  assert.ok(request, 'a resync request must be available');
  assert.equal(request!.reason, 'window-lost');
  assert.equal(request!.sourceId, 'src');
  assert.equal(request!.generation, generation);
  assert.ok(request!.nextExpected < request!.lowestAvailable);
  assert.deepEqual(
    request!.missing.map((range) => `${range.start}-${range.end}`),
    ['85-87'],
    'the resync boundary must report exactly the unrecoverable gap',
  );
  assert.ok(request!.lowestAvailable > evicted[evicted.length - 1]!, 'floor must have passed the gap');
  assert.ok(request!.upperBound >= request!.lowestAvailable);

  // The caller chooses a new start point inside what the receiver can still
  // satisfy: the repair floor, or the first range it already buffered above
  // the floor (both are inside the source's retained window).
  const firstBuffered = request!.buffered.find((range) => range.end >= request!.lowestAvailable);
  const chosenStart = Math.max(request!.lowestAvailable, firstBuffered?.start ?? request!.lowestAvailable);
  assert.ok(chosenStart >= request!.lowestAvailable);
  assert.ok(chosenStart <= request!.upperBound);
  sim.applyResync('r1', chosenStart);

  // Give repairs time to land after the last publish, then finish the run.
  sim.advanceUntil(
    () => ids.every((id) => sim.receivers.get(id)!.receiver.stats.buffered === 0
      && sim.receivers.get(id)!.receiver.nextSequence === total + 1),
    8_000,
  );

  const r1 = r1Rec;
  const r2 = sim.receivers.get('r2')!;
  const r3 = sim.receivers.get('r3')!;
  const r4 = sim.receivers.get('r4')!;

  // --- 1. the reported gap never masquerades as continuous data ---
  for (const record of [r2, r3, r4]) {
    assert.equal(record.resyncs.length, 0, `${record.id} should never need resync`);
    assert.equal(record.epochs.length, 1, `${record.id} should have a single epoch`);
    assert.deepEqual(
      record.epochs[0]!.seqs,
      Array.from({ length: total }, (_, i) => i + 1),
      `${record.id} delivered sequence must be exactly 1..${total} in order`,
    );
  }

  assert.equal(r1.resyncs.length, 1);
  assert.equal(r1.epochs.length, 2);
  assert.equal(r1.epochs[0]!.closedBy, 'resync');
  assert.deepEqual(r1.epochs[0]!.seqs, Array.from({ length: 84 }, (_, i) => i + 1));
  const resumed = r1.epochs[1]!;
  assert.deepEqual(
    resumed.seqs,
    Array.from({ length: total - chosenStart + 1 }, (_, i) => chosenStart + i),
    'r1 must deliver contiguously from the caller-chosen start point',
  );
  // None of the reported (unrecoverable) sequences appears in the stream.
  for (const seq of evicted) {
    assert.equal(
      r1.deliveries.some((delivery) => delivery.generation === generation && delivery.seq === seq),
      false,
      `seq ${seq} was reported as missing and must not be delivered as if continuous`,
    );
  }

  // --- 2. feedback: lost first NACKs caused retransmissions ---
  assert.equal(sim.counters.firstNacksDropped, ids.length);
  for (const record of [r1, r2, r3, r4]) {
    assert.ok(record.receiver.stats.nacksSent >= 1, `${record.id} should send NACKs`);
  }
  // A multicast repair can satisfy a peer that has not retried yet, so retries
  // are checked in aggregate rather than per receiver.
  const retrying = [r1, r2, r3, r4].filter((r) => r.receiver.stats.nackRetries >= 1);
  assert.ok(retrying.length >= 2, `expected retried feedback, got ${retrying.length} receivers`);
  assert.ok(sim.sumStat('nackRetries') >= 2, 'expected feedback retransmissions');
  assert.ok(sim.counters.repairTransmissionsDropped >= 5, 'repairs were actually lost');
  assert.ok(sim.counters.repairDuplicatesInjected >= 1, 'repairs were duplicated on the wire');

  // --- 3. feedback suppression: at least one receiver deferred to a peer ---
  assert.ok(sim.sumStat('deferredByPeer') >= 1, 'expected peer-suppressed NACKs');
  const suppressed = [r1, r2, r3, r4].filter((r) => r.receiver.stats.deferredByPeer > 0);
  assert.ok(suppressed.length >= 1);
  for (const record of suppressed) assert.ok(record.receiver.stats.peerNacksObserved > 0);

  // --- 4. duplicated repairs are de-duplicated at the application boundary ---
  assert.ok(sim.sumStat('duplicates') >= 1, 'receivers must count and drop duplicates');

  // =====================================================================
  //  Source restart. Late generation-1 packets are still on the wire and
  //  a stale NACK is injected; none may enter the new sequence.
  // =====================================================================
  const deliveriesBefore = new Map(ids.map((id) => [id, sim.receivers.get(id)!.deliveries.length]));
  const newGeneration = sim.restart();
  assert.equal(newGeneration, generation + 1);

  sim.publishSeries(30, 8);
  sim.advance(1_500);

  sim.inject({ kind: 'data', sourceId: 'src', generation, seq: 201, payload: 'stale-tail' }, 1);
  sim.inject({ kind: 'data', sourceId: 'src', generation, seq: 5, payload: 'stale-5' }, 2);
  sim.inject(
    {
      kind: 'nack',
      sourceId: 'src',
      generation,
      receiverId: 'r1',
      ranges: [{ start: 1, end: 3 }],
      floor: 1,
      upperBound: 5,
    },
    3,
  );
  sim.advance(800);

  for (const record of sim.receivers.values()) {
    assert.equal(record.generationChanges.length, 1, `${record.id} should adopt the restart once`);
    assert.deepEqual(record.generationChanges[0], {
      sourceId: 'src',
      from: generation,
      to: newGeneration,
    });
    assert.ok(record.receiver.stats.staleGenerationPackets >= 2, `${record.id} must reject stale data`);

    const epoch = record.epochs[record.epochs.length - 1]!;
    assert.equal(epoch.generation, newGeneration);
    assert.deepEqual(
      epoch.seqs,
      Array.from({ length: 30 }, (_, i) => i + 1),
      `${record.id} new-generation sequence must be 1..30 in order`,
    );
    assert.deepEqual(
      record.deliveries.filter((d) => d.payload === 'stale-5' || d.payload === 'stale-tail'),
      [],
    );
    assert.ok(record.deliveries.length > deliveriesBefore.get(record.id)!);
  }

  // The source ignored the stale NACK; it never repairs across generations.
  assert.ok(sim.source.stats.staleNacksIgnored >= 1);

  // Generation-1 delivery is unique per receiver (exactly once).
  for (const record of [r2, r3, r4]) {
    const all = record.deliveries.filter((d) => d.generation === generation).map((d) => d.seq);
    assert.equal(new Set(all).size, all.length, `${record.id} delivered a duplicate`);
  }
});

/** A smaller focused scenario: dropped repairs alone must be retried. */
test('lost repair is retried until delivered', () => {
  const sim = new Simulation({ repairWindowSize: 32, announceIntervalMs: 20, seed: 5 });
  sim.addReceiver('solo', { repairWaitMs: 60, backoffBaseMs: 20, backoffMaxMs: 120 });
  const gen = sim.source.currentGeneration;
  sim.dropData(gen, [3, 4], ['solo']);
  sim.dropRepairCopies(gen, [3, 4], ['solo'], 2);
  sim.publishSeries(10, 3);
  sim.advance(3_000);
  const record = sim.receivers.get('solo')!;
  assert.deepEqual(record.epochs[0]!.seqs, Array.from({ length: 10 }, (_, i) => i + 1));
  assert.ok(record.receiver.stats.nackRetries >= 2);
});

/** Peer suppression: one receiver's NACK defers another's overlapping one. */
test('a peer NACK for the same gap suppresses the local request', () => {
  const sim = new Simulation({ repairWindowSize: 32, announceIntervalMs: 20, seed: 11 });
  sim.addReceiver('fast', { initialNackDelayMs: 10, initialJitterMs: 0, peerSuppressMs: 500 });
  sim.addReceiver('slow', { initialNackDelayMs: 10, initialJitterMs: 0, peerSuppressMs: 500 });
  const gen = sim.source.currentGeneration;
  sim.dropData(gen, [2, 3], ['fast', 'slow']);
  sim.publishSeries(6, 3);
  sim.advance(400);
  const fast = sim.receivers.get('fast')!.receiver.stats;
  const slow = sim.receivers.get('slow')!.receiver.stats;
  // Both share the gap; at least one of them must have observed the peer's
  // NACK and deferred its own.
  assert.ok(fast.deferredByPeer + slow.deferredByPeer >= 1);
  assert.ok(fast.peerNacksObserved + slow.peerNacksObserved >= 1);
  sim.advance(2_000);
  assert.deepEqual(
    sim.receivers.get('fast')!.epochs[0]!.seqs,
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    sim.receivers.get('slow')!.epochs[0]!.seqs,
    [1, 2, 3, 4, 5, 6],
  );
});

test('tail loss is discovered from the upper-bound announcement alone', () => {
  const sim = new Simulation({ repairWindowSize: 16, announceIntervalMs: 20, seed: 3 });
  sim.addReceiver('tail');
  const gen = sim.source.currentGeneration;
  // Lose the final packet of the burst: only the announcement reveals it.
  sim.publishSeries(5, 3);
  sim.dropData(gen, [6], ['tail']);
  sim.publish();
  sim.advance(3_000);
  assert.deepEqual(
    sim.receivers.get('tail')!.epochs[0]!.seqs,
    [1, 2, 3, 4, 5, 6],
  );
});

test('a persistently slow receiver never blocks the others', () => {
  const sim = new Simulation({ repairWindowSize: 8, announceIntervalMs: 20, seed: 9 });
  sim.addReceiver('healthy');
  // This receiver refuses to resync and has a tiny cache; it will stay behind.
  sim.addReceiver('stuck', { autoResync: false, maxBufferedSeqs: 2 });
  const gen = sim.source.currentGeneration;
  sim.dropData(gen, [2], ['stuck']);
  sim.withholdRepairs(gen, [2], Number.POSITIVE_INFINITY);
  sim.publishSeries(40, 2);
  sim.advance(2_000);
  const healthy = sim.receivers.get('healthy')!;
  assert.deepEqual(healthy.epochs[0]!.seqs, Array.from({ length: 40 }, (_, i) => i + 1));
  const stuck = sim.receivers.get('stuck')!;
  assert.equal(stuck.epochs[0]!.seqs[0], 1);
  assert.ok(stuck.receiver.stats.awaitingResync, 'stuck receiver reports resync requirement');
});
