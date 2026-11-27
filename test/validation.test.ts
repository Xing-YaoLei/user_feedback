import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  negotiate,
  NegotiationInputError,
  NegotiationSession,
  InvalidProgressError,
} from '../src/index.ts';
import type { NegotiationSuccess, Offer } from '../src/index.ts';

function success(outcome: ReturnType<typeof negotiate>): NegotiationSuccess {
  assert.equal(outcome.status, 'success');
  return outcome as NegotiationSuccess;
}

test('rejects an empty offer list', () => {
  assert.throws(() => negotiate([], {}), NegotiationInputError);
});

test('rejects duplicate party ids', () => {
  assert.throws(
    () =>
      negotiate(
        [
          { partyId: 'a', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: [] },
          { partyId: 'a', offerVersion: '2', protocolVersions: ['v1'], supportedFeatures: [] },
        ],
        {},
      ),
    NegotiationInputError,
  );
});

test('rejects a party with no acceptable protocol version', () => {
  assert.throws(
    () =>
      negotiate(
        [{ partyId: 'a', offerVersion: '1', protocolVersions: [], supportedFeatures: [] }],
        {},
      ),
    NegotiationInputError,
  );
});

test('rejects required features that the party does not support', () => {
  assert.throws(
    () =>
      negotiate(
        [
          {
            partyId: 'a',
            offerVersion: '1',
            protocolVersions: ['v1'],
            supportedFeatures: ['x'],
            requiredFeatures: ['y'],
          },
        ],
        {},
      ),
    /requires unsupported feature/,
  );
});

test('rejects non-integer benefits', () => {
  assert.throws(
    () =>
      negotiate(
        [{ partyId: 'a', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['x'] }],
        { x: 1.5 },
      ),
    NegotiationInputError,
  );
});

test('rejects malformed expressions', () => {
  const base = {
    partyId: 'a',
    offerVersion: '1',
    protocolVersions: ['v1'],
    supportedFeatures: ['x'],
  };
  assert.throws(
    () =>
      negotiate(
        [
          {
            ...base,
            constraints: [{ id: 'bad', expr: { op: 'unknown' } as never }],
          },
        ],
        { x: 1 },
      ),
    NegotiationInputError,
  );
  assert.throws(
    () =>
      negotiate(
        [
          {
            ...base,
            constraints: [{ id: 'empty-and', expr: { op: 'and', args: [] } }],
          },
        ],
        { x: 1 },
      ),
    /at least one operand/,
  );
  assert.throws(
    () =>
      negotiate(
        [
          {
            ...base,
            constraints: [{ id: 'overflow', expr: { op: 'exactly', features: ['x'], count: 5 } }],
          },
        ],
        { x: 1 },
      ),
    /exceeds feature count/,
  );
});

test('rejects duplicate constraint ids within one offer', () => {
  assert.throws(
    () =>
      negotiate(
        [
          {
            partyId: 'a',
            offerVersion: '1',
            protocolVersions: ['v1'],
            supportedFeatures: ['x'],
            constraints: [
              { id: 'same', expr: { op: 'feature', feature: 'x' } },
              { id: 'same', expr: { op: 'not', arg: { op: 'feature', feature: 'x' } } },
            ],
          },
        ],
        { x: 1 },
      ),
    /Duplicate constraint id/,
  );
});

test('rejects an invalid step budget', () => {
  const offers: Offer[] = [
    { partyId: 'a', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['x'] },
  ];
  assert.throws(() => negotiate(offers, { x: 1 }, { maxSteps: 0 }), NegotiationInputError);
  assert.throws(() => negotiate(offers, { x: 1 }, { maxSteps: -3 }), NegotiationInputError);
  assert.throws(() => negotiate(offers, { x: 1 }, { maxSteps: 1.5 }), NegotiationInputError);
});

test('rejects malformed resume objects', () => {
  const offers: Offer[] = [
    { partyId: 'a', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['x'] },
  ];
  assert.throws(
    () => negotiate(offers, { x: 1 }, { resume: null as never }),
    InvalidProgressError,
  );
  assert.throws(
    () => negotiate(offers, { x: 1 }, { resume: { token: 'nope' } as never }),
    InvalidProgressError,
  );
});

