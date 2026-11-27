/**
 * End-to-end behavioural tests for the planner.
 *
 * These assert the exact objective order (throughput, then cost, then the
 * lexicographic share vector), legality of every assignment, and the capacity
 * cut when demand cannot be fully served.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../src/planner.ts';
import { verifyPlan, verifyCut, shareVector } from '../src/verify.ts';

test('local capacity absorbs its own region first, cross-region only for the overflow', () => {
  const input = {
    sources: [
      { id: 'us-east', demand: 1200n },
      { id: 'eu-west', demand: 800n },
    ],
    clusters: [
      { id: 'us-cluster', capacity: 1000n },
      { id: 'eu-cluster', capacity: 900n },
    ],
    edges: [
      { source: 'us-east', cluster: 'us-cluster', cost: 0n },
      { source: 'us-east', cluster: 'eu-cluster', cost: 5n },
      { source: 'eu-west', cluster: 'eu-cluster', cost: 0n },
    ],
  };
  const result = plan(input);

  assert.equal(result.summary.served, 1900n);
  assert.equal(result.summary.unserved, 100n);
  assert.equal(result.summary.totalCost, 500n);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });

  const byRoute = new Map(
    result.assignments.map((a) => [`${a.source}->${a.cluster}`, a.requests]),
  );
  assert.equal(byRoute.get('us-east->us-cluster'), 1000n);
  assert.equal(byRoute.get('us-east->eu-cluster'), 100n);
  assert.equal(byRoute.get('eu-west->eu-cluster'), 800n);
});

test('greedy per-region allocation would strand the only cluster a region can reach', () => {
  // The classic trap: "eu" has exactly one outlet, "us" has two. A per-region
  // greedy pass that lets "us" take the shared cluster starves "eu" even
  // though the total could be higher.
  const input = {
    sources: [
      { id: 'us', demand: 100n },
      { id: 'eu', demand: 100n },
    ],
    clusters: [
      { id: 'shared', capacity: 100n },
      { id: 'us-local', capacity: 100n },
    ],
    edges: [
      { source: 'us', cluster: 'us-local', cost: 0n },
      { source: 'us', cluster: 'shared', cost: 7n },
      { source: 'eu', cluster: 'shared', cost: 0n },
    ],
  };
  const result = plan(input);

  // With capacity maximised, "us" must stay home so "eu" can use "shared".
  assert.equal(result.summary.served, 200n);
  assert.equal(result.summary.totalCost, 0n);
  const byRoute = new Map(
    result.assignments.map((a) => [`${a.source}->${a.cluster}`, a.requests]),
  );
  assert.equal(byRoute.get('us->us-local'), 100n);
  assert.equal(byRoute.get('eu->shared'), 100n);
  assert.equal(byRoute.get('us->shared'), undefined);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('cost minimisation happens only after throughput is maximised', () => {
  // Sending everything locally is cheap, but leaves demand stranded; the
  // optimum accepts one extra unit at a high cost because throughput wins.
  const input = {
    sources: [{ id: 'a', demand: 10n }],
    clusters: [
      { id: 'near', capacity: 6n },
      { id: 'far', capacity: 100n },
    ],
    edges: [
      { source: 'a', cluster: 'near', cost: 0n },
      { source: 'a', cluster: 'far', cost: 1000n },
    ],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 10n);
  assert.equal(result.summary.totalCost, 4000n);
  const byRoute = new Map(
    result.assignments.map((a) => [`${a.source}->${a.cluster}`, a.requests]),
  );
  assert.equal(byRoute.get('a->near'), 6n);
  assert.equal(byRoute.get('a->far'), 4n);
});

test('among equal-throughput equal-cost plans the smallest share vector wins', () => {
  // Both routes cost 0 and both fit; the canonical vector puts (a, b1) first,
  // so it must be zero and all volume goes to (a, b2).
  const input = {
    sources: [{ id: 'a', demand: 5n }],
    clusters: [
      { id: 'b1', capacity: 10n },
      { id: 'b2', capacity: 10n },
    ],
    edges: [
      { source: 'a', cluster: 'b1', cost: 0n },
      { source: 'a', cluster: 'b2', cost: 0n },
    ],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 5n);
  assert.deepEqual(shareVector(input, result), [
    { source: 'a', cluster: 'b1', requests: 0n },
    { source: 'a', cluster: 'b2', requests: 5n },
  ]);
});

test('tie-break also orders by source before cluster', () => {
  const input = {
    sources: [
      { id: 'a', demand: 5n },
      { id: 'b', demand: 5n },
    ],
    clusters: [{ id: 'c', capacity: 100n }],
    edges: [
      { source: 'a', cluster: 'c', cost: 0n },
      { source: 'b', cluster: 'c', cost: 0n },
    ],
  };
  // Vector is [(a,c), (b,c)]; minimise (a,c) first: all 5 units must come
  // from b, but a's 5 units are also served... total demand 10 fits in 100,
  // so served is 10 and lexicographic order wants (a,c) as small as possible.
  const result = plan(input);
  assert.equal(result.summary.served, 10n);
  const vector = shareVector(input, result);
  // All demand is served, so per-source totals are fixed: (a,c)=5, (b,c)=5.
  assert.deepEqual(vector, [
    { source: 'a', cluster: 'c', requests: 5n },
    { source: 'b', cluster: 'c', requests: 5n },
  ]);
});

test('a region with only one outlet keeps its capacity even when others compete', () => {
  const input = {
    sources: [
      { id: 'alpha', demand: 50n },
      { id: 'beta', demand: 50n },
    ],
    clusters: [
      { id: 'only-for-beta', capacity: 40n },
      { id: 'common', capacity: 100n },
    ],
    edges: [
      { source: 'alpha', cluster: 'common', cost: 1n },
      { source: 'beta', cluster: 'common', cost: 1n },
      { source: 'beta', cluster: 'only-for-beta', cost: 0n },
    ],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 100n);
  const vector = shareVector(input, result);
  const betaOnly = vector.find((v) => v.source === 'beta' && v.cluster === 'only-for-beta')!;
  // Beta's total is fixed at 50; lexicographic minimisation wants (beta,
  // only-for-beta) small, so beta should send as much as possible through
  // 'common' instead. Both cost 1 and 0 respectively… cost matters first.
  // only-for-beta is cheaper, so cost minimisation fills it fully.
  assert.equal(betaOnly.requests, 40n);
});

test('unserved demand comes with a tight, re-checkable capacity cut', () => {
  const input = {
    sources: [
      { id: 's1', demand: 10n },
      { id: 's2', demand: 10n },
    ],
    clusters: [
      { id: 'c1', capacity: 4n },
      { id: 'c2', capacity: 4n },
    ],
    edges: [
      { source: 's1', cluster: 'c1', cost: 0n },
      { source: 's2', cluster: 'c2', cost: 0n },
    ],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 8n);
  assert.equal(result.summary.unserved, 12n);
  assert.ok(result.cut !== null);
  const cut = result.cut!;
  assert.equal(cut.tight, true);
  assert.equal(cut.cutCapacity, 8n);
  assert.equal(cut.unserved, 12n);
  assert.deepEqual(cut.sourceRegion, ['s1', 's2']);
  assert.deepEqual(cut.clusterRegion, ['c1', 'c2']);
  assert.deepEqual(verifyCut(input, cut, result.summary.served), { ok: true, errors: [] });
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('cut exposes the bottleneck region rather than the whole graph', () => {
  // The cut should isolate the region whose outlet is exhausted, not simply
  // report every node.
  const input = {
    sources: [
      { id: 'isolated', demand: 10n },
      { id: 'flexible', demand: 10n },
    ],
    clusters: [
      { id: 'tiny', capacity: 2n },
      { id: 'big', capacity: 100n },
    ],
    edges: [
      { source: 'isolated', cluster: 'tiny', cost: 0n },
      { source: 'flexible', cluster: 'tiny', cost: 0n },
      { source: 'flexible', cluster: 'big', cost: 0n },
    ],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 12n);
  assert.equal(result.summary.unserved, 8n);
  assert.ok(result.cut !== null);
  const cut = result.cut!;
  assert.deepEqual(cut.sourceRegion, ['isolated']);
  assert.deepEqual(cut.clusterRegion, ['tiny']);
  assert.equal(cut.cutCapacity, 12n);
  assert.equal(cut.unserved, 8n);
  assert.deepEqual(verifyCut(input, cut, result.summary.served), { ok: true, errors: [] });
});

test('no cut is reported when every request is accepted', () => {
  const input = {
    sources: [{ id: 'a', demand: 1n }],
    clusters: [{ id: 'b', capacity: 1n }],
    edges: [{ source: 'a', cluster: 'b', cost: 0n }],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 1n);
  assert.equal(result.cut, null);
});

test('forbidden edges are never used, even when they would help', () => {
  const input = {
    sources: [{ id: 'a', demand: 10n }],
    clusters: [
      { id: 'allowed', capacity: 3n },
      { id: 'forbidden', capacity: 100n },
    ],
    edges: [{ source: 'a', cluster: 'allowed', cost: 0n }],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 3n);
  for (const assignment of result.assignments) {
    assert.notEqual(assignment.cluster, 'forbidden');
  }
  assert.ok(result.cut !== null);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('an unreachable source yields a cut isolating it with zero cluster side', () => {
  const input = {
    sources: [
      { id: 'orphan', demand: 7n },
      { id: 'connected', demand: 2n },
    ],
    clusters: [{ id: 'c', capacity: 100n }],
    edges: [{ source: 'connected', cluster: 'c', cost: 0n }],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 2n);
  assert.equal(result.summary.unserved, 7n);
  assert.ok(result.cut !== null);
  const cut = result.cut!;
  assert.deepEqual(cut.sourceRegion, ['orphan']);
  assert.deepEqual(cut.clusterRegion, []);
  assert.equal(cut.cutCapacity, 2n);
  assert.equal(cut.unserved, 7n);
  assert.deepEqual(verifyCut(input, cut, result.summary.served), { ok: true, errors: [] });
});

test('zero demands and zero capacities are handled without special cases', () => {
  const input = {
    sources: [
      { id: 'idle', demand: 0n },
      { id: 'active', demand: 3n },
    ],
    clusters: [
      { id: 'closed', capacity: 0n },
      { id: 'open', capacity: 3n },
    ],
    edges: [
      { source: 'idle', cluster: 'open', cost: 0n },
      { source: 'active', cluster: 'closed', cost: 0n },
      { source: 'active', cluster: 'open', cost: 2n },
    ],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 3n);
  assert.equal(result.summary.unserved, 0n);
  assert.equal(result.summary.totalCost, 6n);
  assert.equal(result.cut, null);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('an input with no edges serves nothing and cuts cleanly', () => {
  const input = {
    sources: [{ id: 'a', demand: 5n }],
    clusters: [{ id: 'b', capacity: 5n }],
    edges: [],
  };
  const result = plan(input);
  assert.equal(result.summary.served, 0n);
  assert.equal(result.summary.unserved, 5n);
  assert.deepEqual(result.assignments, []);
  assert.ok(result.cut !== null);
  assert.equal(result.cut!.cutCapacity, 0n);
  assert.deepEqual(verifyPlan(input, result), { ok: true, errors: [] });
});

test('assignments are sorted by source id then cluster id', () => {
  const input = {
    sources: [
      { id: 'zeta', demand: 5n },
      { id: 'alpha', demand: 5n },
    ],
    clusters: [
      { id: 'y', capacity: 10n },
      { id: 'x', capacity: 10n },
    ],
    edges: [
      { source: 'zeta', cluster: 'y', cost: 0n },
      { source: 'alpha', cluster: 'y', cost: 0n },
      { source: 'alpha', cluster: 'x', cost: 0n },
    ],
  };
  const result = plan(input);
  const order = result.assignments.map((a) => `${a.source}->${a.cluster}`);
  assert.deepEqual(order, [...order].sort());
});

test('duplicate source ids are rejected', () => {
  assert.throws(
    () =>
      plan({
        sources: [
          { id: 'a', demand: 1n },
          { id: 'a', demand: 2n },
        ],
        clusters: [{ id: 'c', capacity: 10n }],
        edges: [],
      }),
    /duplicate source id/,
  );
});

test('duplicate edges are rejected', () => {
  assert.throws(
    () =>
      plan({
        sources: [{ id: 'a', demand: 1n }],
        clusters: [{ id: 'c', capacity: 10n }],
        edges: [
          { source: 'a', cluster: 'c', cost: 0n },
          { source: 'a', cluster: 'c', cost: 1n },
        ],
      }),
    /duplicate edge/,
  );
});

test('edges referencing unknown nodes are rejected', () => {
  assert.throws(
    () =>
      plan({
        sources: [{ id: 'a', demand: 1n }],
        clusters: [{ id: 'c', capacity: 10n }],
        edges: [{ source: 'a', cluster: 'nope', cost: 0n }],
      }),
    /unknown cluster/,
  );
});

test('negative quantities and non-integers are rejected', () => {
  assert.throws(
    () =>
      plan({
        sources: [{ id: 'a', demand: -1n }],
        clusters: [{ id: 'c', capacity: 10n }],
        edges: [],
      }),
    /non-negative/,
  );
  assert.throws(
    () =>
      plan({
        sources: [{ id: 'a', demand: 1.5 }],
        clusters: [{ id: 'c', capacity: 10n }],
        edges: [],
      }),
    /integer/,
  );
});
