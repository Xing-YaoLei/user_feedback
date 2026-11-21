/**
 * Stateful correlation engine.
 *
 * Responsibilities layered on top of the pure matcher in `matching.ts`:
 *
 *  - source watermarks and global progress (min over sources),
 *  - rejection of events older than their source watermark,
 *  - duplicate/conflict handling by event id,
 *  - provisional match deltas after every accepted event,
 *  - finalisation once global progress passes an A's full matching deadline,
 *  - reclamation of history and backpressure at a configurable capacity.
 *
 * The engine keeps the working set small; finalised matches are immutable
 * results and are never recomputed.
 */

import type {
  CorrelationEvent,
  CorrelationType,
  Match,
  MatchDelta,
} from './types.ts';
import { compareEvents, emptyDelta, sameEventContent, sortMatches } from './types.ts';
import { matchKeyEvents } from './matching.ts';

export interface EngineOptions {
  /** Finite set of legal sources. Watermarks exist for every source. */
  sources: readonly string[];
  /** Matching window T (event-time units). Must be finite and >= 0. */
  windowMs: number;
  /**
   * Maximum number of retained working records (active events, reserved B
   * slots and dedupe entries; finalised results are not counted). Defaults to
   * Infinity. When an ingest would exceed it the engine returns backpressure
   * and leaves all state untouched.
   */
  maxRecords?: number;
}

export type IngestStatus =
  | 'accepted'
  | 'duplicate'
  | 'conflict'
  | 'late'
  | 'unknown-source'
  | 'invalid'
  | 'backpressure';

export interface IngestResult {
  status: IngestStatus;
  id: string;
  /** Changes to the current match result set caused by this event. */
  delta: MatchDelta;
  /** Extra human readable context for non-accepted statuses. */
  reason?: string;
}

export interface WatermarkResult {
  status: 'applied' | 'stale' | 'unknown-source' | 'invalid';
  source: string;
  /** Global progress after the update (min across sources). */
  progress: number;
  /** Matches whose outcome became immutable because of this update. */
  finalized: Match[];
  /** Changes to the current match result set (finalisation keeps a match). */
  delta: MatchDelta;
  /** Records dropped by reclamation. */
  reclaimed: number;
}

export interface Snapshot {
  /** Matches whose A is not yet finalised and may still be revised. */
  provisional: Match[];
  /** Matches whose A is finalised; stable until the end of the stream. */
  final: Match[];
  /** Union of provisional and final, sorted. */
  all: Match[];
}

export interface Stats {
  sources: string[];
  watermarks: Record<string, number>;
  progress: number;
  /**
   * Times strictly below this boundary are guaranteed not to take part in any
   * future match decision (progress - windowMs). Together with per-source
   * watermarks this is the reclamation boundary.
   */
  matchingHorizon: number;
  /** Distinct retained working records (dedupe entries / active / reserved). */
  records: number;
  maxRecords: number;
  activeEvents: number;
  reservedB: number;
  provisionalMatches: number;
  finalMatches: number;
  reclaimedTotal: number;
}

interface KeyState {
  /** Active (not yet finalised, not yet reclaimed) events for this key. */
  events: Map<string, CorrelationEvent>;
  /** B ids consumed by finalised matches: bId -> bTime. */
  reservedB: Map<string, number>;
}

/** aId -> bId projection used to diff result sets. */
type MatchIndex = Map<string, Match>;

/** Added/retracted matches between two `aId -> match` views. */
function diffIndexes(before: MatchIndex, after: MatchIndex): MatchDelta {
  const retracted: Match[] = [];
  const added: Match[] = [];
  for (const [aId, m] of before) {
    const next = after.get(aId);
    if (next === undefined || next.bId !== m.bId) retracted.push(m);
  }
  for (const [aId, m] of after) {
    const prev = before.get(aId);
    if (prev === undefined || prev.bId !== m.bId) added.push(m);
  }
  return { retracted: sortMatches(retracted), added: sortMatches(added) };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Watermarks may be any finite number; +Infinity means "stream ended". */
function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value) && value !== Number.NEGATIVE_INFINITY;
}