test('result is independent of offer and feature input order', () => {
  const partyA: Offer = {
    partyId: 'a',
    offerVersion: '1',
    protocolVersions: ['v2', 'v1'],
    supportedFeatures: ['z', 'y', 'x'],
  };
  const partyB: Offer = {
    partyId: 'b',
    offerVersion: '1',
    protocolVersions: ['v1', 'v2'],
    supportedFeatures: ['x', 'z', 'y'],
    constraints: [{ id: 'cap', expr: { op: 'atMost', features: ['y', 'z'], count: 1 } }],
  };
  const benefits = { z: 3, y: 3, x: 1 };
  const first = success(negotiate([partyA, partyB], benefits));
  const second = success(negotiate([partyB, partyA], benefits));
  assert.deepEqual(second, first);
  assert.equal(first.protocolVersion, 'v1');
  // Constraint allows only one of {y, z}; equal benefit, so lexicographic
  // tie-break picks 'y' (['x','y'] < ['x','z']).
  assert.deepEqual(first.features, ['x', 'y']);
});

test('duplicate feature declarations collapse', () => {
  const outcome = success(
    negotiate(
      [
        {
          partyId: 'a',
          offerVersion: '1',
          protocolVersions: ['v1', 'v1'],
          supportedFeatures: ['x', 'x', 'y'],
        },
      ],
      { x: 1, y: 1 },
    ),
  );
  assert.deepEqual(outcome.parties[0].acceptedProtocolVersions, ['v1']);
  assert.deepEqual(outcome.parties[0].supportedFeatures, ['x', 'y']);
});

test('offers with no features still succeed with an empty solution', () => {
  const outcome = success(
    negotiate(
      [
        { partyId: 'a', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: [] },
        { partyId: 'b', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: [] },
      ],
      {},
    ),
  );
  assert.deepEqual(outcome.features, []);
  assert.equal(outcome.totalBenefit, 0);
});

test('conflicting required features on a single party is unsatisfiable and minimal', () => {
  const outcome = negotiate(
    [
      {
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['x', 'y'],
        requiredFeatures: ['x', 'y'],
        constraints: [{ id: 'only-one', expr: { op: 'atMost', features: ['x', 'y'], count: 1 } }],
      },
    ],
    { x: 1, y: 1 },
  );
  assert.equal(outcome.status, 'unsatisfiable');
  if (outcome.status !== 'unsatisfiable') return;
  assert.deepEqual(
    outcome.core.map((entry) => entry.id),
    ['constraint:a:only-one', 'required:a:x', 'required:a:y'],
  );
});

test('session binds results to the versions present at solve time', () => {
  const session = new NegotiationSession({
    offers: [
      { partyId: 'a', offerVersion: 'v10', protocolVersions: ['v1'], supportedFeatures: ['x'] },
      { partyId: 'b', offerVersion: 'v20', protocolVersions: ['v1'], supportedFeatures: ['x'] },
    ],
    benefits: { x: 1 },
  });
  const before = success(session.solve());
  assert.deepEqual(before.offerVersions, { a: 'v10', b: 'v20' });

  session.updateOffer({
    partyId: 'b',
    offerVersion: 'v21',
    protocolVersions: ['v1'],
    supportedFeatures: ['x', 'y'],
  });
  const after = success(session.solve());
  assert.deepEqual(after.offerVersions, { a: 'v10', b: 'v21' });
  assert.notEqual(after.offersFingerprint, before.offersFingerprint);
  // The old result still reports the versions it was computed from.
  assert.deepEqual(before.offerVersions, { a: 'v10', b: 'v20' });
});

test('session accepts an offer that restores an older version number only if content is new', () => {
  const session = new NegotiationSession({
    offers: [
      { partyId: 'a', offerVersion: '1', protocolVersions: ['v1'], supportedFeatures: ['x'] },
    ],
    benefits: { x: 1 },
  });
  session.updateOffer({
    partyId: 'a',
    offerVersion: '2',
    protocolVersions: ['v1'],
    supportedFeatures: ['x', 'y'],
  });
  session.updateOffer({
    partyId: 'a',
    offerVersion: '3',
    protocolVersions: ['v1'],
    supportedFeatures: ['x'],
  });
  // Reusing version 2 with its original content is idempotent...
  session.updateOffer({
    partyId: 'a',
    offerVersion: '2',
    protocolVersions: ['v1'],
    supportedFeatures: ['x', 'y'],
  });
  assert.deepEqual(session.currentVersions(), { a: '2' });
  // ...but reusing it with different content is refused.
  assert.throws(
    () =>
      session.updateOffer({
        partyId: 'a',
        offerVersion: '2',
        protocolVersions: ['v1'],
        supportedFeatures: ['x'],
      }),
    /version/,
  );
});
