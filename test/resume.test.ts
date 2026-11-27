import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  negotiate,
  NegotiationSession,
  StaleProgressError,
  InvalidProgressError,
  OfferVersionConflictError,
  UnknownPartyError,
} from '../src/index.ts';
import type {
  NegotiationOutcome,
  NegotiationUnsatisfiable,
  NegotiationUndetermined,
  Offer,
  SearchProgress,
} from '../src/index.ts';
import { checkCore, coreIsMinimal, coreIsUnsatisfiable, referenceSolve } from '../src/reference.ts';

/** Features chosen so optimization needs many nodes. */
function wideOffers(count: number): Offer[] {
  const features = Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, '0')}`);
  return [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: features,
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: features.slice(0, Math.ceil(features.length / 2)),
    },
  ];
}

/**
 * An unsatisfiable instance with redundant noise constraints, so the MUS
 * deletion pass performs many SAT checks and each SAT check needs backtracking.
 */
function conflictOffers(): Offer[] {
  const features = ['p', 'q', 'r', 's', 't'];
  const implies = (from: string, to: string): never =>
    ({
      op: 'or',
      args: [
        { op: 'not', arg: { op: 'feature', feature: from } },
        { op: 'feature', feature: to },
      ],
    }) as never;
  return [
    {
      partyId: 'a',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: features,
      requiredFeatures: ['p'],
      constraints: [
        { id: 'p-implies-q', expr: implies('p', 'q') },
        { id: 'noise-s-implies-t', expr: implies('s', 't') },
      ],
    },
    {
      partyId: 'b',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: features,
      constraints: [
        { id: 'q-implies-r', expr: implies('q', 'r') },
        { id: 'noise-s-t-exclusive', expr: { op: 'atMost', features: ['s', 't'], count: 1 } as never },
      ],
    },
    {
      partyId: 'c',
      offerVersion: '1',
      protocolVersions: ['v1'],
      supportedFeatures: features,
      constraints: [
        {
          id: 'r-excludes-p',
          expr: {
            op: 'or',
            args: [
              { op: 'not', arg: { op: 'feature', feature: 'r' } },
              { op: 'not', arg: { op: 'feature', feature: 'p' } },
            ],
          } as never,
        },
      ],
    },
  ];
}

function stripSearch(outcome: NegotiationOutcome): unknown {
  const copy = JSON.parse(JSON.stringify(outcome)) as Record<string, unknown>;
  delete copy.search;
  if (copy.status === 'undetermined') delete copy.progress;
  return copy;
}

function drain(
  offers: Offer[],
  benefits: Record<string, number>,
  budget: number,
): { outcome: NegotiationOutcome; rounds: number; explored: number[] } {
  let outcome = negotiate(offers, benefits, { maxSteps: budget });
  const explored: number[] = [outcome.search.explored];
  let rounds = 1;
  while (outcome.status === 'undetermined' && rounds < 100_000) {
    outcome = negotiate(offers, benefits, {
      maxSteps: budget,
      resume: (outcome as NegotiationUndetermined).progress,
    });
    explored.push(outcome.search.explored);
    rounds += 1;
  }
  return { outcome, rounds, explored };
}

/** Continue a run from an explicit token, resuming as needed. */
function drainFrom(
  offers: Offer[],
  benefits: Record<string, number>,
  budget: number,
  resume: SearchProgress,
): { outcome: NegotiationOutcome; rounds: number } {
  let outcome = negotiate(offers, benefits, { maxSteps: budget, resume });
  let rounds = 1;
  while (outcome.status === 'undetermined' && rounds < 100_000) {
    outcome = negotiate(offers, benefits, {
      maxSteps: budget,
      resume: (outcome as NegotiationUndetermined).progress,
    });
    rounds += 1;
  }
  return { outcome, rounds };
}

test('budgeted run reaches the same success as an unbudgeted run', () => {
  const offers = wideOffers(10);
  const benefits = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`f${String(i).padStart(2, '0')}`, i + 1]),
  );
  const unbudgeted = negotiate(offers, benefits);
  assert.equal(unbudgeted.status, 'success');

  const { outcome, rounds, explored } = drain(offers, benefits, 3);
  assert.equal(outcome.status, 'success');
  assert.ok(rounds > 1, 'the budget must actually bite');
  assert.deepEqual(stripSearch(outcome), stripSearch(unbudgeted));
  // Explored counters are monotone non-decreasing and terminate at the total.
  for (let i = 1; i < explored.length; i++) assert.ok(explored[i] >= explored[i - 1]);
  if (outcome.status === 'success') {
    assert.equal(outcome.search.resumed, true);
    assert.equal(explored[explored.length - 1], outcome.search.explored);
  }
});

test('budgeted run during MUS replication reaches the same minimal core', () => {
  const offers = conflictOffers();
  const benefits = { p: 1, q: 1, r: 1, s: 1, t: 1 };
  const unbudgeted = negotiate(offers, benefits);
  assert.equal(unbudgeted.status, 'unsatisfiable');

  const { outcome, rounds } = drain(offers, benefits, 1);
  assert.equal(outcome.status, 'unsatisfiable');
  assert.ok(rounds > 2);
  if (outcome.status !== 'unsatisfiable' || unbudgeted.status !== 'unsatisfiable') return;
  assert.deepEqual(
    outcome.core.map((entry) => entry.id),
    unbudgeted.core.map((entry) => entry.id),
  );
  assert.deepEqual(outcome.removalWitnesses, unbudgeted.removalWitnesses);
});

test('budget exhaustion returns a resumable token bound to offer versions', () => {
  const offers = wideOffers(12);
  const benefits = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, '0')}`, 1]),
  );
  const partial = negotiate(offers, benefits, { maxSteps: 2 });
  assert.equal(partial.status, 'undetermined');
  if (partial.status !== 'undetermined') return;
  assert.equal(partial.search.exhaustedBudget, true);
  assert.equal(partial.progress.snapshot, partial.offersFingerprint);
  assert.deepEqual(partial.progress.offerVersions, partial.offerVersions);
  assert.ok(partial.progress.explored >= 2);
  // Progress survives a JSON round-trip unchanged and remains usable.
  const roundTripped = JSON.parse(JSON.stringify(partial.progress)) as SearchProgress;
  const { outcome: next } = drainFrom(offers, benefits, 5, roundTripped);
  assert.notEqual(next.status, 'undetermined');
  assert.ok(next.search.explored > partial.search.explored);
});

