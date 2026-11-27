import assert from 'node:assert/strict';
import { test } from 'node:test';

import { negotiate } from '../src/index.ts';
import type { Expr, Offer } from '../src/index.ts';
import {
  checkCore,
  coreIsMinimal,
  coreIsUnsatisfiable,
  referenceSolve,
  witnessSatisfiesCoreMinus,
} from '../src/reference.ts';

/** Small deterministic PRNG so failures are reproducible. */
function prng(seed: number): (n: number) => number {
  let state = seed;
  return (n: number): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
}

test('exhaustive cross-check: success optima match the reference solver', () => {
  const rand = prng(7);
  const features = ['a', 'b', 'c', 'd', 'e', 'f'];
  let checked = 0;

  for (let trial = 0; trial < 120; trial++) {
    const offers: Offer[] = Array.from({ length: 1 + rand(4) }, (_, p) => ({
      partyId: `p${p}`,
      offerVersion: '1',
      protocolVersions: rand(2) === 0 ? ['v1'] : rand(2) === 0 ? ['v1', 'v2'] : ['v2'],
      supportedFeatures: features.filter(() => rand(4) !== 0),
      requiredFeatures: [] as string[],
      constraints: Array.from({ length: rand(4) }, (_, c) => ({
        id: `c${c}`,
        expr: randomExpr(rand, features),
      })),
    }));
    const benefits: Record<string, number> = {};
    for (const feature of features) benefits[feature] = rand(7) - 2;

    const expected = referenceSolve(offers, benefits);
    const actual = negotiate(offers, benefits);
    assert.equal(
      actual.status === 'success',
      expected.satisfiable,
      `satisfiability differs on trial ${trial}`,
    );
    if (actual.status === 'success' && expected.solution !== null) {
      assert.equal(actual.totalBenefit, expected.solution.totalBenefit, `benefit trial ${trial}`);
      assert.deepEqual(actual.features, expected.solution.features, `features trial ${trial}`);
      assert.equal(actual.protocolVersion, expected.solution.protocolVersion);
      checked += 1;
    }
  }
  assert.equal(checked, 120);
});

test('exhaustive cross-check: cores and witnesses survive dense conflicts', () => {
  const rand = prng(12345);
  const features = ['a', 'b', 'c'];
  let unsat = 0;
  let sat = 0;

  for (let trial = 0; trial < 200; trial++) {
    const offers: Offer[] = Array.from({ length: 2 + rand(2) }, (_, p) => ({
      partyId: `p${p}`,
      offerVersion: '1',
      protocolVersions: rand(2) === 0 ? ['v1'] : ['v2'],
      supportedFeatures: [...features],
      requiredFeatures: features.filter(() => rand(3) === 0),
      constraints: Array.from({ length: 1 + rand(3) }, (_, c) => ({
        id: `c${c}`,
        expr: conflictExpr(rand, features),
      })),
    }));
    const benefits: Record<string, number> = {};
    for (const feature of features) benefits[feature] = rand(5);

    const expected = referenceSolve(offers, benefits);
    const actual = negotiate(offers, benefits);
    assert.equal(
      actual.status === 'success',
      expected.satisfiable,
      `satisfiability differs on trial ${trial}: ${JSON.stringify(offers)}`,
    );

    if (actual.status === 'success') {
      sat += 1;
      assert.equal(actual.totalBenefit, expected.solution!.totalBenefit);
      assert.deepEqual(actual.features, expected.solution!.features);
      continue;
    }
    if (actual.status !== 'unsatisfiable') continue;
    unsat += 1;

    assert.ok(coreIsUnsatisfiable(actual.core), `core must be unsat (trial ${trial})`);
    assert.ok(coreIsMinimal(actual.core), `core must be minimal (trial ${trial})`);
    for (const member of actual.core) {
      const minus = checkCore(actual.core, member.id);
      assert.ok(minus.satisfiable, `core minus ${member.id} must be sat (trial ${trial})`);
    }
    for (const removal of actual.removalWitnesses) {
      assert.ok(
        witnessSatisfiesCoreMinus(actual.core, removal.removedConstraintId, removal.witness),
        `witness must satisfy core minus ${removal.removedConstraintId} (trial ${trial})`,
      );
    }
    // No witness may drop a core member other than the one it removes.
    assert.equal(actual.removalWitnesses.length, actual.core.length);
  }

  // The point of this generator is to exercise the unsatisfiable branch.
  assert.ok(unsat > 100, `expected many unsat instances, saw ${unsat}`);
  assert.ok(sat > 0, `expected some sat instances, saw ${sat}`);
});

