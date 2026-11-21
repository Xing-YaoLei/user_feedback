/**
 * A subtlety worth pinning down: finalising an earlier A must not disturb the
 * provisional matches of *later* As. Because the greedy rule processes As in
 * (time, id) order and finalisation frees exactly the B that the earlier A
 * already owned, the later choices are unchanged. These tests exercise dense
 * competition for a small B pool across a watermark boundary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import { ev, matchKeys } from './helpers.ts';

test('finalising an earlier A does not reshuffle later provisional matches', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  // Three As compete for two Bs.
  e.ingest(ev('b1', 'R', 'k', 'B', 3));
  e.ingest(ev('b2', 'R', 'k', 'B', 4));
  e.ingest(ev('a1', 'L', 'k', 'A', 0));
  e.ingest(ev('a2', 'L', 'k', 'A', 1));
  e.ingest(ev('a3', 'L', 'k', 'A', 2));

  const provisionalBefore = matchKeys(e.snapshot().provisional);
  assert.deepEqual(provisionalBefore, ['k:a1->b1', 'k:a2->b2']);

  // Progress 11 > a1 deadline (10): a1 finalises, a2/a3 provisional.
  e.advanceWatermark('L', 11);
  e.advanceWatermark('R', 11);
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b1']);
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a2->b2']);

  // Progress 12 > a2 deadline (11): a2 finalises; a3 remains unmatched.
  e.advanceWatermark('L', 12);
  e.advanceWatermark('R', 12);
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a1->b1', 'k:a2->b2']);
  assert.deepEqual(e.snapshot().provisional, []);

  e.end();
  const ref = referenceMatches(
    [
      ev('b1', 'R', 'k', 'B', 3),
      ev('b2', 'R', 'k', 'B', 4),
      ev('a1', 'L', 'k', 'A', 0),
      ev('a2', 'L', 'k', 'A', 1),
      ev('a3', 'L', 'k', 'A', 2),
    ],
    10,
  );
  assert.deepEqual(matchKeys(e.snapshot().final), matchKeys(ref.matches));
});

test('a B freed by an unmatched finalised A becomes available to a later A', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  // a1 is blocked by a C, so it takes nothing; its B stays free for a2.
  e.ingest(ev('c', 'R', 'k', 'C', 1));
  e.ingest(ev('b', 'R', 'k', 'B', 2));
  e.ingest(ev('a1', 'L', 'k', 'A', 0)); // blocked by c in [0,2]
  e.ingest(ev('a2', 'L', 'k', 'A', 0)); // same deadline, but a1 uses nothing

  // Both As are blocked (C sits in [0,2]).
  assert.deepEqual(e.snapshot().provisional, []);

  // With the C present the reference agrees.
  const ref = referenceMatches(
    [
      ev('c', 'R', 'k', 'C', 1),
      ev('b', 'R', 'k', 'B', 2),
      ev('a1', 'L', 'k', 'A', 0),
      ev('a2', 'L', 'k', 'A', 0),
    ],
    10,
  );
  e.end();
  assert.deepEqual(matchKeys(e.snapshot().final), matchKeys(ref.matches));
  assert.deepEqual(e.snapshot().final, []);
});

test('same-time A tie uses id order even across finalisation', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  // Arrive out of id order; ids decide the tie at time 3.
  e.ingest(ev('a-z', 'L', 'k', 'A', 3));
  e.ingest(ev('a-a', 'L', 'k', 'A', 3));
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a-a->b']);

  e.end();
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a-a->b']);
  const ref = referenceMatches(
    [ev('b', 'R', 'k', 'B', 5), ev('a-z', 'L', 'k', 'A', 3), ev('a-a', 'L', 'k', 'A', 3)],
    10,
  );
  assert.deepEqual(matchKeys(e.snapshot().final), matchKeys(ref.matches));
});
