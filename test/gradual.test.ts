/**
 * Incremental vs. bulk finalisation must agree, and a finalised match must never
 * change afterwards, no matter how gradually the watermark advances. This guards
 * the "finalised results stay stable" property against partial-progress bugs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import type { CorrelationEvent } from '../src/types.ts';
import { ev, makeRng, matchKeys } from './helpers.ts';

const T = 6;
const SOURCES = ['s1', 's2'];

/** Build a legal two-source stream (per-source times non-decreasing). */
function stream(seed: number, n: number): CorrelationEvent[] {
  const rng = makeRng(seed);
  const clock: Record<string, number> = { s1: 0, s2: 0 };
  const out: CorrelationEvent[] = [];
  for (let i = 0; i < n; i += 1) {
    const source = SOURCES[Math.floor(rng() * SOURCES.length)];
    clock[source] += Math.floor(rng() * 3);
    const type = (['A', 'A', 'B', 'B', 'C'] as const)[Math.floor(rng() * 5)];
    out.push(ev(`e${i}`, source, rng() < 0.5 ? 'k1' : 'k2', type, clock[source]));
  }
  return out;
}

/** Deliver all events first, then advance watermarks gradually to the end. */
function gradualFinalise(events: CorrelationEvent[], step: number): string[] {
  const e = new CorrelationEngine({ sources: SOURCES, windowMs: T });
  for (const evt of events) {
    const s = e.ingest(evt).status;
    assert.ok(s === 'accepted' || s === 'late', s);
  }
  // Snapshots of the final set must be monotonically growing and never change
  // an already-final match.
  let lastFinal = new Map<string, string>();
  for (let progress = 0; progress <= 40; progress += step) {
    for (const source of SOURCES) e.advanceWatermark(source, progress);
    const current = new Map(e.snapshot().final.map((m) => [m.aId, m.bId]));
    for (const [aId, bId] of lastFinal) {
      assert.equal(current.get(aId), bId, `final match for ${aId} changed`);
    }
    lastFinal = current;
  }
  e.end();
  return matchKeys(e.snapshot().final);
}

test('gradual watermark advancement never revises a finalised match', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const events = stream(seed * 31, 50);
    const gradual = gradualFinalise(events, 1);

    // One-shot end() must agree.
    const e = new CorrelationEngine({ sources: SOURCES, windowMs: T });
    const accepted: CorrelationEvent[] = [];
    for (const evt of events) {
      if (e.ingest(evt).status === 'accepted') accepted.push(evt);
    }
    e.end();
    assert.deepEqual(matchKeys(e.snapshot().final), gradual);

    // And both agree with the complete-input oracle over accepted events.
    const expected = matchKeys(referenceMatches(accepted, T).matches);
    assert.deepEqual(gradual, expected);
  }
});
