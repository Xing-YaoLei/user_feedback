import assert from 'node:assert/strict';
import { test } from 'node:test';

import { negotiate, NegotiationSession } from '../src/index.ts';
import type { NegotiationSuccess } from '../src/index.ts';
import {
  referenceSolve,
  checkCore,
  coreIsMinimal,
  coreIsUnsatisfiable,
} from '../src/reference.ts';

function success(outcome: ReturnType<typeof negotiate>): NegotiationSuccess {
  assert.equal(outcome.status, 'success');
  return outcome as NegotiationSuccess;
}

test('maximizes benefit under support constraints', () => {
  const outcome = negotiate(
    [
      {
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['audio', 'video'],
      },
      {
        partyId: 'b',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['audio'],
      },
    ],
    { audio: 2, video: 10 },
  );
  const ok = success(outcome);
  assert.deepEqual(ok.features, ['audio']);
  assert.equal(ok.totalBenefit, 2);
});

test('alternative dependency: A requires B or C', () => {
  const offers = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: ['A', 'B', 'C'],
      constraints: [
        {
          id: 'A-needs-B-or-C',
          expr: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'feature', feature: 'A' } },
              { op: 'feature', feature: 'B' },
              { op: 'feature', feature: 'C' },
            ],
          },
        },
      ],
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: ['A', 'B', 'C'],
      constraints: [
        {
          id: 'no-B',
          expr: { op: 'not', arg: { op: 'feature', feature: 'B' } },
        },
      ],
    },
  ];
  const outcome = success(negotiate(offers, { A: 10, B: 4, C: 7 }));
  assert.deepEqual(outcome.features, ['A', 'C']);
  assert.equal(outcome.totalBenefit, 17);
});

test('tie-break picks lexicographically smallest feature list', () => {
  const outcome = success(
    negotiate(
      [
        {
          partyId: 'a',
          offerVersion: '1',
          protocolVersions: ['v1'],
          supportedFeatures: ['alpha', 'beta'],
          constraints: [
            {
              id: 'cap-one',
              expr: { op: 'atMost', features: ['alpha', 'beta'], count: 1 },
            },
          ],
        },
      ],
      { alpha: 5, beta: 5 },
    ),
  );
  // Both singletons have benefit 5; ['alpha'] < ['beta'].
  assert.deepEqual(outcome.features, ['alpha']);
});

test('protocol version is bound to the smallest common version', () => {
  const outcome = success(
    negotiate(
      [
        {
          partyId: 'a',
          offerVersion: '1',
          protocolVersions: ['v3', 'v1', 'v2'],
          supportedFeatures: ['x'],
        },
        {
          partyId: 'b',
          offerVersion: '1',
          protocolVersions: ['v2', 'v1'],
          supportedFeatures: ['x'],
        },
      ],
      { x: 1 },
    ),
  );
  assert.equal(outcome.protocolVersion, 'v1');
});

test('package is immutable: inputs are not mutated or shared', () => {
  const offers = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: ['v2', 'v1'],
      supportedFeatures: ['x', 'y'],
    },
  ];
  const snapshot = JSON.stringify(offers);
  const outcome = success(negotiate(offers, { x: 1 }));
  assert.equal(JSON.stringify(offers), snapshot);
  assert.deepEqual(outcome.parties[0].acceptedProtocolVersions, ['v1', 'v2']);
});

test('result bindings report every offer version used', () => {
  const outcome = success(
    negotiate(
      [
        { partyId: 'a', offerVersion: '2', protocolVersions: ['v1'], supportedFeatures: ['x'] },
        { partyId: 'b', offerVersion: '9', protocolVersions: ['v1'], supportedFeatures: ['x'] },
      ],
      { x: 1 },
    ),
  );
  assert.deepEqual(outcome.offerVersions, { a: '2', b: '9' });
  assert.match(outcome.offersFingerprint, /^[0-9a-f]{64}$/);
});

test('session exposes current versions and requires new versions on change', () => {
  const session = new NegotiationSession({
    offers: [
      {
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['x', 'y'],
      },
    ],
    benefits: { x: 1, y: 1 },
  });
  assert.deepEqual(session.currentVersions(), { a: '1' });
  assert.throws(
    () =>
      session.updateOffer({
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['x'],
      }),
    /version/,
  );
  session.updateOffer({
    partyId: 'a',
    offerVersion: '2',
    protocolVersions: ['v1'],
    supportedFeatures: ['x'],
  });
  assert.deepEqual(session.currentVersions(), { a: '2' });
  const outcome = success(session.solve());
  assert.deepEqual(outcome.offerVersions, { a: '2' });
});

test('reference solver and negotiator agree on small random instances', () => {
  let seed = 42;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const features = ['f1', 'f2', 'f3', 'f4'];
  for (let trial = 0; trial < 25; trial++) {
    const parties: string[] = ['a', 'b'];
    const offers = parties.map((partyId) => ({
      partyId,
      offerVersion: '1',
      protocolVersions: rand(2) === 0 ? ['v1'] : ['v1', 'v2'],
      supportedFeatures: features.filter(() => rand(2) === 0),
      requiredFeatures: [] as string[],
      constraints: [] as { id: string; expr: never }[],
    }));
    // Ensure at least one feature is supported by all parties sometimes.
    const benefits: Record<string, number> = {};
    for (const feature of features) benefits[feature] = rand(5);

    const expected = referenceSolve(offers as never, benefits);
    const actual = negotiate(offers as never, benefits);
    assert.equal(
      actual.status === 'success',
      expected.satisfiable,
      `satisfiability mismatch on trial ${trial}: ${JSON.stringify(offers)}`,
    );
    if (actual.status === 'success' && expected.solution !== null) {
      assert.equal(actual.totalBenefit, expected.solution.totalBenefit, `benefit mismatch trial ${trial}`);
      assert.deepEqual(actual.features, expected.solution.features, `feature mismatch trial ${trial}`);
    }
  }
});

test('unsatisfiable core is minimal and verified by exhaustive search', () => {
  const offers = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: ['x', 'y'],
      requiredFeatures: ['x'],
      constraints: [
        { id: 'x-excludes-y', expr: { op: 'not', arg: { op: 'feature', feature: 'y' } } as const },
      ],
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: ['x', 'y'],
      requiredFeatures: ['y'],
    },
  ];
  const outcome = negotiate(offers, { x: 1, y: 1 });
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  assert.ok(outcome.core.length >= 2);
  assert.ok(coreIsUnsatisfiable(outcome.core));
  assert.ok(coreIsMinimal(outcome.core));
  for (const member of outcome.core) {
    const check = checkCore(outcome.core, member.id);
    assert.ok(check.satisfiable, `core minus ${member.id} should be satisfiable`);
    const witness = outcome.removalWitnesses.find((w) => w.removedConstraintId === member.id);
    assert.ok(witness, `missing witness for ${member.id}`);
  }
});
