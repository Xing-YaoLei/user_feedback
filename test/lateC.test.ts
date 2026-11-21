/**
 * A C that arrives after an A finalised cannot rewrite that A, but it must
 * still be considered for *later* unfinalised As whose windows it falls into.
 * The reference oracle is the arbiter.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import { ev, matchKeys } from './helpers.ts';

test('late C after a finalisation affects later As but not the frozen one', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });

  // A1 will finalise first.
  e.ingest(ev('a1', 'L', 'k', 'A', 0)); // deadline 10
  e.ingest(ev('b1', 'R', 'k', 'B', 2));
  // A2 is later and blocked only by a future C.
  e.ingest(ev('a2', 'L', 'k', 'A', 12)); // deadline 22
  e.ingest(ev('b2', 'R', 'k', 'B', 15));

  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a1->b1', 'k:a2->b2']);

  // Progress 11: a1 finalises, a2 remains provisional.
  e.advanceWatermark('L', 11);
  e.advanceWatermark('R', 11);
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b1']);
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a2->b2']);

  // A C at time 13 lands in [a2.time=12, b2.time=15]. It cannot touch a1 (frozen)
  // but must invalidate a2's match.
  const c = e.ingest(ev('c', 'R', 'k', 'C', 13));
  assert.equal(c.status, 'accepted');
  assert.deepEqual(matchKeys(c.delta.retracted), ['k:a2->b2']);
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b1']);
  assert.deepEqual(e.snapshot().provisional, []);

  e.end();
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b1']);

  // Oracle agreement.
  const ref = referenceMatches(
    [
      ev('a1', 'L', 'k', 'A', 0),
      ev('b1', 'R', 'k', 'B', 2),
      ev('a2', 'L', 'k', 'A', 12),
      ev('b2', 'R', 'k', 'B', 15),
      ev('c', 'R', 'k', 'C', 13),
    ],
    10,
  );
  assert.deepEqual(matchKeys(e.snapshot().final), matchKeys(ref.matches));
});

test('a B that was reserved by a finalised A is never handed to a later A', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  e.ingest(ev('a1', 'L', 'k', 'A', 0));
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  e.advanceWatermark('L', 11);
  e.advanceWatermark('R', 11); // a1 final, b reserved
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b']);

  // a2 could use b by time, but b is consumed by the finalised a1.
  e.ingest(ev('a2', 'L', 'k', 'A', 6)); // 6 + 10 = 16 >= 5, in window
  assert.deepEqual(e.snapshot().provisional, []);
  e.end();
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b']);

  const ref = referenceMatches(
    [ev('a1', 'L', 'k', 'A', 0), ev('b', 'R', 'k', 'B', 5), ev('a2', 'L', 'k', 'A', 6)],
    10,
  );
  assert.deepEqual(matchKeys(e.snapshot().final), matchKeys(ref.matches));
});