const VALID_TYPES: readonly CorrelationType[] = ['A', 'B', 'C'];

export class CorrelationEngine {
  private readonly sources: string[];
  private readonly windowMs: number;
  private readonly maxRecords: number;

  private readonly watermarks: Map<string, number>;
  private progress = Number.NEGATIVE_INFINITY;

  /** Dedupe / retention records: every accepted event id we still remember. */
  private readonly seen = new Map<string, CorrelationEvent>();
  private readonly keys = new Map<string, KeyState>();

  /** Provisional match index (A not finalised). */
  private provisional: MatchIndex = new Map();
  /** Finalised matches by A id. */
  private finalByA: MatchIndex = new Map();

  private reclaimedTotal = 0;

  constructor(options: EngineOptions) {
    if (options === null || typeof options !== 'object') {
      throw new Error('CorrelationEngine: options object is required');
    }
    if (!Array.isArray(options.sources)) {
      throw new Error('CorrelationEngine: sources must be an array');
    }
    const sources = [...options.sources];
    if (new Set(sources).size !== sources.length) {
      throw new Error('CorrelationEngine: sources must be unique');
    }
    if (!isFiniteNumber(options.windowMs) || options.windowMs < 0) {
      throw new Error('CorrelationEngine: windowMs must be a finite number >= 0');
    }
    const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
    if (!isFiniteNumber(maxRecords) && maxRecords !== Number.POSITIVE_INFINITY) {
      throw new Error('CorrelationEngine: maxRecords must be a finite number');
    }
    if (isFiniteNumber(maxRecords) && maxRecords < 0) {
      throw new Error('CorrelationEngine: maxRecords must be >= 0');
    }

    this.sources = sources;
    this.windowMs = options.windowMs;
    this.maxRecords = maxRecords;
    this.watermarks = new Map(sources.map((s) => [s, Number.NEGATIVE_INFINITY]));
    this.progress = this.computeProgress();
  }

  // ---------------------------------------------------------------- ingest

  ingest(input: CorrelationEvent): IngestResult {
    const id = typeof (input as { id?: unknown })?.id === 'string' ? input.id : '';
    const shaped = this.validateShape(input);
    if (shaped !== null) {
      return { status: 'invalid', id, delta: emptyDelta(), reason: shaped };
    }
    const event = input;

    if (!this.watermarks.has(event.source)) {
      return {
        status: 'unknown-source',
        id: event.id,
        delta: emptyDelta(),
        reason: `source "${event.source}" is not in the configured source set`,
      };
    }

    const watermark = this.watermarks.get(event.source)!;
    if (event.time < watermark) {
      return {
        status: 'late',
        id: event.id,
        delta: emptyDelta(),
        reason: `time ${event.time} is earlier than source watermark ${watermark}`,
      };
    }

    const prior = this.seen.get(event.id);
    if (prior !== undefined) {
      if (sameEventContent(prior, event)) {
        return { status: 'duplicate', id: event.id, delta: emptyDelta() };
      }
      return {
        status: 'conflict',
        id: event.id,
        delta: emptyDelta(),
        reason: 'event id already recorded with different content',
      };
    }

    // New id: it would add exactly one working record.
    if (this.seen.size >= this.maxRecords) {
      return {
        status: 'backpressure',
        id: event.id,
        delta: emptyDelta(),
        reason: `state capacity ${this.maxRecords} reached`,
      };
    }

    // Accept.
    const before = this.indexForKey(event.key);
    this.seen.set(event.id, { ...event });
    const state = this.keyState(event.key);
    state.events.set(event.id, { ...event });
    this.recomputeKey(event.key);
    const after = this.indexForKey(event.key);

    return {
      status: 'accepted',
      id: event.id,
      delta: diffIndexes(before, after),
    };
  }

  // ------------------------------------------------------------- watermarks

