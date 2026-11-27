/**
 * Optimality-certificate tests.
 *
 * When demand is left unserved, the reported cut must let a third party prove
 * — from the raw input alone — that no feasible plan could have carried more.
 * These tests check that independent argument, and also cross-check the claimed
 * optimum against exhaustive search on instances small enough to enumerate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../src/planner.ts';
import { verifyCut, verifyPlan } from '../src/verify.ts';
import { bruteForce } from './bruteforce.ts';

test('the cut bound really upper-bounds every feasible flow', () => {
  const input = {
    sources: [
      { id: 's1', demand: 13n },
      { id: 's2', demand: 9n },
      { id: 's3', demand: 5n },
    ],
    clusters: [
      { id: 'c1', capacity: 6n },
      { id: 'c2', capacity: 4n },
      { id: 'c3', capacity: 11n },
    ],
    edges: [
      { source: 's1', cluster: 'c1', cost: 0n },
      { source: 's1', cluster: 'c2', cost: 1n },
      { source: 's2', cluster: 'c2', cost: 0n },
      { source: 's3', cluster: 'c3', cost: 2n },
    ],
  };
  const result = plan(input);
  assert.ok(result.cut !== null);
  const cut = result.cut!;

  assert.deepEqual(verifyCut(input, cut, result.summary.served), { ok: true, errors: [] });

  // Independent upper bound: sources outside the cut send at most their
  // demand; sources inside it can only reach clusters inside it, which absorb
  // at most the cut's cluster capacity.
  const insideSources = new Set(cut.sourceRegion);
  const insideClusters = new Set(cut.clusterRegion);
  for (const edge of input.edges) {
    if (insideSources.has(edge.source)) {
      assert.ok(
        insideClusters.has(edge.cluster),
        `edge ${edge.source}->${edge.cluster} escapes the claimed cut`,
      );
    }
  }
  let outsideDemand = 0n;
  for (const source of input.sources) {
    if (!insideSources.has(source.id)) outsideDemand += source.demand;
  }
  const bound = outsideDemand + cut.clusterCapacity;
  assert.ok(result.summary.served <= bound, 'served exceeds the cut bound');
  assert.equal(result.summary.served, bound, 'the plan must attain the cut bound');

  // Exhaustive search confirms nothing better exists.
  const expected = bruteForce(input)!;
  assert.equal(expected.served, result.summary.served);
  assert.equal(expected.cost, result.summary.totalCost);
});

test('cut bound matches exhaustive search on many random small instances', () => {
  let state = 0xc0ffee >>> 0;
  const random = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  const randInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  for (let round = 0; round < 300; round++) {
    const sources = Array.from({ length: randInt(1, 3) }, (_, i) => ({
      id: `s${i}`,
      demand: BigInt(randInt(0, 4)),
    }));
    const clusters = Array.from({ length: randInt(1, 3) }, (_, j) => ({
      id: `c${j}`,
      capacity: BigInt(randInt(0, 4)),
    }));
    const edges: { source: string; cluster: string; cost: bigint }[] = [];
    for (const source of sources) {
      for (const cluster of clusters) {
        if (random() < 0.4) {
          edges.push({
            source: source.id,
            cluster: cluster.id,
            cost: BigInt(randInt(0, 3)),
          });
        }
      }
    }
    const input = { sources, clusters, edges };
    const result = plan(input);
    const expected = bruteForce(input)!;

    assert.equal(result.summary.served, expected.served, `round ${round}`);
    assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });

    if (result.summary.unserved > 0n) {
      assert.ok(result.cut !== null, `round ${round}: missing cut`);
      assert.deepEqual(
        verifyCut(input, result.cut!, result.summary.served),
        { ok: true, errors: [] },
        `round ${round}: invalid cut`,
      );
    } else {
      assert.equal(result.cut, null, `round ${round}: unexpected cut`);
    }
  }
});

test('a hand-built case where the naive cut is far too pessimistic', () => {
  // Total capacity is 200, but the two starved regions can only reach 10 and
  // 20 units respectively and "rich" offers just 50. The true optimum is
  // therefore 80, not 200; the cut must reflect the reachable capacity and
  // isolate only the exhausted sources.
  const input = {
    sources: [
      { id: 'starved-a', demand: 100n },
      { id: 'starved-b', demand: 100n },
      { id: 'rich', demand: 50n },
    ],
    clusters: [
      { id: 'tiny-a', capacity: 10n },
      { id: 'tiny-b', capacity: 20n },
      { id: 'big', capacity: 170n },
    ],
    edges: [
      { source: 'starved-a', cluster: 'tiny-a', cost: 0n },
      { source: 'starved-b', cluster: 'tiny-b', cost: 0n },
      { source: 'rich', cluster: 'big', cost: 0n },
      { source: 'rich', cluster: 'tiny-a', cost: 1n },
      { source: 'rich', cluster: 'tiny-b', cost: 1n },
    ],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 80n);
  assert.equal(result.summary.unserved, 170n);
  const cut = result.cut!;
  assert.deepEqual(verifyCut(input, cut, result.summary.served), { ok: true, errors: [] });
  // The tight cut must isolate only the exhausted bottleneck sources, not the
  // rich source whose demand was fully met.
  assert.deepEqual(cut.sourceRegion, ['starved-a', 'starved-b']);
  assert.deepEqual(cut.clusterRegion, ['tiny-a', 'tiny-b']);
  assert.equal(cut.cutCapacity, 80n);
});

test('cut arithmetic is exact for huge magnitudes', () => {
  const huge = 10n ** 50n;
  const input = {
    sources: [
      { id: 'a', demand: huge },
      { id: 'b', demand: huge + 1n },
    ],
    clusters: [{ id: 'c', capacity: huge }],
    edges: [{ source: 'a', cluster: 'c', cost: 0n }],
  };
  const result = plan(input);
  assert.equal(result.summary.served, huge);
  assert.equal(result.summary.unserved, huge + 1n);
  const cut = result.cut!;
  assert.equal(cut.cutCapacity, huge);
  assert.equal(cut.unserved, huge + 1n);
  assert.deepEqual(verifyCut(input, cut, result.summary.served), { ok: true, errors: [] });
});
