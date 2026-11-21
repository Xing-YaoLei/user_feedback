import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { ev, matchKeys } from './helpers.ts';

function engine(windowMs = 10, sources = ['L', 'R']): CorrelationEngine {
  return new CorrelationEngine({ sources, windowMs });
}

test('provisional delta adds on arrival and retracts on a better earlier A', () => {
  const e = engine();
  e.ingest(ev('b1', 'R', 'k', 'B', 5));
  const a2 = e.ingest(ev('a2', 'L', 'k', 'A', 4));
  assert.deepEqual(matchKeys(a2.delta.added), ['k:a2->b1']);

  // A later-delivered but earlier-time A takes the B; a2 must be retracted.
  const a1 = e.ingest(ev('a1', 'L', 'k', 'A', 2));
  assert.deepEqual(matchKeys(a1.delta.retracted), ['k:a2->b1']);
  assert.deepEqual(matchKeys(a1.delta.added), ['k:a1->b1']);
  assert.deepEqual(e.snapshot().all.map((m) => m.aId), ['a1']);
});

test('a late C retracts an existing provisional match', () => {
  const e = engine();
  e.ingest(ev('b', 'R', 'k', 'B', 8));
  e.ingest(ev('a', 'L', 'k', 'A', 0));
  assert.deepEqual(matchKeys(e.snapshot().all), ['k:a->b']);

  const c = e.ingest(ev('c', 'R', 'k', 'C', 4));
  assert.deepEqual(matchKeys(c.delta.retracted), ['k:a->b']);
  assert.deepEqual(c.delta.added, []);
  assert.deepEqual(e.snapshot().all, []);
});

test('a late earlier A may steal an already matched B, but only within window', () => {
  const e = engine(10);
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  e.ingest(ev('a2', 'L', 'k', 'A', 4));
  // a1 within window of b and earlier -> steals it.
  e.ingest(ev('a1', 'L', 'k', 'A', 1));
  assert.deepEqual(matchKeys(e.snapshot().all), ['k:a1->b']);

  // a0 is farther than the window from b -> cannot take it, a1 stays.
  e.ingest(ev('a0', 'L', 'k', 'A', -10));
  assert.deepEqual(matchKeys(e.snapshot().all), ['k:a1->b']);
});

test('events at or below the source watermark are rejected as late', () => {
  const e = engine();
  e.advanceWatermark('L', 5);
  e.advanceWatermark('R', 5);

  const below = e.ingest(ev('x', 'L', 'k', 'A', 4));
  assert.equal(below.status, 'late');
  assert.deepEqual(below.delta, { retracted: [], added: [] });

  // Equal to the watermark is allowed (watermark is a lower bound, not a cut).
  const equal = e.ingest(ev('y', 'L', 'k', 'A', 5));
  assert.equal(equal.status, 'accepted');
});

test('unknown source is rejected', () => {
  const e = engine();
  const r = e.ingest(ev('x', 'Z', 'k', 'A', 1));
  assert.equal(r.status, 'unknown-source');
});

test('duplicate id with identical content is ignored without delta', () => {
  const e = engine();
  const first = e.ingest(ev('b', 'R', 'k', 'B', 5));
  const again = e.ingest(ev('b', 'R', 'k', 'B', 5));
  assert.equal(first.status, 'accepted');
  assert.equal(again.status, 'duplicate');
  assert.deepEqual(again.delta, { retracted: [], added: [] });
});

test('same id with different source/time/type is a conflict', () => {
  const e = engine();
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  assert.equal(e.ingest(ev('b', 'L', 'k', 'B', 5)).status, 'conflict'); // source differs
  assert.equal(e.ingest(ev('b', 'R', 'k', 'B', 6)).status, 'conflict'); // time differs
  assert.equal(e.ingest(ev('b', 'R', 'k', 'A', 5)).status, 'conflict'); // type differs
  assert.equal(e.ingest(ev('b', 'R', 'k2', 'B', 5)).status, 'conflict'); // key differs
});

