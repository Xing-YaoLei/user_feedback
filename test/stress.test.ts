/**
 * Stress test: watermarks advanced *during* the stream, so finalisation and
 * reclamation interleave with live ingestion. Rejected-late events must not
 * appear in the oracle. At the end the finalised results must equal applying
 * the rule (sorted by time then id) to exactly the accepted events.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import { referenceMatches } from '../src/reference.ts';
import type { CorrelationEvent, CorrelationType } from '../src/types.ts';
import { ev, makeRng, matchKeys } from './helpers.ts';

const SOURCES = ['s1', 's2', 's3'];
const KEYS = ['k1', 'k2'];
const TYPES: CorrelationType[] = ['A', 'A', 'B', 'B', 'C'];

interface Accepted {
  event: CorrelationEvent;
}

function run(seed: number): { finalKeys: string[]; expected: string[]; accepted: Accepted[] } {
  const rng = makeRng(seed);
  const windowMs = 7;
  const engine = new CorrelationEngine({ sources: SOURCES, windowMs });

  // Per-source clock: the last event time *promised* to be delivered.
  const clock: Record<string, number> = { s1: 0, s2: 0, s3: 0 };
  const accepted: Accepted[] = [];
  let seq = 0;

  const steps = 120;
  for (let i = 0; i < steps; i += 1) {
    const roll = rng();

    if (roll < 0.18) {
      // Advance one source watermark, possibly jumping ahead (creating lateness).
      const source = SOURCES[Math.floor(rng() * SOURCES.length)];
      const current = clock[source];
      const jump = Math.floor(rng() * 12);
      const next = current + jump;
      clock[source] = Math.max(clock[source], next);
      engine.advanceWatermark(source, clock[source]);
      continue;
    }

    const source = SOURCES[Math.floor(rng() * SOURCES.length)];
    const key = KEYS[Math.floor(rng() * KEYS.length)];
    const type = TYPES[Math.floor(rng() * TYPES.length)];
    // Problem times are current-clock or slightly behind (late) or ahead.
    const delta = Math.floor(rng() * 5) - 2;
    const time = cord(clock[source] + delta);
    seq += 1;
    const event = ev(`e${String(seq).padStart(4, '0')}`, source, key, type, time);

    const status = engine.ingest(event).status;
    if (status === 'accepted') {
      accepted.push({ event });
      // Advance the delivered clock forward only for legal (non-late) events.
      if (time > clock[source]) clock[source] = time;
    } else {
      assert.ok(
        status === 'late' || status === 'duplicate',
        `unexpected status ${status}`,
      );
    }
  }

  engine.end();
  const expected = referenceMatches(accepted.map((a) => a.event), windowMs);
  return {
    finalKeys: matchKeys(engine.snapshot().final),
    expected: matchKeys(expected.matches),
    accepted,
  };
}

/** Keep times non-negative for tidiness; the rule is translation invariant. */
function cord(t: number): number {
  return Math.max(0, t);
}

for (let seed = 1; seed <= 60; seed += 1) {
  test(`live-watermark stream finalises to the accepted-event oracle (seed ${seed})`, () => {
    const { finalKeys, expected } = run(seed * 104729);
    assert.deepEqual(finalKeys, expected);
  });
}

test('a late earlier A is accepted before its deadline, rejected after it', () => {
  const engine = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  // Build a match a_late will want to steal.
  engine.ingest(ev('b', 'R', 'k', 'B', 6));
  engine.ingest(ev('a9', 'L', 'k', 'A', 5));

  // Global progress still at -Infinity, deadline of a1 (1+10=11) in the future:
  // the earlier A is accepted and steals the B.
  const accepted = engine.ingest(ev('a1', 'L', 'k', 'A', 1));
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(matchKeys(engine.snapshot().all), ['k:a1->b']);

  // Advance both sources so progress is 11 (== a1 deadline, not past) -> still
  // provisional and a second earlier A at time 1 is still acceptable.
  engine.advanceWatermark('L', 11);
  engine.advanceWatermark('R', 11);
  assert.equal(engine.snapshot().final.length, 0);

  // Progress 19 leaves a1's deadline (11) far behind: a1 is final. An event at
  // time 1 is now below its source watermark and must be rejected as late.
  engine.advanceWatermark('L', 19);
  engine.advanceWatermark('R', 19); // progress 19 > deadline 11
  const lateA = engine.ingest(ev('a0', 'L', 'k', 'A', 1));
  assert.equal(lateA.status, 'late');
  assert.deepEqual(matchKeys(engine.snapshot().final), ['k:a1->b']);
});

test('provisional revision is visible before finalisation, frozen after', () => {
  const engine = new CorrelationEngine({ sources: ['L', 'R'], windowMs: 10 });
  engine.ingest(ev('b', 'R', 'k', 'B', 6));
  engine.ingest(ev('a9', 'L', 'k', 'A', 5));
  const before = matchKeys(engine.snapshot().provisional);
  assert.deepEqual(before, ['k:a9->b']);

  engine.ingest(ev('a1', 'L', 'k', 'A', 1));
  assert.deepEqual(matchKeys(engine.snapshot().provisional), ['k:a1->b']);
  assert.deepEqual(engine.snapshot().final, []);

  engine.end();
  // After end(), the provisional view is empty; the frozen final is a1->b.
  assert.deepEqual(engine.snapshot().provisional, []);
  assert.deepEqual(matchKeys(engine.snapshot().final), ['k:a1->b']);
});