test('progress from an old offer version is rejected, not reused', () => {
  const offers = wideOffers(8);
  const benefits = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`f${String(i).padStart(2, '0')}`, 1]),
  );
  const partial = negotiate(offers, benefits, { maxSteps: 2 });
  assert.equal(partial.status, 'undetermined');
  if (partial.status !== 'undetermined') return;

  const updated: Offer[] = [offers[0], { ...offers[1], offerVersion: '2' }];
  assert.throws(
    () => negotiate(updated, benefits, { resume: partial.progress }),
    (error: unknown) => {
      assert.ok(error instanceof StaleProgressError);
      assert.equal(error.expectedSnapshot, partial.progress.snapshot);
      return true;
    },
  );

  // Re-solving from scratch against the updated offers is still correct.
  const fresh = negotiate(updated, benefits);
  assert.equal(fresh.status, 'success');
  if (fresh.status !== 'success') return;
  assert.deepEqual(fresh.offerVersions, { a: '1', b: '2' });
});

test('resuming with a token from another module is rejected', () => {
  const offers = wideOffers(6);
  const benefits = { f00: 1, f01: 1, f02: 1, f03: 1, f04: 1, f05: 1 };
  const fake = { token: 'other-module', snapshot: '0'.repeat(64), explored: 0 } as unknown as SearchProgress;
  assert.throws(() => negotiate(offers, benefits, { resume: fake }), InvalidProgressError);
});

test('resume token tampering is detected', () => {
  const offers = wideOffers(8);
  const benefits = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`f${String(i).padStart(2, '0')}`, 1]),
  );
  const partial = negotiate(offers, benefits, { maxSteps: 2 });
  assert.equal(partial.status, 'undetermined');
  if (partial.status !== 'undetermined') return;
  const tampered = JSON.parse(JSON.stringify(partial.progress)) as SearchProgress;
  (tampered as { snapshot: string }).snapshot = 'f'.repeat(64);
  assert.throws(() => negotiate(offers, benefits, { resume: tampered }), StaleProgressError);
});

test('session rejects unknown parties and version reuse with new content', () => {
  const session = new NegotiationSession({
    offers: [
      {
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: ['x'],
      },
    ],
    benefits: { x: 1 },
  });
  assert.throws(
    () =>
      session.updateOffer({
        partyId: 'ghost',
        offerVersion: '1',
        protocolVersions: ['v1'],
        supportedFeatures: [],
      }),
    UnknownPartyError,
  );
  assert.throws(
    () =>
      session.updateOffer({
        partyId: 'a',
        offerVersion: '1',
        protocolVersions: ['v2'],
        supportedFeatures: ['x'],
      }),
    OfferVersionConflictError,
  );
  // Re-publishing identical content under the same version is a no-op.
  const epoch = session.epoch;
  session.updateOffer({
    partyId: 'a',
    offerVersion: '1',
    protocolVersions: ['v1'],
    supportedFeatures: ['x'],
  });
  assert.equal(session.epoch, epoch);
});

test('stale progress can be discarded explicitly to solve current offers', () => {
  const offers = wideOffers(8);
  const benefits = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`f${String(i).padStart(2, '0')}`, 1]),
  );
  const partial = negotiate(offers, benefits, { maxSteps: 2 });
  assert.equal(partial.status, 'undetermined');
  if (partial.status !== 'undetermined') return;

  const updated: Offer[] = [offers[0], { ...offers[1], offerVersion: '2' }];
  const restarted = negotiate(updated, benefits, {
    resume: partial.progress,
    staleProgress: 'restart',
  });
  assert.equal(restarted.status, 'success');
  if (restarted.status !== 'success') return;
  // The answer is the one for the *current* offers, not the old snapshot.
  assert.deepEqual(restarted.offerVersions, { a: '1', b: '2' });
  assert.equal(restarted.search.resumed, false);
  const fresh = negotiate(updated, benefits);
  assert.deepEqual(restarted.features, fresh.status === 'success' ? fresh.features : null);
});

