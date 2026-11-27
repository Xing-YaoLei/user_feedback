/**
 * Interleaving and crash-safety tests.
 *
 * The planner is a pure function over its input, so it must behave identically
 * when many plans are in flight at once, when one plan is invoked re-entrantly
 * from inside another, and when a call fails halfway. These tests exercise
 * those paths directly rather than trusting that no module-level state exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../src/planner.ts';
import { verifyPlan, shareVector } from '../src/verify.ts';
import type { PlanInput } from '../src/types.ts';

interface Case {
  name: string;
  input: PlanInput;
}

function makeCases(): Case[] {
  return [
    {
      name: 'overflow',
      input: {
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
      },
    },
    {
      name: 'tie-heavy',
      input: {
        sources: [
          { id: 'a', demand: 7n },
          { id: 'b', demand: 7n },
          { id: 'c', demand: 7n },
        ],
        clusters: [
          { id: 'x', capacity: 6n },
          { id: 'y', capacity: 6n },
          { id: 'z', capacity: 6n },
        ],
        edges: [
          { source: 'a', cluster: 'x', cost: 0n },
          { source: 'a', cluster: 'y', cost: 0n },
          { source: 'b', cluster: 'y', cost: 0n },
          { source: 'b', cluster: 'z', cost: 0n },
          { source: 'c', cluster: 'x', cost: 0n },
          { source: 'c', cluster: 'z', cost: 0n },
        ],
      },
    },
    {
      name: 'cut',
      input: {
        sources: [
          { id: 'orphan', demand: 9n },
          { id: 'connected', demand: 4n },
        ],
        clusters: [{ id: 'c', capacity: 4n }],
        edges: [{ source: 'connected', cluster: 'c', cost: 0n }],
      },
    },
    {
      name: 'huge',
      input: {
        sources: [{ id: 's', demand: 10n ** 25n }],
        clusters: [{ id: 'c', capacity: 10n ** 24n }],
        edges: [{ source: 's', cluster: 'c', cost: 10n ** 12n }],
      },
    },
  ];
}

/** A compact fingerprint of a result that captures everything that matters. */
function fingerprint(input: PlanInput) {
  const result = plan(input);
  return {
    served: result.summary.served,
    unserved: result.summary.unserved,
    cost: result.summary.totalCost,
    vector: shareVector(input, result),
    cut:
      result.cut === null
        ? null
        : {
            s: result.cut.sourceRegion,
            t: result.cut.clusterRegion,
            cap: result.cut.cutCapacity,
            unserved: result.cut.unserved,
            tight: result.cut.tight,
          },
  };
}

/** Fingerprints computed one-at-a-time, the trusted baseline. */
function sequentialBaseline(): unknown[] {
  return makeCases().map((testCase) => fingerprint(testCase.input));
}

test('interleaved asynchronous plans match the sequential baseline', async () => {
  const baseline = sequentialBaseline();

  // Run every case many times, interleaving them via microtask yields so their
  // executions overlap in scheduling. Results must be identical to running
  // each in isolation.
  const tasks: Promise<{ index: number; value: unknown }>[] = [];
  for (let repeat = 0; repeat < 25; repeat++) {
    makeCases().forEach((testCase, index) => {
      tasks.push(
        (async () => {
          for (let tick = 0; tick < repeat % 5; tick++) await Promise.resolve();
          const value = fingerprint(testCase.input);
          for (let tick = 0; tick < repeat % 3; tick++) await Promise.resolve();
          return { index, value };
        })(),
      );
    });
  }
  const outcomes = await Promise.all(tasks);
  for (const { index, value } of outcomes) {
    assert.deepEqual(value, baseline[index], `case ${makeCases()[index].name} diverged under interleaving`);
  }
});