  advanceWatermark(source: string, watermark: number): WatermarkResult {
    if (!this.watermarks.has(source)) {
      return {
        status: 'unknown-source',
        source,
        progress: this.progress,
        finalized: [],
        delta: emptyDelta(),
        reclaimed: 0,
      };
    }
    if (!isWatermark(watermark)) {
      return {
        status: 'invalid',
        source,
        progress: this.progress,
        finalized: [],
        delta: emptyDelta(),
        reclaimed: 0,
      };
    }
    const current = this.watermarks.get(source)!;
    if (watermark < current) {
      // Watermarks are monotonic by contract; ignore regressions safely.
      return {
        status: 'stale',
        source,
        progress: this.progress,
        finalized: [],
        delta: emptyDelta(),
        reclaimed: 0,
      };
    }

    const before = this.unionIndex();
    this.watermarks.set(source, watermark);
    this.progress = this.computeProgress();

    const finalized = this.finalizeReady();
    const reclaimed = this.reclaim();
    const after = this.unionIndex();

    return {
      status: 'applied',
      source,
      progress: this.progress,
      finalized: sortMatches(finalized),
      delta: diffIndexes(before, after),
      reclaimed,
    };
  }

  // --------------------------------------------------------------- read API

  /**
   * Signal end of stream: raise every source watermark to +Infinity so all
   * remaining matches finalise. Returns the finalised matches and the delta.
   */
  end(): WatermarkResult {
    const before = this.unionIndex();
    for (const source of this.sources) {
      this.watermarks.set(source, Number.POSITIVE_INFINITY);
    }
    this.progress = this.computeProgress();

    const finalized = this.finalizeReady();
    const reclaimed = this.reclaim();
    const after = this.unionIndex();

    return {
      status: 'applied',
      source: '*',
      progress: this.progress,
      finalized: sortMatches(finalized),
      delta: diffIndexes(before, after),
      reclaimed,
    };
  }

  snapshot(): Snapshot {
    const provisional = sortMatches([...this.provisional.values()]);
    const final = sortMatches([...this.finalByA.values()]);
    const all = sortMatches([...this.provisional.values(), ...this.finalByA.values()]);
    return { provisional, final, all };
  }

  stats(): Stats {
    let activeEvents = 0;
    let reservedB = 0;
    for (const state of this.keys.values()) {
      activeEvents += state.events.size;
      reservedB += state.reservedB.size;
    }
    return {
      sources: [...this.sources],
      watermarks: Object.fromEntries(this.watermarks),
      progress: this.progress,
      matchingHorizon: this.progress - this.windowMs,
      records: this.seen.size,
      maxRecords: this.maxRecords,
      activeEvents,
      reservedB,
      provisionalMatches: this.provisional.size,
      finalMatches: this.finalByA.size,
      reclaimedTotal: this.reclaimedTotal,
    };
  }

  /** Current global progress (minimum of all source watermarks). */
  get globalProgress(): number {
    return this.progress;
  }

  // -------------------------------------------------------------- internals

  private validateShape(input: CorrelationEvent): string | null {
    if (input === null || typeof input !== 'object') return 'event must be an object';
    if (typeof input.id !== 'string' || input.id.length === 0) {
      return 'event id must be a non-empty string';
    }
    if (typeof input.source !== 'string') return 'event source must be a string';
    if (typeof input.key !== 'string') return 'event key must be a string';
    if (!VALID_TYPES.includes(input.type)) return 'event type must be A, B or C';
    if (!isFiniteNumber(input.time)) return 'event time must be a finite number';
    return null;
  }

  private keyState(key: string): KeyState {
    let state = this.keys.get(key);
    if (state === undefined) {
      state = { events: new Map(), reservedB: new Map() };
      this.keys.set(key, state);
    }
    return state;
  }

  private computeProgress(): number {
    if (this.sources.length === 0) return Number.POSITIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    for (const source of this.sources) {
      const wm = this.watermarks.get(source) ?? Number.NEGATIVE_INFINITY;
      if (wm < min) min = wm;
    }
    return min;
  }