test('restart still rejects a token that is malformed rather than stale', () => {
  const offers = wideOffers(6);
  const benefits = { f00: 1, f01: 1, f02: 1, f03: 1, f04: 1, f05: 1 };
  assert.throws(
    () => negotiate(offers, benefits, { resume: null as never, staleProgress: 'restart' }),
    InvalidProgressError,
  );
});

test('session solve rejects stale progress after an offer update', () => {
  const session = new NegotiationSession({
    offers: wideOffers(8),
    benefits: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`f${String(i).padStart(2, '0')}`, 1]),
    ),
  });
  const partial = session.solve({ maxSteps: 2 });
  assert.equal(partial.status, 'undetermined');
  if (partial.status !== 'undetermined') return;
  session.updateOffer({ ...wideOffers(8)[1], offerVersion: '2', supportedFeatures: ['f00'] });
  assert.throws(() => session.solve({ resume: partial.progress }), StaleProgressError);
  const fresh = session.solve();
  assert.equal(fresh.status, 'success');
  if (fresh.status !== 'success') return;
  assert.deepEqual(fresh.features, ['f00']);
});

test('crash mid-MUS: serialized progress replay equals uninterrupted replay', () => {
  const offers = conflictOffers();
  const benefits = { p: 1, q: 1, r: 1, s: 1, t: 1 };
  const uninterrupted = negotiate(offers, benefits) as NegotiationUnsatisfiable;
  assert.equal(uninterrupted.status, 'unsatisfiable');

  // Every possible one-step prefix must be able to finish to the same result.
  for (let budget = 1; budget <= 6; budget++) {
    const { outcome } = drain(offers, benefits, budget);
    assert.equal(outcome.status, 'unsatisfiable');
    if (outcome.status !== 'unsatisfiable') continue;
    assert.deepEqual(
      outcome.core.map((entry) => entry.id),
      uninterrupted.core.map((entry) => entry.id),
      `core differs at budget ${budget}`,
    );
  }
});

test('optimizer cross-checks against exhaustive reference on random instances', () => {
  let seed = 2026;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const features = ['a', 'b', 'c', 'd', 'e'];
  const exprFor = (): never => {
    const kind = rand(4);
    if (kind === 0) {
      return { op: 'not', arg: { op: 'feature', feature: features[rand(features.length)] } } as never;
    }
    if (kind === 1) {
      const f = features[rand(features.length)];
      const g = features[rand(features.length)];
      return {
        op: 'or',
        args: [
          { op: 'not', arg: { op: 'feature', feature: f } },
          { op: 'feature', feature: g },
        ],
      } as never;
    }
    if (kind === 2) {
      return {
        op: 'atMost',
        features: features.filter(() => rand(2) === 0),
        count: rand(3),
      } as never;
    }
    return {
      op: 'atLeast',
      features: features.filter(() => rand(2) === 0),
      count: rand(3),
    } as never;
  };

  for (let trial = 0; trial < 40; trial++) {
    const offers: Offer[] = Array.from({ length: 1 + rand(3) }, (_, p) => ({
      partyId: `p${p}`,
      offerVersion: '1',
      protocolVersions: rand(2) === 0 ? ['v1'] : ['v1', 'v2'],
      supportedFeatures: features.filter(() => rand(4) !== 0),
      requiredFeatures: [] as string[],
      constraints: Array.from({ length: rand(3) }, (_, c) => ({
        id: `c${c}`,
        expr: exprFor(),
      })),
    }));
    const benefits: Record<string, number> = {};
    for (const feature of features) benefits[feature] = rand(6) - 1;

    let reference;
    try {
      reference = referenceSolve(offers, benefits);
    } catch {
      continue;
    }
    const outcome = negotiate(offers, benefits);
    assert.equal(
      outcome.status === 'success',
      reference.satisfiable,
      `trial ${trial}: ${JSON.stringify(offers)}`,
    );
    if (outcome.status === 'success' && reference.solution !== null) {
      assert.equal(outcome.totalBenefit, reference.solution.totalBenefit, `benefit trial ${trial}`);
      assert.deepEqual(outcome.features, reference.solution.features, `features trial ${trial}`);
    } else if (outcome.status === 'unsatisfiable') {
      // Core must be unsatisfiable and minimal; witnesses must be valid.
      assert.ok(coreIsUnsatisfiable(outcome.core), `core unsat trial ${trial}`);
      assert.ok(coreIsMinimal(outcome.core), `core minimal trial ${trial}`);
      for (const member of outcome.core) {
        assert.ok(checkCore(outcome.core, member.id).satisfiable, `removal trial ${trial}`);
      }
    }
  }
});
