/**
 * Reference implementation used to validate the streaming engine.
 *
 * It ignores watermarks, dedupe, reclamation and backpressure entirely: it
 * simply sorts a complete event list by (time, id) and applies the matching rule
 * once per key. The engine's *finalised* results must equal this oracle's
 * output, which is the core correctness property of the module.
 */

import type { CorrelationEvent, Match } from './types.ts';
import { sortMatches } from './types.ts';
import { matchKeyEvents } from './matching.ts';

export interface ReferenceResult {
  matches: Match[];
  /** A ids that remain unmatched in the complete input. */
  unmatchedA: string[];
}

export function referenceMatches(
  events: Iterable<CorrelationEvent>,
  windowMs: number,
): ReferenceResult {
  const byKey = new Map<string, CorrelationEvent[]>();
  for (const event of events) {
    const list = byKey.get(event.key);
    if (list === undefined) byKey.set(event.key, [event]);
    else list.push(event);
  }

  const matches: Match[] = [];
  const matchedA = new Set<string>();
  for (const list of byKey.values()) {
    const { matches: keyMatches } = matchKeyEvents(list, windowMs);
    for (const [aId, match] of keyMatches) {
      matchedA.add(aId);
      matches.push(match);
    }
  }

  const unmatchedA: string[] = [];
  for (const event of events) {
    if (event.type === 'A' && !matchedA.has(event.id)) unmatchedA.push(event.id);
  }

  return { matches: sortMatches(matches), unmatchedA: unmatchedA.sort() };
}
