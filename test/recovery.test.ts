/**
 * Crash-safety: the engine state can be exported to a plain snapshot and
 * restored, after which continued ingestion produces exactly the same final
 * result as an uninterrupted run. This models a process restart where the
 * durable snapshot is the recovery point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import type { CorrelationEvent } from '../src/types.ts';
import { ev, makeRng, matchKeys } from './helpers.ts';

test('restoring a snapshot yields the same final result as no crash', () => {
  const rng = makeRng(20261122);
  const sources = ['s1', 's2'];
  const windowMs = 8;

  // Build a legal stream.
  const events: CorrelationEvent[] = [];
  const clock: Record<string, number> = { s1: 0, s2: 0 };
  for (let i = 0; i < 60; i += 1) {
    const source = sources[Math.floor(rng() * sources.length)];
    clock[source] += Math.floor(rng() * 4);
    const type = (['A', 'B', 'C'] as const)[Math.floor(rng() * 3)];
    events.push(ev(`e${i}`, source, rng() < 0.5 ? 'k1' : 'k2', type, clock[source]));
  }

  const uninterrupted = new CorrelationEngine({ sources, windowMs });
  for (const e of events) uninterrupted.ingest(e);
  uninterrupted.end();

  const splitAt = 25;
  // Crash: run the first half, capture a portable snapshot of accepted events
  // and watermarks, then rebuild from scratch in a fresh engine.
  const throttled = new CorrelationEngine({ sources, windowMs });
  const acceptedFirstHalf: CorrelationEvent[] = [];
  for (const e of events.slice(0, splitAt)) {
    if (throttled.ingest(e).status === 'accepted') acceptedFirstHalf.push(e);
  }
  const watermarks = throttled.stats().watermarks;

  const recovered = new CorrelationEngine({ sources, windowMs });
  for (const [source, wm] of Object.entries(watermarks)) {
    if (Number.isFinite(wm)) recovered.advanceWatermark(source, wm);
  }
  for (const e of acceptedFirstHalf) {
    assert.equal(recovered.ingest(e).status, 'accepted');
  }
  for (const e of events.slice(splitAt)) {
    recovered.ingest(e);
  }
  recovered.end();

  assert.deepEqual(
    matchKeys(recovered.snapshot().final),
    matchKeys(uninterrupted.snapshot().final),
  );
});

test('double delivery of every event is idempotent (at-least-once transport)', () => {
  const rng = makeRng(777);
  const events: CorrelationEvent[] = [];
  for (let i = 0; i < 40; i += 1) {
    const type = (['A', 'B', 'C'] as const)[Math.floor(rng() * 3)];
    events.push(ev(`e${i}`, 's1', rng() < 0.5 ? 'k1' : 'k2', type, i));
  }
  const clean = new CorrelationEngine({ sources: ['s1'], windowMs: 6 });
  for (const e of events) clean.ingest(e);
  clean.end();

  const doubled = new CorrelationEngine({ sources: ['s1'], windowMs: 6 });
  for (const e of events) {
    doubled.ingest(e);
    assert.equal(doubled.ingest({ ...e }).status, 'duplicate');
  }
  doubled.end();

  assert.deepEqual(matchKeys(clean.snapshot().final), matchKeys(doubled.snapshot().final));
  // Both agree with the oracle over the de-duplicated input.
  assert.deepEqual(
    matchKeys(clean.snapshot().final),
    matchKeys(referenceMatches(events, 6).matches),
  );
});
