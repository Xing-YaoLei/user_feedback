/**
 * Exactness and scale tests.
 *
 * The planner must stay exact well beyond Number.MAX_SAFE_INTEGER, and its
 * running cost must depend on the graph rather than on how many requests a
 * demand represents. Both properties are asserted here on inputs whose
 * magnitudes would be impossible to expand request-by-request.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../src/planner.ts';
import { verifyPlan } from '../src/verify.ts';

test('totals beyond Number.MAX_SAFE_INTEGER stay exact', () => {
  const huge = 10n ** 40n;
  const input = {
    sources: [
      { id: 'a', demand: huge + 123n },
      { id: 'b', demand: huge * 3n - 7n },
    ],
    clusters: [
      { id: 'x', capacity: huge * 2n },
      { id: 'y', capacity: huge * 2n - 500n },
    ],
    edges: [
      { source: 'a', cluster: 'x', cost: 0n },
      { source: 'a', cluster: 'y', cost: 999_999_999_999_999_999_999n },
      { source: 'b', cluster: 'x', cost: 7n },
      { source: 'b', cluster: 'y', cost: 0n },
    ],
  };

  const result = plan(input);
  const totalDemand = huge + 123n + huge * 3n - 7n;
  const totalCapacity = huge * 2n + huge * 2n - 500n;

  assert.equal(result.summary.totalDemand, totalDemand);
  assert.equal(result.summary.totalCapacity, totalCapacity);
  assert.ok(totalDemand > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(result.summary.served, totalCapacity);
  assert.equal(result.summary.unserved, totalDemand - totalCapacity);
  assert.ok(result.summary.totalCost > BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('per-unit cost times astronomically large flow is exact', () => {
  const demand = 10n ** 30n;
  const unitCost = 10n ** 30n;
  const input = {
    sources: [{ id: 's', demand }],
    clusters: [{ id: 'c', capacity: demand }],
    edges: [{ source: 's', cluster: 'c', cost: unitCost }],
  };
  const result = plan(input);
  assert.equal(result.summary.totalCost, demand * unitCost);
  assert.equal(result.summary.totalCost, 10n ** 60n);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('large counts do not expand into per-request work', () => {
  // 10^15 requests on a single route. A per-request algorithm would never
  // finish; the bulk augmenting-path algorithm is effectively instant.
  const demand = 10n ** 15n;
  const input = {
    sources: [
      { id: 's1', demand },
      { id: 's2', demand },
    ],
    clusters: [
      { id: 'c1', capacity: demand + demand / 2n },
      { id: 'c2', capacity: demand },
    ],
    edges: [
      { source: 's1', cluster: 'c1', cost: 0n },
      { source: 's2', cluster: 'c2', cost: 0n },
      { source: 's2', cluster: 'c1', cost: 1n },
    ],
  };
  const started = performance.now();
  const result = plan(input);
  const elapsed = performance.now() - started;

  assert.equal(result.summary.served, 2n * demand);
  assert.equal(result.summary.totalCost, 0n);
  assert.ok(elapsed < 2000, `planning took ${elapsed.toFixed(1)}ms, expected well under 2s`);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('a moderately dense mesh plans quickly and exactly', () => {
  const N = 40;
  const sources = Array.from({ length: N }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, demand: 1000n }));
  const clusters = Array.from({ length: N }, (_, j) => ({ id: `c${String(j).padStart(2, '0')}`, capacity: 900n }));
  const edges: { source: string; cluster: string; cost: bigint }[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      edges.push({
        source: sources[i].id,
        cluster: clusters[j].id,
        cost: BigInt((i * 7 + j * 13) % 11),
      });
    }
  }
  const input = { sources, clusters, edges };
  const started = performance.now();
  const result = plan(input);
  const elapsed = performance.now() - started;

  assert.equal(result.summary.served, BigInt(N) * 900n);
  assert.ok(elapsed < 5000, `dense planning took ${elapsed.toFixed(1)}ms`);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('decimal-string inputs round-trip without precision loss', () => {
  const demand = '1000000000000000000000000000001';
  const capacity = '1000000000000000000000000000000';
  const cost = '99999999999999999999';
  const input = {
    sources: [{ id: 's', demand }],
    clusters: [{ id: 'c', capacity }],
    edges: [{ source: 's', cluster: 'c', cost }],
  };
  const result = plan(input);
  assert.equal(result.summary.served, BigInt(capacity));
  assert.equal(result.summary.unserved, 1n);
  assert.equal(result.summary.totalCost, BigInt(capacity) * BigInt(cost));
});

test('a safe integer passed as a number is accepted unchanged', () => {
  const result = plan({
    sources: [{ id: 's', demand: 2_000_000_000 }],
    clusters: [{ id: 'c', capacity: 1_000_000_000 }],
    edges: [{ source: 's', cluster: 'c', cost: 3 }],
  });
  assert.equal(result.summary.served, 1_000_000_000n);
  assert.equal(result.summary.totalCost, 3_000_000_000n);
});

test('an unsafe integer number is rejected rather than silently rounded', () => {
  assert.throws(
    () =>
      plan({
        sources: [{ id: 's', demand: Number.MAX_SAFE_INTEGER + 2 }],
        clusters: [{ id: 'c', capacity: 10n }],
        edges: [],
      }),
    /MAX_SAFE_INTEGER/,
  );
});
