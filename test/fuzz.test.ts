import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { InMemoryNetwork } from '../src/network.ts';
import type { LinkPolicy } from '../src/network.ts';
import { MulticastSource } from '../src/source.ts';
import { MulticastReceiver } from '../src/receiver.ts';
import { seededRandom } from '../src/random.ts';

interface Outcome {
  seqs: number[];
  resyncs: number;
  duplicates: number;
  nacks: number;
  retries: number;
}

/**
 * Run one seeded fault combination through the real components. With a large
 * repair window there is no eviction, so every gap is eventually repairable
 * and every receiver must finish with a contiguous, duplicate-free 1..N.
 */
function runSeed(seed: number, total = 120, receivers = 4): Outcome[] {
  const clock = new ManualClock();
  const random = seededRandom(seed);
  const reliableWindow = total + 16;
  const network = new InMemoryNetwork({
    clock,
    random,
    defaultPolicy: { drop: 0.12, duplicate: 0.05, delayMs: 2, jitterMs: 6 },
  });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    random,
    repairWindowSize: reliableWindow,
    announceIntervalMs: 20,
  });

  const outcomes: Outcome[] = [];
  for (let i = 0; i < receivers; i++) {
    const seqs: number[] = [];
    let resyncs = 0;
    const receiver = new MulticastReceiver({
      sourceId: 's',
      receiverId: `r${i}`,
      network,
      clock,
      random: seededRandom(seed * 31 + i),
      initialNackDelayMs: 15,
      initialJitterMs: 25,
      repairWaitMs: 80,
      backoffBaseMs: 25,
      backoffMaxMs: 200,
      peerSuppressMs: 120,
      maxBufferedSeqs: 256,
      maxNackRanges: 8,
      onPayload: (seq) => seqs.push(seq),
      onResyncRequired: (request) => {
        resyncs += 1;
        receiver.resync(request.lowestAvailable);
      },
    });
    outcomes.push({
      seqs,
      resyncs,
      duplicates: 0,
      nacks: 0,
      retries: 0,
    });
    // Stash the receiver so we can read stats after the run.
    (outcomes[i] as Outcome & { receiver: MulticastReceiver }).receiver = receiver;
  }

  for (let i = 0; i < total; i++) {
    source.publish(`p${i + 1}`);
    clock.advance(6);
  }
  // Drain repairs and announcements; stop once everyone has finished.
  for (let spent = 0; spent < 60_000; spent += 25) {
    clock.advance(25);
    const done = outcomes.every((outcome) => {
      const receiver = (outcome as Outcome & { receiver: MulticastReceiver }).receiver;
      return receiver.nextSequence === total + 1 && receiver.stats.buffered === 0;
    });
    if (done) break;
  }

  for (const outcome of outcomes) {
    const receiver = (outcome as Outcome & { receiver: MulticastReceiver }).receiver;
    outcome.duplicates = receiver.stats.duplicates;
    outcome.nacks = receiver.stats.nacksSent;
    outcome.retries = receiver.stats.nackRetries;
  }
  return outcomes;
}

test('seeded random loss across many seeds always completes in order exactly once', () => {
  let aggregateDuplicates = 0;
  let aggregateRetries = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const outcomes = runSeed(seed);
    for (const [index, outcome] of outcomes.entries()) {
      const expected = Array.from({ length: 120 }, (_, i) => i + 1);
      assert.deepEqual(
        outcome.seqs,
        expected,
        `seed ${seed} receiver ${index}: delivery was not contiguous 1..120`,
      );
      const unique = new Set(outcome.seqs).size;
      assert.equal(unique, outcome.seqs.length, `seed ${seed} receiver ${index}: duplicate delivery`);
      assert.equal(outcome.resyncs, 0, `seed ${seed} receiver ${index}: unexpected resync`);
      aggregateDuplicates += outcome.duplicates;
      aggregateRetries += outcome.retries;
    }
  }
  // The fault model must actually have exercised duplicates and retries.
  assert.ok(aggregateDuplicates > 0, 'fault model never duplicated anything');
  assert.ok(aggregateRetries > 0, 'fault model never forced a NACK retry');
});

/**
 * Small repair window plus heavy seeded loss: resyncs are expected. The
 * invariant is per-epoch contiguity (never skip a sequence silently) and that
 * every reported unrecoverable range is genuinely absent from the stream.
 */
test('with window eviction, every epoch is contiguous and reported gaps never appear', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const clock = new ManualClock();
    const random = seededRandom(seed);
    const network = new InMemoryNetwork({
      clock,
      random,
      defaultPolicy: { drop: 0.25, duplicate: 0.05, delayMs: 2, jitterMs: 8 },
    });
    const total = 150;
    const source = new MulticastSource({
      sourceId: 's',
      network,
      clock,
      random,
      repairWindowSize: 24,
      announceIntervalMs: 15,
    });

    const epochs: number[][] = [[]];
    const reportedGaps: number[] = [];
    const receiver = new MulticastReceiver({
      sourceId: 's',
      receiverId: 'r',
      network,
      clock,
      random: seededRandom(seed * 17),
      initialNackDelayMs: 20,
      initialJitterMs: 30,
      repairWaitMs: 100,
      backoffBaseMs: 30,
      backoffMaxMs: 250,
      peerSuppressMs: 100,
      maxBufferedSeqs: 200,
      onPayload: (seq) => {
        epochs[epochs.length - 1]!.push(seq);
      },
      onResyncRequired: (request) => {
        for (const range of request.missing) {
          for (let seq = range.start; seq <= range.end; seq++) reportedGaps.push(seq);
        }
        epochs.push([]);
        receiver.resync(request.lowestAvailable);
      },
    });

    for (let i = 0; i < total; i++) {
      source.publish(`p${i + 1}`);
      clock.advance(6);
    }
    for (let spent = 0; spent < 120_000; spent += 50) {
      clock.advance(50);
      if (receiver.nextSequence === total + 1 && receiver.stats.buffered === 0) break;
    }

    for (const [index, epoch] of epochs.entries()) {
      for (let i = 1; i < epoch.length; i++) {
        assert.equal(
          epoch[i],
          epoch[i - 1]! + 1,
          `seed ${seed}: epoch ${index} skipped from ${epoch[i - 1]} to ${epoch[i]}`,
        );
      }
      const unique = new Set(epoch).size;
      assert.equal(unique, epoch.length, `seed ${seed}: epoch ${index} repeated a sequence`);
    }
    const deliveredGaps = new Set(reportedGaps).size > 0
      ? [...new Set(reportedGaps)].filter((seq) => epochs.some((epoch) => epoch.includes(seq)))
      : [];
    assert.deepEqual(
      deliveredGaps,
      [],
      `seed ${seed}: reported-unrecoverable sequences were delivered as if contiguous`,
    );
    assert.ok(reportedGaps.length > 0 || receiver.nextSequence === total + 1);
  }
});
