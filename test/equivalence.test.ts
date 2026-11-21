/**
 * Equivalence of the streaming engine's finalised results with the reference
 * oracle over the complete input, across randomised interleavings.
 *
 * This is the central correctness guarantee: whatever order events arrive in,
 * once every match is finalised the result must equal sorting all events by
 * (time, id) and applying the rule once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import type { CorrelationEvent, CorrelationType } from '../src/types.ts';
import { ev, makeRng, matchKeys, shuffle } from './helpers.ts';

const SOURCES = ['s1', 's2', 's3'];

/**
 * Generate a *legally deliverable* stream: every event's time is >= a slowly
 * advancing per-source watermark, so nothing is rejected as late. We emit the
 * events in a shuffled order but keep per-source times non-decreasing in
 * delivery order by construction (that is what a real source guarantees).
 */
function generateStream(rng: () => number, count: number): CorrelationEvent[] {
  const perSource: Record<string, number> = { s1: 0, s2: 0, s3: 0 };
  const keys = ['k1', 'k2', 'k3'];
  const types: CorrelationType[] = ['A', 'A', 'B', 'B', 'C'];
  const events: CorrelationEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const source = SOURCES[Math.floor(rng() * SOURCES.length)];
    const key = keys[Math.floor(rng() * keys.length)];
    const type = types[Math.floor(rng() * types.length)];
    // Per-source event time strictly advances: this keeps delivery legal.
    perSource[source] += Math.floor(rng() * 4);
    events.push(ev(`e${String(i).padStart(3, '0')}`, source, key, type, perSource[source]));
  }
  return events;
}

/** Deliver events respecting per-source time order, but interleaving sources freely. */
function interleave(events: CorrelationEvent[], rng: () => number): CorrelationEvent[] {
  const queues = new Map<string, CorrelationEvent[]>();
  for (const source of SOURCES) queues.set(source, []);
  for (const e of events) queues.get(e.source)!.push(e);
  for (const q of queues.values()) q.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));

  const out: CorrelationEvent[] = [];
  let remaining = events.length;
  while (remaining > 0) {
    const available = SOURCES.filter((s) => queues.get(s)!.length > 0);
    const source = available[Math.floor(rng() * available.length)];
    out.push(queues.get(source)!.shift()!);
    remaining -= 1;
  }
  return out;
}

for (let seed = 1; seed <= 40; seed += 1) {
  test(`finalised result equals reference oracle (seed ${seed})`, () => {
    const rng = makeRng(seed * 7919);
    const windowMs = 6;
    const events = interleave(generateStream(rng, 40), rng);

    const engine = new CorrelationEngine({ sources: SOURCES, windowMs });
    for (const event of events) {
      const status = engine.ingest(event).status;
      assert.ok(
        status === 'accepted' || status === 'late',
        `unexpected status ${status} for ${event.id}`,
      );
    }
    engine.end();

    const expected = referenceMatches(events, windowMs);
    const snapshot = engine.snapshot();
    assert.deepEqual(snapshot.provisional, [], 'nothing provisional after end()');
    assert.deepEqual(matchKeys(snapshot.final), matchKeys(expected.matches));
  });
}

test('randomised shuffles of the same set give identical final results', () => {
  const rng = makeRng(424242);
  const events = generateStream(rng, 50);
  // All in one source so any permutation is legal delivery order.
  const single = events.map((e) => ({ ...e, source: 's1' }));
  const expected = referenceMatches(single, 8);

  for (let trial = 0; trial < 10; trial += 1) {
    const engine = new CorrelationEngine({ sources: ['s1'], windowMs: 8 });
    for (const event of shuffle(single, rng)) {
      assert.equal(engine.ingest(event).status, 'accepted');
    }
    engine.end();
    assert.deepEqual(matchKeys(engine.snapshot().final), matchKeys(expected.matches));
  }
});
