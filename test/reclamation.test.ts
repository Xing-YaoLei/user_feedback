/**
 * Reclamation must never drop an event that could still change a match.
 *
 * The safe horizon is `progress - T`: an unfinalised A has `a.time + T >=
 * progress`, so any B or C that could still matter has time >= progress - T.
 * These tests probe just inside and just outside that boundary. Events are
 * ingested while their source watermark still permits them, then watermarks
 * advance to move the horizon.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import { ev, matchKeys } from './helpers.ts';

test('a B exactly at the horizon is retained while its A is live', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 5 });
  e.ingest(ev('a', 'L', 'k', 'A', 5)); // deadline 10
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a->b']);

  // Progress 10 => horizon 5. Deadline 10 is not strictly past progress, so the
  // A stays live and the B sitting exactly on the horizon must be retained.
  e.advanceWatermark('L', 10);
  e.advanceWatermark('R', 10);
  assert.equal(e.stats().matchingHorizon, 5);
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a->b']);
  assert.equal(e.stats().activeEvents, 2);
});

test('a C below the horizon is reclaimed and cannot block a live A', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 5 });
  e.ingest(ev('c', 'R', 'k', 'C', 14));
  e.ingest(ev('a', 'L', 'k', 'A', 15)); // deadline 20
  e.ingest(ev('b', 'R', 'k', 'B', 16));
  // C at 14 precedes the A, so it does not block; a->b is provisional.
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a->b']);

  // Progress 20 => horizon 15. The A (deadline 20) is live; the C at 14 is below
  // the horizon and gets reclaimed, while the B at 16 is retained.
  e.advanceWatermark('L', 20);
  e.advanceWatermark('R', 20);
  assert.equal(e.stats().matchingHorizon, 15);
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a->b']);
  assert.equal(e.stats().activeEvents, 2); // only a and b remain
});

test('a late B reaches a live A once its source allows the event time', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  e.ingest(ev('a', 'L', 'k', 'A', 4)); // deadline 14
  assert.deepEqual(e.snapshot().provisional, []);

  // L far ahead, R only at 6: progress = 6 (runnable), A deadline 14 still live.
  e.advanceWatermark('L', 12);
  e.advanceWatermark('R', 6);
  assert.equal(e.globalProgress, 6);

  const b = e.ingest(ev('b', 'R', 'k', 'B', 6));
  assert.equal(b.status, 'accepted');
  assert.deepEqual(matchKeys(b.delta.added), ['k:a->b']);
  assert.deepEqual(matchKeys(e.snapshot().provisional), ['k:a->b']);

  e.end();
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a->b']);
  const ref = referenceMatches([ev('a', 'L', 'k', 'A', 4), ev('b', 'R', 'k', 'B', 6)], 10);
  assert.deepEqual(matchKeys(e.snapshot().final), matchKeys(ref.matches));
});

test('reclamation keeps the final result intact while freeing dedupe records', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  e.ingest(ev('a', 'L', 'k', 'A', 0));
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  e.end();
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a->b']);
  // Everything reclaimable has gone, but the finalised match remains visible.
  assert.equal(e.stats().records, 0);
  assert.equal(e.stats().activeEvents, 0);
  assert.equal(e.snapshot().final.length, 1);
});