test('advancing one watermark below global min does not progress', () => {
  const e = engine();
  e.advanceWatermark('L', 100);
  assert.equal(e.globalProgress, Number.NEGATIVE_INFINITY); // R still unset
  e.advanceWatermark('R', 7);
  assert.equal(e.globalProgress, 7); // min(100, 7)
});

test('finalisation happens once progress passes A.time + T and is stable', () => {
  const e = engine(10);
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  e.ingest(ev('a', 'L', 'k', 'A', 2)); // deadline 12

  e.advanceWatermark('L', 12);
  e.advanceWatermark('R', 12); // progress 12: not yet strictly past 12
  assert.equal(e.snapshot().final.length, 0);

  const wm = e.advanceWatermark('R', 13);
  assert.equal(wm.progress, 12); // L caps progress at 12
  assert.equal(e.snapshot().final.length, 0);

  const wm2 = e.advanceWatermark('L', 13); // progress now 13 > 12
  assert.equal(wm2.progress, 13);
  assert.deepEqual(matchKeys(wm2.finalized), ['k:a->b']);
  assert.equal(e.snapshot().final.length, 1);
  assert.equal(e.snapshot().provisional.length, 0);
});

test('retracted-by-C final result: a late C before finalisation changes it, after it cannot', () => {
  const e = engine(10);
  e.ingest(ev('b', 'R', 'k', 'B', 5));
  e.ingest(ev('a', 'L', 'k', 'A', 2));
  e.end();
  assert.equal(e.snapshot().final.length, 1);

  // After finalisation the A is settled; a late C is still stored but the
  // final result is frozen.
  e.ingest(ev('c', 'R', 'k', 'C', 3));
  assert.deepEqual(matchKeys(e.snapshot().final), ['k:a->b']);
});

test('backpressure rejects without mutating state, watermarks still finalise', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10, maxRecords: 2 });
  assert.equal(e.ingest(ev('b1', 'R', 'k', 'B', 50)).status, 'accepted');
  assert.equal(e.ingest(ev('a1', 'L', 'k', 'A', 45)).status, 'accepted');
  const before = e.snapshot();

  const rejected = e.ingest(ev('a2', 'L', 'k', 'A', 46));
  assert.equal(rejected.status, 'backpressure');
  assert.deepEqual(rejected.delta, { retracted: [], added: [] });
  assert.deepEqual(e.snapshot(), before);

  // Watermark movement still finalises and reclaims despite backpressure.
  e.advanceWatermark('L', 1000);
  e.advanceWatermark('R', 1000);
  assert.equal(e.snapshot().final.length, 1);
  assert.ok(e.stats().records < 2, 'history reclaimed after finalisation');
});

test('duplicate ingest at capacity is dedupe, not backpressure', () => {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10, maxRecords: 1 });
  e.ingest(ev('a', 'L', 'k', 'A', 0));
  assert.equal(e.ingest(ev('a', 'L', 'k', 'A', 0)).status, 'duplicate');
  assert.equal(e.ingest(ev('b', 'L', 'k', 'B', 0)).status, 'backpressure');
});

test('invalid events are rejected without touching state', () => {
  const e = engine();
  // @ts-expect-error deliberately malformed
  assert.equal(e.ingest({ id: '', source: 'L', key: 'k', type: 'A', time: 1 }).status, 'invalid');
  assert.equal(e.ingest(ev('x', 'L', 'k', 'A', Number.NaN)).status, 'invalid');
  // @ts-expect-error deliberately malformed
  assert.equal(e.ingest({ id: 'x', source: 'L', key: 'k', type: 'Q', time: 1 }).status, 'invalid');
});

test('constructor validates its options', () => {
  assert.throws(() => new CorrelationEngine({ sources: ['L', 'L'], windowMs: 1 }));
  assert.throws(() => new CorrelationEngine({ sources: ['L'], windowMs: -1 }));
  assert.throws(() => new CorrelationEngine({ sources: ['L'], windowMs: 1, maxRecords: -5 }));
});

test('stale and unknown-source watermark updates are reported', () => {
  const e = engine();
  e.advanceWatermark('L', 10);
  assert.equal(e.advanceWatermark('L', 5).status, 'stale');
  assert.equal(e.advanceWatermark('Nope', 5).status, 'unknown-source');
});
