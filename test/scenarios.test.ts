import assert from 'node:assert/strict';
import { test } from 'node:test';

import { negotiate, verifySuccessOutcome, verifyUnsatisfiableOutcome } from '../src/index.ts';
import type { NegotiationSuccess, NegotiationUnsatisfiable, Offer } from '../src/index.ts';
import { checkCore, coreIsMinimal, coreIsUnsatisfiable, referenceSolve } from '../src/reference.ts';

const v1 = ['v1'];

test('scenario: pairwise-compatible protocols with no global overlap', () => {
  const offers: Offer[] = [
    { partyId: 'a', offerVersion: '1', protocolVersions: ['v1', 'v2'], supportedFeatures: ['x'] },
    { partyId: 'b', offerVersion: '1', protocolVersions: ['v2', 'v3'], supportedFeatures: ['x'] },
    { partyId: 'c', offerVersion: '1', protocolVersions: ['v1', 'v3'], supportedFeatures: ['x'] },
  ];
  const outcome = negotiate(offers, { x: 1 });
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;

  // Every pair shares a version, so each pair alone is satisfiable.
  for (const pair of [
    ['a', 'b'],
    ['b', 'c'],
    ['a', 'c'],
  ]) {
    const subset = offers.filter((offer) => pair.includes(offer.partyId));
    assert.equal(referenceSolve(subset, { x: 1 }).satisfiable, true, `pair ${pair} must work`);
  }
  assert.equal(referenceSolve(offers, { x: 1 }).satisfiable, false);

  assert.deepEqual(
    outcome.core.map((entry) => entry.id),
    ['protocol:a', 'protocol:b', 'protocol:c'],
  );
  assert.ok(coreIsUnsatisfiable(outcome.core));
  assert.ok(coreIsMinimal(outcome.core));
  const report = verifyUnsatisfiableOutcome(outcome);
  assert.deepEqual(report.errors, []);
});

test('scenario: pairwise-compatible features but a global cardinality conflict', () => {
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['x', 'y'],
      requiredFeatures: ['x'],
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['x', 'y'],
      requiredFeatures: ['y'],
    },
    {
      partyId: 'c',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['x', 'y'],
      constraints: [
        { id: 'only-one', expr: { op: 'atMost', features: ['x', 'y'], count: 1 } },
      ],
    },
  ];
  const benefits = { x: 3, y: 3 };
  // Any two parties can be satisfied together.
  for (const subset of [
    [0, 1],
    [0, 2],
    [1, 2],
  ]) {
    assert.equal(
      referenceSolve(subset.map((i) => offers[i]), benefits).satisfiable,
      true,
      `subset ${subset} for ${JSON.stringify(subset.map((i) => offers[i].partyId))}`,
    );
  }
  const outcome = negotiate(offers, benefits);
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  assert.deepEqual(
    outcome.core.map((entry) => entry.id),
    ['constraint:c:only-one', 'required:a:x', 'required:b:y'],
  );
  assert.ok(coreIsMinimal(outcome.core));
  assert.deepEqual(verifyUnsatisfiableOutcome(outcome).errors, []);
});

test('scenario: a high-benefit option must not block a required dependency', () => {
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['basic', 'premium', 'premium-codec'],
      requiredFeatures: ['basic'],
      constraints: [
        // premium requires its codec...
        {
          id: 'premium-needs-codec',
          expr: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'feature', feature: 'premium' } },
              { op: 'feature', feature: 'premium-codec' },
            ],
          },
        },
        // ...but premium and basic are mutually exclusive.
        {
          id: 'premium-excludes-basic',
          expr: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'feature', feature: 'premium' } },
              { op: 'not', arg: { op: 'feature', feature: 'basic' } },
            ],
          },
        },
        // The codec is only usable together with premium.
        {
          id: 'codec-needs-premium',
          expr: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'feature', feature: 'premium-codec' } },
              { op: 'feature', feature: 'premium' },
            ],
          },
        },
      ],
    },
  ];
  const benefits = { basic: 1, premium: 100, 'premium-codec': 5 };
  const outcome = negotiate(offers, benefits);
  assert.equal(outcome.status, 'success');
  if (outcome.status !== 'success') return;
  // Greedy would grab premium (100); correctness requires giving it up for basic.
  assert.deepEqual(outcome.features, ['basic']);
  assert.equal(outcome.totalBenefit, 1);
  assert.deepEqual(verifySuccessOutcome(outcome, offers, benefits).errors, []);
});

test('scenario: high benefit alone is not enough if its dependency is impossible', () => {
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['basic', 'premium'],
      constraints: [
        {
          id: 'premium-needs-missing-codec',
          expr: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'feature', feature: 'premium' } },
              { op: 'feature', feature: 'missing-codec' },
            ],
          },
        },
      ],
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['basic', 'premium'],
    },
  ];
  const benefits = { basic: 1, premium: 50 };
  const outcome = negotiate(offers, benefits);
  assert.equal(outcome.status, 'success');
  if (outcome.status !== 'success') return;
  assert.deepEqual(outcome.features, ['basic']);
});

