/**
 * Differential tests against an exhaustive reference solver.
 *
 * Random tiny instances are solved both by the planner and by brute force.
 * The reference recomputes the exact objective order (throughput, then cost,
 * then lexicographic share vector), so any divergence points at a real bug in
 * the optimiser or the tie-break, not at a shared assumption.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../src/planner.ts';
import { verifyPlan, shareVector } from '../src/verify.ts';
import { bruteForce, toVector } from './bruteforce.ts';
import type { RefInput } from './bruteforce.ts';

/** Deterministic xorshift32 so failures are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function randomInstance(random: () => number): RefInput {
  const sourceCount = randomInt(random, 1, 3);
  const clusterCount = randomInt(random, 1, 3);
  const sources = Array.from({ length: sourceCount }, (_, i) => ({
    id: `s${i}`,
    demand: BigInt(randomInt(random, 0, 4)),
  }));
  const clusters = Array.from({ length: clusterCount }, (_, j) => ({
    id: `c${j}`,
    capacity: BigInt(randomInt(random, 0, 4)),
  }));

  const edges: RefInput['edges'] = [];
  for (const source of sources) {
    for (const cluster of clusters) {
      if (random() < 0.45) {
        edges.push({
          source: source.id,
          cluster: cluster.id,
          cost: BigInt(randomInt(random, 0, 3)),
        });
      }
    }
  }
  return { sources, clusters, edges };
}

test('random small instances match the exhaustive reference exactly', () => {
  const random = makeRandom(0x9e3779b9);
  const rounds = 400;

  for (let round = 0; round < rounds; round++) {
    const instance = randomInstance(random);
    const expected = bruteForce(instance);
    assert.ok(expected !== null, 'reference must always find the zero flow');

    const result = plan(instance);

    assert.equal(
      result.summary.served,
      expected.served,
      `served mismatch at round ${round}: ${JSON.stringify(serialize(instance))}`,
    );
    assert.equal(
      result.summary.totalCost,
      expected.cost,
      `cost mismatch at round ${round}: ${JSON.stringify(serialize(instance))}`,
    );

    const actualVector = shareVector(instance, result);
    const expectedVector = toVector(instance, expected.flows);
    assert.deepEqual(
      actualVector,
      expectedVector,
      `share vector mismatch at round ${round}: ${JSON.stringify(serialize(instance))}`,
    );

    // Legality and the cut certificate are checked on every instance.
    assert.deepEqual(verifyPlan(instance, result), { ok: true, errors: [] });
  }
});

test('random instances with only zero-cost edges still break ties correctly', () => {
  const random = makeRandom(0x1234567);
  for (let round = 0; round < 200; round++) {
    const sourceCount = randomInt(random, 1, 3);
    const clusterCount = randomInt(random, 1, 3);
    const sources = Array.from({ length: sourceCount }, (_, i) => ({
      id: `s${i}`,
      demand: BigInt(randomInt(random, 0, 5)),
    }));
    const clusters = Array.from({ length: clusterCount }, (_, j) => ({
      id: `c${j}`,
      capacity: BigInt(randomInt(random, 0, 5)),
    }));
    const edges: RefInput['edges'] = [];
    for (const source of sources) {
      for (const cluster of clusters) {
        if (random() < 0.6) {
          edges.push({ source: source.id, cluster: cluster.id, cost: 0n });
        }
      }
    }
    const instance: RefInput = { sources, clusters, edges };
    const expected = bruteForce(instance)!;
    const result = plan(instance);
    assert.equal(result.summary.served, expected.served);
    assert.equal(result.summary.totalCost, expected.cost);
    assert.deepEqual(shareVector(instance, result), toVector(instance, expected.flows));
  }
});

test('random instances with duplicate-looking ids are still deterministic', () => {
  // Ids that share prefixes and differ in length exercise the code-unit
  // ordering that the canonical share vector depends on.
  const random = makeRandom(0xdeadbeef);
  for (let round = 0; round < 100; round++) {
    const names = ['a', 'a1', 'a10', 'a2', 'A', 'Z', 'z', '_', 'aa'];
    const sources = Array.from({ length: randomInt(random, 1, 3) }, (_, i) => ({
      id: `${names[randomInt(random, 0, names.length - 1)]}${i}`,
      demand: BigInt(randomInt(random, 0, 3)),
    }));
    const clusters = Array.from({ length: randomInt(random, 1, 3) }, (_, j) => ({
      id: `${names[randomInt(random, 0, names.length - 1)]}${j}`,
      capacity: BigInt(randomInt(random, 0, 3)),
    }));
    const edges: RefInput['edges'] = [];
    for (const source of sources) {
      for (const cluster of clusters) {
        if (random() < 0.5) {
          edges.push({
            source: source.id,
            cluster: cluster.id,
            cost: BigInt(randomInt(random, 0, 2)),
          });
        }
      }
    }
    const instance: RefInput = { sources, clusters, edges };
    const expected = bruteForce(instance)!;
    const result = plan(instance);
    assert.equal(result.summary.served, expected.served);
    assert.equal(result.summary.totalCost, expected.cost);
    assert.deepEqual(shareVector(instance, result), toVector(instance, expected.flows));
    assert.deepEqual(verifyPlan(instance, result), { ok: true, errors: [] });
  }
});

function serialize(instance: RefInput): unknown {
  return {
    sources: instance.sources.map((s) => [s.id, s.demand.toString()]),
    clusters: instance.clusters.map((c) => [c.id, c.capacity.toString()]),
    edges: instance.edges.map((e) => [e.source, e.cluster, e.cost.toString()]),
  };
}

test('dense, tie-heavy grids match the reference on 3x3 and 2x4 shapes', () => {
  // Mostly-complete bipartite graphs with many equal-cost routes create large
  // families of alternative optimal plans. This is where a wrong lexicographic
  // tie-break or a buggy zero-reduced-cost circulation would show up.
  const random = makeRandom(0x51ed270b);
  for (let round = 0; round < 400; round++) {
    const shape = randomInt(random, 0, 2);
    const sourceCount = shape === 1 ? 2 : 3;
    const clusterCount = shape === 1 ? 4 : shape === 2 ? 2 : 3;
    const sources = Array.from({ length: sourceCount }, (_, i) => ({
      id: `s${i}`,
      demand: BigInt(randomInt(random, 0, 3)),
    }));
    const clusters = Array.from({ length: clusterCount }, (_, j) => ({
      id: `c${j}`,
      capacity: BigInt(randomInt(random, 0, 3)),
    }));
    const edges: RefInput['edges'] = [];
    for (const source of sources) {
      for (const cluster of clusters) {
        if (random() < 0.85) {
          edges.push({
            source: source.id,
            cluster: cluster.id,
            cost: BigInt(randomInt(random, 0, 2)),
          });
        }
      }
    }
    const instance: RefInput = { sources, clusters, edges };
    const expected = bruteForce(instance)!;
    const result = plan(instance);
    assert.equal(result.summary.served, expected.served, `round ${round}`);
    assert.equal(result.summary.totalCost, expected.cost, `round ${round}`);
    assert.deepEqual(
      shareVector(instance, result),
      toVector(instance, expected.flows),
      `round ${round}: ${JSON.stringify(serialize(instance))}`,
    );
  }
});

test('2x2 grids with larger counts still match the reference exactly', () => {
  const random = makeRandom(0x40490fdb);
  for (let round = 0; round < 300; round++) {
    const sources = Array.from({ length: 2 }, (_, i) => ({
      id: `s${i}`,
      demand: BigInt(randomInt(random, 0, 8)),
    }));
    const clusters = Array.from({ length: 2 }, (_, j) => ({
      id: `c${j}`,
      capacity: BigInt(randomInt(random, 0, 8)),
    }));
    const edges: RefInput['edges'] = [];
    for (const source of sources) {
      for (const cluster of clusters) {
        if (random() < 0.75) {
          edges.push({
            source: source.id,
            cluster: cluster.id,
            cost: BigInt(randomInt(random, 0, 5)),
          });
        }
      }
    }
    const instance: RefInput = { sources, clusters, edges };
    const expected = bruteForce(instance)!;
    const result = plan(instance);
    assert.equal(result.summary.served, expected.served);
    assert.equal(result.summary.totalCost, expected.cost);
    assert.deepEqual(shareVector(instance, result), toVector(instance, expected.flows));
  }
});