test('protocol cores are minimal when several parties disagree', () => {
  const cases: { versions: string[][]; expected: number }[] = [
    { versions: [['v1', 'v2'], ['v2', 'v3'], ['v1', 'v3']], expected: 3 },
    { versions: [['v1'], ['v1'], ['v2']], expected: 2 },
    // Each party accepts everything but one version: all four disagree, yet
    // dropping any single party leaves a common version.
    {
      versions: [
        ['v2', 'v3', 'v4'],
        ['v1', 'v3', 'v4'],
        ['v1', 'v2', 'v4'],
        ['v1', 'v2', 'v3'],
      ],
      expected: 4,
    },
  ];
  for (const scenario of cases) {
    const offers: Offer[] = scenario.versions.map((protocolVersions, i) => ({
      partyId: `p${i}`,
      offerVersion: '1',
      protocolVersions,
      supportedFeatures: ['x'],
    }));
    const outcome = negotiate(offers, { x: 1 });
    assert.equal(outcome.status, 'unsatisfiable');
    if (outcome.status !== 'unsatisfiable') continue;
    assert.equal(outcome.core.length, scenario.expected);
    assert.ok(outcome.core.every((entry) => entry.kind === 'protocol'));
    assert.ok(coreIsUnsatisfiable(outcome.core));
    assert.ok(coreIsMinimal(outcome.core));
  }
});

test('cores containing support rules keep valid witnesses and minimality', () => {
  const rand = prng(31337);
  const features = ['a', 'b', 'c', 'd'];
  let supportCores = 0;

  for (let trial = 0; trial < 150; trial++) {
    const offers: Offer[] = Array.from({ length: 2 + rand(2) }, (_, p) => {
      const supported = features.filter(() => rand(5) !== 0);
      return {
        partyId: `p${p}`,
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: supported,
        requiredFeatures: supported.filter(() => rand(6) === 0),
        constraints: Array.from({ length: rand(2) }, (_, c) => ({
          id: `c${c}`,
          expr: { op: 'not' as const, arg: { op: 'feature' as const, feature: pick(rand, features) } },
        })),
      };
    });
    const outcome = negotiate(offers, { a: 1, b: 1, c: 1, d: 1 });
    if (outcome.status !== 'unsatisfiable') continue;
    if (!outcome.core.some((entry) => entry.kind === 'support')) continue;
    supportCores += 1;

    assert.ok(coreIsMinimal(outcome.core), `minimality (trial ${trial})`);
    for (const removal of outcome.removalWitnesses) {
      assert.ok(
        witnessSatisfiesCoreMinus(outcome.core, removal.removedConstraintId, removal.witness),
        `witness (trial ${trial})`,
      );
    }
  }
  assert.ok(supportCores > 10, `expected several support-rule cores, saw ${supportCores}`);
});

test('required-feature vs support conflict produces the exact two-rule core', () => {
  const outcome = negotiate(
    [
      {
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['x', 'y'],
        requiredFeatures: ['x'],
      },
      { partyId: 'b', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['y'] },
    ],
    { x: 5, y: 1 },
  );
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  assert.deepEqual(
    outcome.core.map((entry) => entry.id),
    ['required:a:x', 'support:b:x'],
  );
  const support = outcome.core.find((entry) => entry.kind === 'support');
  assert.equal(support?.feature, 'x');
  const witnessForSupport = outcome.removalWitnesses.find(
    (removal) => removal.removedConstraintId === 'support:b:x',
  );
  assert.deepEqual(witnessForSupport?.witness.features, ['x']);
});

function randomExpr(rand: (n: number) => number, features: readonly string[]): Expr {
  switch (rand(4)) {
    case 0:
      return { op: 'not', arg: { op: 'feature', feature: pick(rand, features) } };
    case 1:
      return {
        op: 'or',
        args: [
          { op: 'not', arg: { op: 'feature', feature: pick(rand, features) } },
          { op: 'feature', feature: pick(rand, features) },
        ],
      };
    case 2:
      return { op: 'atMost', features: features.filter(() => rand(2) === 0), count: rand(3) };
    default:
      return { op: 'atLeast', features: features.filter(() => rand(2) === 0), count: rand(3) };
  }
}

function conflictExpr(rand: (n: number) => number, features: readonly string[]): Expr {
  switch (rand(3)) {
    case 0:
      return { op: 'not', arg: { op: 'feature', feature: pick(rand, features) } };
    case 1:
      return { op: 'atMost', features: [...features], count: rand(2) };
    default:
      return { op: 'exactly', features: [...features], count: rand(4) };
  }
}

function pick(rand: (n: number) => number, values: readonly string[]): string {
  return values[rand(values.length)];
}
