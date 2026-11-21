/**
 * Scenario tests mirroring the specification's demanded cases:
 *
 *  1. a late *earlier* A re-assigns an already matched B,
 *  2. a late C invalidates an existing match,
 *  3. advancing different source watermarks yields the expected provisional
 *     revision, final match set and reclamation boundary,
 *  4. finalised result agrees with the reference rule over the complete input,
 *  5. backpressure preserves state while watermarks still finalise/reclaim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import { ev, matchKeys } from './helpers.ts';

test('late earlier A re-assigns an already-matched B, revising the provisional set', () => {
  const e = new CorrelationEngine({ sources: ['left', 'right'], windowMs: 10 });

  e.ingest(ev('b1', 'right', 'k', 'B', 6));
  const first = e.ingest(ev('a9', 'left', 'k', 'A', 5));
  assert.deepEqual(matchKeys(first.delta.added), ['k:a9->b1']);

  // a1 has an *earlier time* but arrives after a9. It may take b1.
  const late = e.ingest(ev('a1', 'left', 'k', 'A', 1));
  assert.deepEqual(matchKeys(late.delta.retracted), ['k:a9->b1']);
  assert.deepEqual(matchKeys(late.delta.added), ['k:a1->b1']);
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a1->b1']);

  // a9 now has no B it can use; it stays unmatched.
  assert.deepEqual(e.snapshot().all.map((m) => m.aId), ['a1']);

  e.end();
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b1']);
});

test('late earlier A cannot steal a B outside the window, leaving the match intact', () => {
  const e = new CorrelationEngine({ sources: ['left', 'right'], windowMs: 10 });
  e.ingest(ev('b', 'right', 'k', 'B', 6));
  e.ingest(ev('a9', 'left', 'k', 'A', 5));
  // a0.time + T = -4 + 10 = 6, exactly at b -> allowed and earlier.
  e.ingest(ev('a0', 'left', 'k', 'A', 0)); // 0 + 10 = 10 >= 6 -> allowed, earlier
  assert.deepEqual(matchKeys(e.snapshot().all), ['k:a0->b']);

  // aM is too late relative to b: 7 > 6 so it cannot use b at all.
  e.ingest(ev('aM', 'left', 'k', 'A', 7));
  assert.deepEqual(matchKeys(e.snapshot().all), ['k:a0->b']);
});

test('late C invalidates a match; provisional retraction is reported', () => {
  const e = new CorrelationEngine({ sources: ['left', 'right'], windowMs: 10 });
  e.ingest(ev('b', 'right', 'k', 'B', 9));
  e.ingest(ev('a', 'left', 'k', 'A', 0));
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a->b']);

  // C arrives late but its *event time* (4) sits inside [0, 9].
  const c = e.ingest(ev('c', 'right', 'k', 'C', 4));
  assert.deepEqual(matchKeys(c.delta.retracted), ['k:a->b']);
  assert.deepEqual(matchKeys(c.delta.added), []);
  assert.deepEqual(e.snapshot().all, []);

  e.end();
  assert.deepEqual(e.snapshot().final, []);
  // Cross-check: the oracle over the complete input agrees.
  const ref = referenceMatches(
    [
      ev('b', 'right', 'k', 'B', 9),
      ev('a', 'left', 'k', 'A', 0),
      ev('c', 'right', 'k', 'C', 4),
    ],
    10,
  );
  assert.deepEqual(matchKeys(ref.matches), []);
});

test('advancing different sources: provisional stays, then finalises and reclaims at the boundary', () => {
  const e = new CorrelationEngine({ sources: ['left', 'right'], windowMs: 10 });

  e.ingest(ev('b', 'right', 'k', 'B', 5));
  e.ingest(ev('a', 'left', 'k', 'A', 2)); // deadline 12
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a->b']);

  // Only left advances: progress is still gated by right (-Infinity).
  e.advanceWatermark('left', 100);
  assert.equal(e.globalProgress, Number.NEGATIVE_INFINITY);
  assert.equal(e.snapshot().final.length, 0);
  assert.equal(e.snapshot().provisional.length, 1);

  // Right advances to 12: progress 12, deadline 12 is not strictly past.
  e.advanceWatermark('right', 12);
  assert.equal(e.globalProgress, 12);
  assert.equal(e.snapshot().final.length, 0);
  assert.equal(e.snapshot().provisional.length, 1);
  assert.equal(e.stats().matchingHorizon, 2); // 12 - 10

  // Right advances to 13: progress 13 > deadline 12 -> finalise.
  const wm = e.advanceWatermark('right', 13);
  assert.equal(wm.progress, 13);
  assert.deepEqual(matchKeys(wm.finalized), ['k:a->b']);
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a->b']);
  assert.deepEqual(e.snapshot().provisional, []);
  // Horizon is now 3; the B at time 5 and its dedupe record may be reclaimed.
  assert.ok(e.stats().records <= 1, `records: ${e.stats().records}`);

  // The finalised result equals the complete-input rule.
  const ref = referenceMatches(
    [ev('b', 'right', 'k', 'B', 5), ev('a', 'left', 'k', 'A', 2)],
    10,
  );
  assert.deepEqual(matchKeys(e.snapshot().final), matchKeys(ref.matches));
});

test('reclamation boundary: records below progress - T drop, newer ones stay', () => {
  const e = new CorrelationEngine({ sources: ['left', 'right'], windowMs: 10 });
  // Old B/C that will fall below the horizon once progress advances.
  e.ingest(ev('bOld', 'right', 'k', 'B', 1));
  e.ingest(ev('cOld', 'right', 'k', 'C', 1));
  // A that finalises and its B.
  e.ingest(ev('b1', 'right', 'k2', 'B', 5));
  e.ingest(ev('a1', 'left', 'k2', 'A', 2));
  // A pending with a large deadline keeps history near it alive.
  e.ingest(ev('a2', 'left', 'k3', 'A', 9)); // deadline 19
  e.ingest(ev('b2', 'right', 'k3', 'B', 9));

  e.advanceWatermark('left', 1000);
  e.advanceWatermark('right', 1000); // progress 1000, horizon 990

  const stats = e.stats();
  // Everything is below horizon 990, so active events are reclaimed; the
  // finalised pairs remain in the final result.
  assert.equal(stats.activeEvents, 0);
  assert.deepEqual(matchKeys(e.snapshot().final), ['k2:a1->b1', 'k3:a2->b2']);
  assert.deepEqual(e.snapshot().provisional, []);
  // The old B/C and all finalised history have been reclaimed.
  assert.equal(stats.records, 0);
});

test('backpressure preserves state; watermark still finalises and reclaims', () => {
  const e = new CorrelationEngine({ sources: ['left', 'right'], windowMs: 10, maxRecords: 3 });
  e.ingest(ev('b', 'right', 'k', 'B', 5));
  e.ingest(ev('a', 'left', 'k', 'A', 2));
  e.ingest(ev('c', 'right', 'k2', 'C', 3));
  const frozen = e.snapshot();
  const frozenStats = e.stats();

  const blocked = e.ingest(ev('a2', 'left', 'k', 'A', 3));
  assert.equal(blocked.status, 'backpressure');
  assert.deepEqual(e.snapshot(), frozen);
  assert.equal(e.stats().records, frozenStats.records);

  // Progress advances: a finalises and the C/B history reclaims.
  e.advanceWatermark('left', 1000);
  e.advanceWatermark('right', 1000);
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a->b']);
  assert.ok(e.stats().records < 3, 'capacity freed after reclamation');
  // Now a new ingest fits again.
  assert.equal(e.ingest(ev('a3', 'left', 'k9', 'A', 1000)).status, 'accepted');
});