test('a plan invoked re-entrantly from inside another plan is unaffected', () => {
  const outer = makeCases()[0].input;
  const inner = makeCases()[1].input;
  const expectedInner = fingerprint(inner);
  const baselineOuter = fingerprint(outer);

  // A Proxy whose value read triggers a nested plan() call. If the planner
  // secretly relied on module-global mutable state, the outer run would be
  // corrupted by the nested run.
  let fired = 0;
  const nestedInput = new Proxy(inner, {
    get(target, property, receiver) {
      if (fired < 1 && property === 'edges') {
        fired++;
        // Compute the inner plan fully while the outer plan is mid-flight.
        assert.deepEqual(fingerprint(inner), expectedInner);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const result = plan(nestedInput);
  assert.equal(fired, 1, 'nested plan should have been triggered exactly once');
  assert.deepEqual(
    {
      served: result.summary.served,
      cost: result.summary.totalCost,
      vector: shareVector(inner, result),
    },
    {
      served: expectedInner.served,
      cost: expectedInner.cost,
      vector: expectedInner.vector,
    },
  );

  // And the outer input still produces its baseline result afterwards.
  assert.deepEqual(fingerprint(outer), baselineOuter);
});

test('a crash mid-plan leaves no residue for later calls', () => {
  const goodInput = makeCases()[0].input;
  const baseline = fingerprint(goodInput);

  // An input that throws when its edges array is first indexed.
  const poisoned = new Proxy(
    {
      sources: [{ id: 'a', demand: 1n }],
      clusters: [{ id: 'c', capacity: 1n }],
      edges: [{ source: 'a', cluster: 'c', cost: 0n }],
    },
    {
      get(target, property, receiver) {
        if (property === 'edges') {
          throw new Error('injected crash while reading edges');
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );

  assert.throws(() => plan(poisoned), /injected crash/);

  // A subsequent valid call must be completely unaffected.
  assert.deepEqual(fingerprint(goodInput), baseline);
  assert.deepEqual(plan(goodInput).summary, {
    served: 1900n,
    unserved: 100n,
    totalCost: 500n,
    totalDemand: 2000n,
    totalCapacity: 1900n,
  });
});

test('a validation failure does not mutate the caller input', () => {
  const sources = [{ id: 'a', demand: 5n }];
  const clusters = [{ id: 'c', capacity: 3n }];
  const edges = [{ source: 'a', cluster: 'c', cost: 0n }];
  const input = { sources, clusters, edges };
  const snapshot = JSON.stringify({
    sources: sources.map((s) => [s.id, s.demand.toString()]),
    clusters: clusters.map((c) => [c.id, c.capacity.toString()]),
    edges: edges.map((e) => [e.source, e.cluster, e.cost.toString()]),
  });

  plan(input);
  assert.equal(
    JSON.stringify({
      sources: sources.map((s) => [s.id, s.demand.toString()]),
      clusters: clusters.map((c) => [c.id, c.capacity.toString()]),
      edges: edges.map((e) => [e.source, e.cluster, e.cost.toString()]),
    }),
    snapshot,
    'planning must not mutate the input document',
  );
});

test('repeated identical calls are bit-for-bit deterministic', () => {
  const input = makeCases()[1].input;
  const first = fingerprint(input);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(fingerprint(input), first);
  }
  assert.deepEqual(verifyPlan(input, plan(input)), { ok: true, errors: [] });
});

test('interleaving with failing and succeeding calls keeps every result exact', async () => {
  const good = makeCases()[3].input;
  const baseline = fingerprint(good);

  const jobs: Promise<void>[] = [];
  for (let i = 0; i < 40; i++) {
    jobs.push(
      (async () => {
        await Promise.resolve();
        if (i % 4 === 0) {
          // Interleave deliberate failures between successful plans.
          assert.throws(() =>
            plan({
              sources: [{ id: 's', demand: -1n }],
              clusters: [{ id: 'c', capacity: 1n }],
              edges: [],
            }),
          );
        }
        assert.deepEqual(fingerprint(good), baseline);
      })(),
    );
  }
  await Promise.all(jobs);
});
