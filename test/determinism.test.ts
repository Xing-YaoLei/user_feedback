import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from './helpers/sim.ts';
import { ManualClock } from '../src/clock.ts';
import { InMemoryNetwork } from '../src/network.ts';
import { MulticastSource } from '../src/source.ts';
import { MulticastReceiver } from '../src/receiver.ts';
import { seededRandom } from '../src/random.ts';

test('identical seeds reproduce an identical feedback transcript', () => {
  const run = (): string[] => {
    const sim = new Simulation({ repairWindowSize: 16, announceIntervalMs: 25, seed: 777 });
    sim.addReceiver('a', { seed: 1 });
    sim.addReceiver('b', { seed: 2 });
    const gen = sim.source.currentGeneration;
    sim.dropData(gen, [3, 4, 9], ['a', 'b']);
    sim.dropFirstNackFrom(['a']);
    sim.dropRepairTransmissions(gen, [4], 1);
    sim.publishSeries(25, 4);
    sim.advance(3_000);
    return sim.capturedNacks().map(
      (nack) => `${nack.at}:${nack.receiverId}:${nack.ranges.map((r) => `${r.start}-${r.end}`).join(',')}`,
    );
  };
  const first = run();
  const second = run();
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);
});

test('a NACK for data below the repair floor gets an announce, not a repair', () => {
  const clock = new ManualClock();
  const network = new InMemoryNetwork({ clock, defaultPolicy: { delayMs: 1 } });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    repairWindowSize: 3,
    announceIntervalMs: 1_000,
  });
  for (let i = 1; i <= 10; i++) source.publish(`p${i}`);
  assert.equal(source.floor, 8);
  const before = source.stats;
  network.broadcast('r', {
    kind: 'nack',
    sourceId: 's',
    generation: source.currentGeneration,
    receiverId: 'r',
    ranges: [{ start: 1, end: 10 }],
    floor: 1,
    upperBound: 10,
  });
  clock.advance(5);
  const after = source.stats;
  // Only the retained 8..10 are repaired; the rest is reported unavailable.
  assert.equal(after.repairsSent - before.repairsSent, 3);
  assert.ok(after.unavailableRepairs - before.unavailableRepairs >= 7);
});

test('repair budget per request defers the remainder instead of dropping it', () => {
  const clock = new ManualClock();
  const network = new InMemoryNetwork({ clock, defaultPolicy: { delayMs: 1 } });
  const source = new MulticastSource({
    sourceId: 's',
    network,
    clock,
    repairWindowSize: 100,
    announceIntervalMs: 1_000,
    maxRepairsPerRequest: 2,
  });
  for (let i = 1; i <= 6; i++) source.publish(`p${i}`);
  network.broadcast('r', {
    kind: 'nack',
    sourceId: 's',
    generation: source.currentGeneration,
    receiverId: 'r',
    ranges: [{ start: 1, end: 6 }],
    floor: 1,
    upperBound: 6,
  });
  clock.advance(5);
  assert.equal(source.stats.repairsSent, 2);
  assert.equal(source.stats.deferredRepairs, 4);
});

test('an injected random source controls retry backoff deterministically', () => {
  const nackTimes = (randomValue: number): number[] => {
    const clock = new ManualClock();
    const network = new InMemoryNetwork({ clock });
    const source = new MulticastSource({
      sourceId: 's',
      network,
      clock,
      repairWindowSize: 16,
      announceIntervalMs: 1_000,
    });
    const times: number[] = [];
    network.subscribe('tap', (packet) => {
      if (packet.kind === 'nack') times.push(clock.now());
    });
    // Live data/repairs never reach this receiver; hand-feed it instead.
    network.when((_from, to, packet) => to === 'r' && packet.kind !== 'nack', { drop: 1 });
    const gen = source.currentGeneration;
    for (let i = 1; i <= 5; i++) source.publish(`p${i}`);
    const receiver = new MulticastReceiver({
      sourceId: 's',
      receiverId: 'r',
      network,
      clock,
      random: () => randomValue,
      initialNackDelayMs: 10,
      initialJitterMs: 0,
      repairWaitMs: 100,
      backoffBaseMs: 50,
      backoffMaxMs: 50,
    });
    receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq: 1, payload: 'p1' }, 's');
    for (let seq = 3; seq <= 5; seq++) {
      receiver.receive({ kind: 'data', sourceId: 's', generation: gen, seq, payload: `p${seq}` }, 's');
    }
    clock.advance(1_000);
    return times;
  };

  const low = nackTimes(0);
  const high = nackTimes(0.999);
  assert.ok(low.length >= 2, 'expected the first NACK and at least one retry');
  assert.ok(high.length >= 2);
  assert.deepEqual(low.slice(0, 2), [10, 110], 'random()==0 gives zero jitter');
  assert.deepEqual(high.slice(0, 2), [10, 159], 'random()->1 gives maximum jitter (49ms)');
});
