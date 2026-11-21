/**
 * Core value types for the correlation subscription module.
 *
 * An event is identified by a globally unique `id`. The `source` and the
 * immutable `time` are part of that identity: a re-delivery that keeps the same
 * id but changes the source, correlation key, type or time is a conflict rather
 * than a duplicate.
 */

/** Semantic role of an event inside a correlation key. */
export type CorrelationType = 'A' | 'B' | 'C';

/** Alias kept for readability where the value is described as a type name. */
export type EventTypeName = CorrelationType;

/** A single event fed into the engine. */
export interface CorrelationEvent {
  /** Globally unique event id. */
  id: string;
  /** Producing source. Must belong to the configured finite source set. */
  source: string;
  /** Correlation key: matching only ever happens inside one key. */
  key: string;
  /** Role of the event in the matching rule. */
  type: CorrelationType;
  /** Immutable event time (epoch-like number, must be finite). */
  time: number;
}

/**
 * A realised `A -> B` pairing.
 *
 * A match is the unit that provisional results add or retract. The times are
 * copied from the events so a match stays meaningful even after the raw events
 * have been reclaimed.
 */
export interface Match {
  key: string;
  aId: string;
  bId: string;
  aTime: number;
  bTime: number;
}

/** The whole set of retractions and additions produced by one step. */
export interface MatchDelta {
  retracted: Match[];
  added: Match[];
}

/** Empty delta helper (fresh object every time, callers may mutate). */
export function emptyDelta(): MatchDelta {
  return { retracted: [], added: [] };
}

export function isDeltaEmpty(delta: MatchDelta): boolean {
  return delta.retracted.length === 0 && delta.added.length === 0;
}

/** Deterministic sort used everywhere a match list is exposed. */
export function compareMatches(x: Match, y: Match): number {
  if (x.aTime !== y.aTime) return x.aTime - y.aTime;
  if (x.aId !== y.aId) return x.aId < y.aId ? -1 : 1;
  if (x.bTime !== y.bTime) return x.bTime - y.bTime;
  if (x.bId !== y.bId) return x.bId < y.bId ? -1 : 1;
  if (x.key !== y.key) return x.key < y.key ? -1 : 1;
  return 0;
}

export function sortMatches(matches: Match[]): Match[] {
  return [...matches].sort(compareMatches);
}

/** Canonical per-key event order: event time first, then id. */
export function compareEvents(x: CorrelationEvent, y: CorrelationEvent): number {
  if (x.time !== y.time) return x.time - y.time;
  if (x.id === y.id) return 0;
  return x.id < y.id ? -1 : 1;
}

/** Structural equality over everything that makes up an event's content. */
export function sameEventContent(x: CorrelationEvent, y: CorrelationEvent): boolean {
  return (
    x.id === y.id &&
    x.source === y.source &&
    x.key === y.key &&
    x.type === y.type &&
    x.time === y.time
  );
}
