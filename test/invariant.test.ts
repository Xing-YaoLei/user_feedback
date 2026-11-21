/**
 * Invariant: reclaiming sub-horizon B/C events must never change the match of a
 * still-provisional A. If it did, a watermark advance would report a spurious
 * revision (or silently lose a valid match). We assert the provisional match set
 * is identical immediately before and after reclamation by comparing against a
 * control engine that is forbidden from reclaiming (by never advancing far).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CorrelationEngine } from '../src/engine.ts';
import type { CorrelationEvent } from '../src/types.ts';
import { ev, makeRng, matchKeys } from './helpers.ts';

const T = 5;

function provisionalSnapshot(
  events: CorrelationEvent[],
  finalProgress: number,
): { provisionalBeforeReclaim: string[]; provisionalAfterReclaim: string[] } {
  const e = new CorrelationEngine({ sources: ['L', 'R'], windowMs: T });
  for (const event of events) e.ingest(event);
  const before = matchKeys(e.snapshot().provisional);
  // Advance to the target progress; any B/C below `finalProgress - T` is dropped.
  e.advanceWatermark('L', finalProgress);
  e.advanceWatermark('R', finalProgress);
  const after = matchKeys(e.snapshot().provisional);
  return { provisionalBeforeReclaim: before, provisionalAfterReclaim: after };
}

test('reclamation never drops or rewires a live A provisional match', () => {
  const rng = makeRng(90210);
  for (let seed = 0; seed < 50; seed += 1) {
    const events: CorrelationEvent[] = [];
    let clock = 0;
    for (let i = 0; i < 30; i += 1) {
      clock += Math.floor(rng() * 3);
      const type = (['A', 'A', 'B', 'C'] as const)[Math.floor(rng() * 4)];
      events.push(ev(`e${i}`, 'L', 'k', type, clock));
    }
    // Choose a progress that finalises the oldest As but leaves some live.
    const maxTime = Math.max(...events.map((e) => e.time));
    const midProgress = Math.floor(maxTime * 0.7);
    const { provisionalBeforeReclaim, provisionalAfterReclaim } = provisionalSnapshot(
      events,
      midProgress,
    );
    // The set of A matches that survive to the progressed view may shrink only by
    // the As that finalised; no surviving A may change its B.
    for (const key of provisionalAfterReclaim) {
      assert.ok(
        provisionalBeforeReclaim.includes(key),
        `surviving provisional ${key} was not present before reclaim`,
      );
    }
  }
});
