import assert from 'node:assert/strict';
import { test } from 'node:test';

import { negotiate, verifyUnsatisfiableOutcome, verifySuccessOutcome } from '../src/index.ts';
import type { Expr, NegotiationOutcome, Offer } from '../src/index.ts';

const imp = (from: string, to: string): Expr => ({
  op: 'or',
  args: [
    { op: 'not', arg: { op: 'feature', feature: from } },
    { op: 'feature', feature: to },
  ],
});

interface Case {
  readonly name: string;
  readonly offers: Offer[];
  readonly benefits: Record<string, number>;
}

const cases: Case[] = [
  {
    name: 'four-party protocol conflict',
    benefits: { x: 1 },
    offers: [
      { partyId: 'a', offerVersion: '1', protocolVersions: ['v2', 'v3', 'v4'], supportedFeatures: ['x'] },
      { partyId: 'b', offerVersion: '1', protocolVersions: ['v1', 'v3', 'v4'], supportedFeatures: ['x'] },
      { partyId: 'c', offerVersion: '1', protocolVersions: ['v1', 'v2', 'v4'], supportedFeatures: ['x'] },
      { partyId: 'd', offerVersion: '1', protocolVersions: ['v1', 'v2', 'v3'], supportedFeatures: ['x'] },
    ],
  },
  {
    name: 'implication chain with noise',
    benefits: { p: 1, q: 1, r: 1, s: 1 },
    offers: [
      {
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['p', 'q', 'r', 's'],
        requiredFeatures: ['p'],
        constraints: [
          { id: 'p-q', expr: imp('p', 'q') },
          { id: 'noise-r-s', expr: imp('r', 's') },
        ],
      },
      {
        partyId: 'b',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['p', 'q', 'r', 's'],
        constraints: [
          { id: 'q-r', expr: imp('q', 'r') },
          { id: 'noise-r-s-cap', expr: { op: 'atMost', features: ['r', 's'], count: 1 } },
        ],
      },
      {
        partyId: 'c',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['p', 'q', 'r', 's'],
        constraints: [
          {
            id: 'r-not-p',
            expr: {
              op: 'or',
              args: [
                { op: 'not', arg: { op: 'feature', feature: 'r' } },
                { op: 'not', arg: { op: 'feature', feature: 'p' } },
              ],
            },
          },
        ],
      },
    ],
  },
  {
    name: 'successful wide instance',
    benefits: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i + 1])),
    offers: [
      {
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1', 'v2'],
        supportedFeatures: Array.from({ length: 10 }, (_, i) => `f${i}`),
      },
      {
        partyId: 'b',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: Array.from({ length: 10 }, (_, i) => `f${i}`).filter((_, i) => i % 2 === 0),
      },
    ],
  },
];

function stripSearch(outcome: NegotiationOutcome): unknown {
  const copy = JSON.parse(JSON.stringify(outcome)) as Record<string, unknown>;
  delete copy.search;
  return copy;
}

function drain(c: Case, budget: number): NegotiationOutcome {
  let outcome = negotiate(c.offers, c.benefits, { maxSteps: budget });
  let rounds = 1;
  while (outcome.status === 'undetermined' && rounds < 100_000) {
    outcome = negotiate(c.offers, c.benefits, { maxSteps: budget, resume: outcome.progress });
    rounds += 1;
  }
  return outcome;
}

test('every budget value reproduces the exact uninterrupted outcome', () => {
  for (const scenario of cases) {
    const uninterrupted = negotiate(scenario.offers, scenario.benefits);
    assert.notEqual(uninterrupted.status, 'undetermined');
    for (let budget = 1; budget <= 12; budget++) {
      const stepped = drain(scenario, budget);
      assert.equal(stepped.status, uninterrupted.status, `${scenario.name} at budget ${budget}`);
      assert.deepEqual(
        stripSearch(stepped),
        stripSearch(uninterrupted),
        `${scenario.name} differs at budget ${budget}`,
      );
    }
  }
});

test('success outcomes pass independent verification', () => {
  const scenario = cases[2];
  const outcome = negotiate(scenario.offers, scenario.benefits);
  assert.equal(outcome.status, 'success');
  if (outcome.status !== 'success') return;
  assert.deepEqual(verifySuccessOutcome(outcome, scenario.offers, scenario.benefits).errors, []);
});

test('unsatisfiable outcomes pass independent verification', () => {
  for (const scenario of cases.slice(0, 2)) {
    const outcome = negotiate(scenario.offers, scenario.benefits);
    assert.equal(outcome.status, 'unsatisfiable');
    if (outcome.status !== 'unsatisfiable') continue;
    const verification = verifyUnsatisfiableOutcome(outcome);
    assert.deepEqual(verification.errors, [], scenario.name);
  }
});

test('core entries carry the structured payload for each kind', () => {
  const outcome = negotiate(cases[0].offers, cases[0].benefits);
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  for (const entry of outcome.core) {
    assert.equal(entry.kind, 'protocol');
    assert.ok(entry.protocolVersions && entry.protocolVersions.length > 0);
    assert.match(entry.id, /^protocol:/);
  }

  const featureOutcome = negotiate(cases[1].offers, cases[1].benefits);
  assert.equal(featureOutcome.status, 'unsatisfiable');
  if (featureOutcome.status !== 'unsatisfiable') return;
  for (const entry of featureOutcome.core) {
    assert.notEqual(entry.kind, 'protocol');
    if (entry.kind === 'required') {
      assert.ok(entry.feature);
      assert.match(entry.id, /^required:/);
    } else if (entry.kind === 'custom') {
      assert.ok(entry.expr);
      assert.ok(entry.sourceId);
      assert.match(entry.id, /^constraint:/);
    }
  }
});

test('removal witnesses are unique per core member and ordered like the core', () => {
  const outcome = negotiate(cases[1].offers, cases[1].benefits);
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  assert.deepEqual(
    outcome.removalWitnesses.map((w) => w.removedConstraintId),
    outcome.core.map((c) => c.id),
  );
  for (const removal of outcome.removalWitnesses) {
    assert.ok(removal.witness.protocolVersion.length > 0);
    assert.ok(Array.isArray(removal.witness.features));
    assert.deepEqual(
      removal.witness.features,
      [...removal.witness.features].sort(),
      'witness features should be ascending',
    );
  }
});