test('scenario: alternative dependency resolves via the cheaper branch', () => {
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: v1,
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
        // Only one of the fallbacks may be enabled.
        { id: 'one-fallback', expr: { op: 'atMost', features: ['B', 'C'], count: 1 } },
      ],
    },
  ];
  const benefits = { A: 10, B: 2, C: 6 };
  const outcome = negotiate(offers, benefits);
  assert.equal(outcome.status, 'success');
  if (outcome.status !== 'success') return;
  // A + C (16) beats A + B (12); both satisfy the alternative dependency.
  assert.deepEqual(outcome.features, ['A', 'C']);
  assert.equal(outcome.totalBenefit, 16);
});

test('scenario: mutually exclusive features yield the higher total', () => {
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['x', 'y', 'z'],
      constraints: [{ id: 'x-y-exclusive', expr: { op: 'atMost', features: ['x', 'y'], count: 1 } }],
    },
  ];
  const benefits = { x: 4, y: 7, z: 3 };
  const outcome = negotiate(offers, benefits);
  assert.equal(outcome.status, 'success');
  if (outcome.status !== 'success') return;
  assert.deepEqual(outcome.features, ['y', 'z']);
  assert.equal(outcome.totalBenefit, 10);
});

test('scenario: offer update removes an old conflict and changes the answer', () => {
  // Party b starts by refusing video; negotiation picks audio only.
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['audio', 'video'],
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['audio'],
    },
  ];
  const first = negotiate(offers, { audio: 1, video: 9 });
  assert.equal(first.status, 'success');
  if (first.status !== 'success') return;
  assert.deepEqual(first.features, ['audio']);

  // b publishes version 2 adding video support.
  const updated: Offer[] = [offers[0], { ...offers[1], offerVersion: '2', supportedFeatures: ['audio', 'video'] }];
  const second = negotiate(updated, { audio: 1, video: 9 });
  assert.equal(second.status, 'success');
  if (second.status !== 'success') return;
  assert.deepEqual(second.features, ['audio', 'video']);
  assert.equal(second.totalBenefit, 10);
  assert.deepEqual(second.offerVersions, { a: '1', b: '2' });
  assert.notEqual(second.offersFingerprint, first.offersFingerprint);
});

test('scenario: difficult global conflict is detected, and each witness is valid', () => {
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: ['v1', 'v2'],
      supportedFeatures: ['p', 'q', 'r'],
      requiredFeatures: ['p'],
      constraints: [{ id: 'p-implies-q', expr: { op: 'or', args: [{ op: 'not', arg: { op: 'feature', feature: 'p' } }, { op: 'feature', feature: 'q' }] } }],
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: ['v1', 'v2'],
      supportedFeatures: ['p', 'q', 'r'],
      constraints: [{ id: 'q-implies-r', expr: { op: 'or', args: [{ op: 'not', arg: { op: 'feature', feature: 'q' } }, { op: 'feature', feature: 'r' }] } }],
    },
    {
      partyId: 'c',
      offerVersion: '1',
      protocolVersions: ['v1', 'v2'],
      supportedFeatures: ['p', 'q', 'r'],
      constraints: [{ id: 'no-r', expr: { op: 'not', arg: { op: 'feature', feature: 'r' } } }],
    },
  ];
  const outcome = negotiate(offers, { p: 1, q: 1, r: 1 });
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  assert.ok(coreIsUnsatisfiable(outcome.core));
  assert.ok(coreIsMinimal(outcome.core));
  // The core must be exactly the implication chain plus the contradiction.
  assert.deepEqual(
    outcome.core.map((entry) => entry.id),
    ['constraint:a:p-implies-q', 'constraint:b:q-implies-r', 'constraint:c:no-r', 'required:a:p'],
  );
  for (const member of outcome.core) {
    const check = checkCore(outcome.core, member.id);
    assert.ok(check.satisfiable);
  }
  assert.deepEqual(verifyUnsatisfiableOutcome(outcome).errors, []);
});

test('scenario: unsupported feature mentioned only in a constraint is handled', () => {
  const offers: Offer[] = [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: v1,
      supportedFeatures: ['x'],
      constraints: [{ id: 'ghost', expr: { op: 'feature', feature: 'ghost-feature' } }],
    },
  ];
  const outcome = negotiate(offers, { x: 1, 'ghost-feature': 100 });
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  // Core needs the constraint and an explicit support rule for the ghost.
  const ids = outcome.core.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ['constraint:a:ghost', 'support:a:ghost-feature']);
  assert.ok(coreIsMinimal(outcome.core));
});

test('scenario: protocol tie-break and feature tie-break together are reproducible', () => {
  const offers: Offer[] = [
    { partyId: 'a', offerVersion: '1', protocolVersions: ['v2', 'v1'], supportedFeatures: ['b', 'a'] },
    { partyId: 'b', offerVersion: '1', protocolVersions: ['v1', 'v2'], supportedFeatures: ['b', 'a'] },
  ];
  const benefits = { a: 5, b: 5 };
  const offersWithCap: Offer[] = offers.map((offer) => ({
    ...offer,
    constraints: [{ id: 'cap-one', expr: { op: 'atMost' as const, features: ['a', 'b'], count: 1 } }],
  }));
  const runs = Array.from({ length: 5 }, () => negotiate(offersWithCap, benefits));
  const first = runs[0];
  assert.equal(first.status, 'success');
  for (const run of runs) {
    assert.deepEqual(run, first);
  }
  if (first.status !== 'success') return;
  assert.equal(first.protocolVersion, 'v1');
  assert.deepEqual(first.features, ['a']);
});
