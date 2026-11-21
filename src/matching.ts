/**
 * Pure, order-independent matching for one correlation key.
 *
 * The rule (stated once, implemented exactly here):
 *
 *   Within a single correlation key, sort every event by (time, id). Walk the
 *   A events in that order. Each A picks the earliest still-unused B whose time
 *   lies in the closed window [A.time, A.time + T], provided no C sits in the
 *   closed interval [A.time, B.time]. A and B are then both used, so neither can
 *   take part in a second match.
 *
 * Because the input is sorted and every tie is broken by id, the result depends
 * only on the *set* of events, never on the order in which they were delivered.
 * The engine reuses this exact function so provisional, final and reference
 * results all agree.
 */

import type { CorrelationEvent, Match } from './types.ts';
import { compareEvents } from './types.ts';

export interface KeyMatchResult {
  /** aId -> realised match. A-events with no eligible B are absent. */
  matches: Map<string, Match>;
  /** B ids consumed by some match. */
  usedB: Set<string>;
}

/** True when some C event time falls in the closed interval [a.time, b.time]. */
function isBlockedByC(a: CorrelationEvent, b: CorrelationEvent, cs: CorrelationEvent[]): boolean {
  for (const c of cs) {
    if (c.time >= a.time && c.time <= b.time) return true;
  }
  return false;
}

/**
 * Match a full set of same-key events. Pure: no I/O, no mutation of inputs.
 *
 * `seedUsedB` lets the engine reserve B events that a previously-finalised A
 * already consumed, so re-running over the retained subset reproduces the same
 * decision sequence as running over the complete history.
 */
export function matchKeyEvents(
  events: Iterable<CorrelationEvent>,
  windowMs: number,
  seedUsedB: Iterable<string> = [],
): KeyMatchResult {
  const all = [...events].sort(compareEvents);
  const as: CorrelationEvent[] = [];
  const bs: CorrelationEvent[] = [];
  const cs: CorrelationEvent[] = [];
  for (const e of all) {
    if (e.type === 'A') as.push(e);
    else if (e.type === 'B') bs.push(e);
    else cs.push(e);
  }

  const usedB = new Set<string>(seedUsedB);
  const matches = new Map<string, Match>();

  for (const a of as) {
    // `bs` is sorted by (time, id), so the first eligible B encountered is the
    // earliest available one; we can stop at it.
    let best: CorrelationEvent | null = null;
    for (const b of bs) {
      if (b.time < a.time) continue;
      if (b.time > a.time + windowMs) break;
      if (usedB.has(b.id)) continue;
      if (isBlockedByC(a, b, cs)) continue;
      best = b;
      break;
    }
    if (best !== null) {
      usedB.add(best.id);
      matches.set(a.id, {
        key: a.key,
        aId: a.id,
        bId: best.id,
        aTime: a.time,
        bTime: best.time,
      });
    }
  }

  return { matches, usedB };
}