  /** Union of provisional and final matches, indexed by A id. */
  private unionIndex(): MatchIndex {
    const index: MatchIndex = new Map(this.finalByA);
    for (const [aId, match] of this.provisional) index.set(aId, match);
    return index;
  }

  /** Union restricted to one key (final matches for a key are stable). */
  private indexForKey(key: string): MatchIndex {
    const index: MatchIndex = new Map();
    for (const [aId, match] of this.provisional) {
      if (match.key === key) index.set(aId, match);
    }
    for (const [aId, match] of this.finalByA) {
      if (match.key === key) index.set(aId, match);
    }
    return index;
  }

  /** Recompute one key and store its provisional matches. */
  private recomputeKey(key: string): void {
    const state = this.keys.get(key);
    if (state === undefined) return;

    // Drop any stale provisional entries for this key first.
    for (const [aId, match] of this.provisional) {
      if (match.key === key) this.provisional.delete(aId);
    }

    if (state.events.size === 0) return;

    const { matches } = matchKeyEvents(
      state.events.values(),
      this.windowMs,
      state.reservedB.keys(),
    );
    for (const [aId, match] of matches) this.provisional.set(aId, match);
  }

  /**
   * Freeze every active A whose full matching deadline lies strictly before the
   * global progress. Their provisional result becomes permanent.
   */
  private finalizeReady(): Match[] {
    const finalized: Match[] = [];
    if (this.progress === Number.NEGATIVE_INFINITY) {
      return finalized; // Progress has not moved at all yet.
    }

    for (const [key, state] of this.keys) {
      // Ready As form a prefix of the key's A order: the deadline A.time + T is
      // monotone in A.time. Finalising a prefix of the greedy assignment cannot
      // change the choices made for later As, so the stored provisional matches
      // for those remain valid.
      const ready: CorrelationEvent[] = [];
      for (const event of state.events.values()) {
        if (event.type === 'A' && event.time + this.windowMs < this.progress) {
          ready.push(event);
        }
      }
      if (ready.length === 0) continue;
      ready.sort(compareEvents);

      for (const a of ready) {
        state.events.delete(a.id);
        const match = this.provisional.get(a.id);
        if (match !== undefined) {
          this.provisional.delete(a.id);
          this.finalByA.set(a.id, match);
          state.reservedB.set(match.bId, match.bTime);
          // The reserved B no longer takes part in matching.
          state.events.delete(match.bId);
          finalized.push(match);
        }
      }

      // Recompute remaining provisional matches; reserved Bs keep them stable.
      this.recomputeKey(key);
    }

    return finalized;
  }

  /**
   * Drop records that can no longer influence any future decision.
   *
   * Matching horizon H = progress - T. Any event still able to matter for an
   * unfinalised A must have time >= H, so B/C events below H are dropped. A
   * dedupe record is dropped only once its source can no longer re-deliver it
   * (watermark > time) *and* it is past the matching horizon and unreferenced.
   */
  private reclaim(): number {
    const horizon = this.progress - this.windowMs;
    let removed = 0;

    for (const state of this.keys.values()) {
      for (const [id, event] of [...state.events]) {
        if (event.type === 'A') continue;
        if (event.time < horizon) {
          state.events.delete(id);
          removed += 1;
        }
      }
      for (const [bId, bTime] of [...state.reservedB]) {
        if (bTime < horizon) {
          state.reservedB.delete(bId);
          removed += 1;
        }
      }
    }

    // Rebuild active/reserved id sets for the dedupe retention test.
    const active = new Set<string>();
    const reserved = new Set<string>();
    for (const state of this.keys.values()) {
      for (const id of state.events.keys()) active.add(id);
      for (const id of state.reservedB.keys()) reserved.add(id);
    }

    for (const [id, event] of [...this.seen]) {
      if (active.has(id) || reserved.has(id)) continue;
      const wm = this.watermarks.get(event.source) ?? Number.NEGATIVE_INFINITY;
      if (wm > event.time && event.time < horizon) {
        this.seen.delete(id);
        removed += 1;
      }
    }

    this.reclaimedTotal += removed;
    return removed;
  }
}
