/**
 * End-to-end fuzz: mixed interleaving of ingestion, watermark advancement,
 * duplicate re-delivery, and (intentionally) late events. Regardless of the
 * churn, once finalised the result must equal the complete-input oracle over the
 * accepted events. This exercises finalisation + reclamation + dedupe together.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import type { CorrelationEvent, CorrelationType } from '../src/types.ts';
import { ev, makeRng, matchKeys, shuffle } from './helpers.ts';

const SOURCES = ['a', 'b', 'c'];
const KEYS = ['x', 'y'];
const TYPES: CorrelationType[] = ['A', 'A', 'B', 'B', 'C'];

interface RunResult {
  final: string[];
  expected: string[];
}

function fuzzRun(seed: number): RunResult {
  const rng = makeRng(seed);
  const windowMs = 5;
  const engine = new CorrelationEngine({ sources: SOURCES, windowMs });

  const clock: Record<string, number> = { a: 0, b: 0, c: 0 };
  const accepted: CorrelationEvent[] = [];
  const acceptedById = new Map<string, CorrelationEvent>();
  const recentlySeen: CorrelationEvent[] = [];
  let seq = 0;

  const steps = 200;
  for (let i = 0; i < steps; i += 1) {
    const roll = rng();

    if (roll < 0.22) {
      const source = SOURCES[Math.floor(rng() * SOURCES.length)];
      clock[source] += Math.floor(rng() * 8);
      engine.advanceWatermark(source, clock[source]);
      continue;
    }

    if (roll < 0.34 && recentlySeen.length > 0) {
      // Re-deliver an already-accepted event: must be dedupe, never conflict.
      const prior = recentlySeen[Math.floor(rng() * recentlySeen.length)];
      const status = engine.ingest({ ...prior }).status;
      assert.ok(status === 'duplicate' || status === 'late', `re-delivery got ${status}`);
      continue;
    }

    const source = SOURCES[Math.floor(rng() * SOURCES.length)];
    const key = KEYS[Math.floor(rng() * KEYS.length)];
    const type = TYPES[Math.floor(rng() * TYPES.length)];
    // Slightly behind the clock sometimes, so some events are legitimately late.
    const time = Math.max(0, clock[source] - Math.floor(rng() * 3));
    seq += 1;
    const event = ev(`e${String(seq).padStart(5, '0')}`, source, key, type, time);

    const status = engine.ingest(event).status;
    if (status === 'accepted') {
      accepted.push(event);
      acceptedById.set(event.id, event);
      recentlySeen.push(event);
      if (recentlySeen.length > 30) recentlySeen.shift();
      if (time > clock[source]) clock[source] = time;
    } else {
      assert.equal(status, 'late', `unexpected ${status}`);
    }
  }

  engine.end();

  // Shuffle only affects display; the oracle sorts internally.
  const ref = referenceMatches(shuffle(accepted, rng), windowMs);
  return { final: matchKeys(engine.snapshot().final), expected: matchKeys(ref.matches) };
}

for (let seed = 1; seed <= 80; seed += 1) {
  test(`fuzz seed ${seed}: finalised == accepted-event oracle`, () => {
    const { final, expected } = fuzzRun(seed * 2654435761);
    assert.deepEqual(final, expected);
  });
}
