/**
 * Discovery-view synthesis.
 *
 * Collects discovery facts from several sources, each with a fixed priority,
 * and resolves, per (service, instance id), the highest-priority valid fact. A
 * fact is either an available value or an authoritative deletion marker
 * (tombstone).
 *
 * Design invariants
 * -----------------
 * 1. Strict priority. The highest-priority source holding a valid fact for an
 *    instance wins, whether that fact is a value or a tombstone. So when the
 *    primary registration source explicitly deletes an instance, a stale
 *    fallback record cannot resurrect it.
 * 2. Snapshot = baseline, delta = continuation. A delta is accepted only when
 *    it continues the active generation's sequence exactly (+1) on top of a
 *    view that a full snapshot once established. A gap makes the source's
 *    entire view unusable until a full snapshot rebuilds it.
 * 3. Outdated input is inert. A lower generation, or a lower sequence within
 *    the active generation, never changes state.
 * 4. Conflicts are reported, not destructive. A same-generation,
 *    same-sequence update whose *content* differs from what was applied is
 *    reported as a source conflict, and the current view is kept in force.
 * 5. Validity is declared per accepted update and measured from the local
 *    receipt instant. An accepted update re-declares the validity of the whole
 *    source view from its own receipt time, so its values and tombstones live
 *    and lapse together. A repeated (equivalent) update never re-declares.
 * 6. Absence is not deletion. An instance missing from a snapshot means the
 *    source no longer holds a fact for it, so resolution falls back to lower
 *    priority sources rather than hiding the instance.
 * 7. The caller owns the clock. Every update carries `receivedAt`; every query
 *    carries `now`. Nothing reads wall time.
 * 8. Batches publish atomically. `apply` computes on a private working copy and
 *    publishes once, so external queries see either none or all of a batch.
 * 9. Independent sources commute. Per-source state is only ever touched by that
 *    source's own updates, and resolution is a pure function of all per-source
 *    states, so reordering updates from different sources yields the same view.
 */

import type {
  BatchOutcome,
  BatchResult,
  BatchUpdateResult,
  ConfigureOptions,
  DeltaUpdate,
  DiscoveryView,
  Generation,
  InstanceRecord,
  InstanceResolution,
  QueryOptions,
  Receipt,
  SequenceNumber,
  ServiceId,
  ShadowedFact,
  SnapshotUpdate,
  SourceConfig,
  SourceId,
  SourceIssue,
  SourceRef,
  SourceStatus,
  SourceUpdate,
} from "./types.ts";
import { DiscoveryViewError } from "./errors.ts";

type FactKey = string;

const KEY_SEPARATOR = "\u0000";
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function factKey(serviceId: ServiceId, instanceId: string): FactKey {
  return `${serviceId}${KEY_SEPARATOR}${instanceId}`;
}

function splitKey(key: FactKey): { serviceId: ServiceId; instanceId: string } {
  const at = key.indexOf(KEY_SEPARATOR);
  return { serviceId: key.slice(0, at), instanceId: key.slice(at + 1) };
}

/** One fact as held by a source. */
interface HeldRecord {
  readonly serviceId: ServiceId;
  readonly instanceId: string;
  readonly record: InstanceRecord;
  readonly generation: Generation;
  readonly sequence: SequenceNumber;
}

/** The view a source declared, grounded in a full snapshot. */
interface HeldView {
  readonly generation: Generation;
  /** Sequence of the accepted update that last refreshed the view. */
  readonly sequence: SequenceNumber;
  /** Facts by (service, instance). An absent key means "no fact held". */
  readonly records: Map<FactKey, HeldRecord>;
  /** Local receipt instant of the accepted update that opened this window. */
  readonly receiptAt: number;
  /** Absolute expiry = receiptAt + declared TTL. */
  readonly expiresAt: number;
  /** Fingerprint of (generation, sequence, records), for equivalence checks. */
  readonly contentFingerprint: string;
}

/** Internal per-source state. Fields are replaced, never mutated in place. */
interface SourceState {
  readonly config: SourceConfig;
  /** Highest generation observed from this source (monotonic). */
  generation: Generation | null;
  /**
   * Highest sequence accepted in `generation`. Monotonic. Retained across gaps
   * and expiry so a stale replay can never move the source backwards.
   */
  highWater: SequenceNumber | null;
  /** The last accepted view; may itself be blocked or lapsed, never revived. */
  view: HeldView | null;
  /** True once a sequence gap left the view unusable (until a snapshot). */
  blocked: boolean;
  /** Recoverable problem currently reported for this source. */
  issue: SourceIssue | null;
}

type InternalResult =
  | { readonly status: "applied" }
  | {
      readonly status: "ignored";
      readonly reason: "outdated-generation" | "outdated-sequence" | "duplicate";
    }
  | {
      readonly status: "rejected";
      readonly reason: "gap" | "conflict" | "expired" | "invalid";
    };

/**
 * The synthesis engine. Construct once with the fixed source priorities, feed
 * batches via `apply`, read via `query`. Instances are independent and no
 * global or ambient state is used.
 */
export class DiscoverySynthesizer {
  private sources: Map<SourceId, SourceState>;

  constructor(options: ConfigureOptions) {
    if (!options || !Array.isArray(options.sources) || options.sources.length === 0) {
      throw new DiscoveryViewError("INVALID_CONFIG", "at least one source must be configured");
    }
    const seen = new Set<string>();
    const priorities = new Set<number>();
    const initial = new Map<SourceId, SourceState>();
    for (const source of options.sources) {
      if (!source || typeof source.sourceId !== "string" || source.sourceId.length === 0) {
        throw new DiscoveryViewError("INVALID_CONFIG", "sourceId must be a non-empty string");
      }
      if (!Number.isFinite(source.priority)) {
        throw new DiscoveryViewError("INVALID_CONFIG", `priority for ${source.sourceId} must be finite`);
      }
      if (seen.has(source.sourceId)) {
        throw new DiscoveryViewError("DUPLICATE_SOURCE", `duplicate sourceId ${source.sourceId}`);
      }
      if (priorities.has(source.priority)) {
        throw new DiscoveryViewError(
          "INVALID_CONFIG",
          "source priorities must be unique so that precedence is total",
        );
      }
      seen.add(source.sourceId);
      priorities.add(source.priority);
      initial.set(source.sourceId, {
        config: { sourceId: source.sourceId, priority: source.priority },
        generation: null,
        highWater: null,
        view: null,
        blocked: false,
        issue: null,
      });
    }
    this.sources = initial;
  }

  // ------------------------------------------------------------------
  // Mutation
  // ------------------------------------------------------------------

  /**
   * Apply a batch of updates. The whole batch becomes visible atomically: a
   * caller's `query` sees either all accepted effects or none of them. A thrown
   * error leaves the prior state untouched.
   *
   * Updates are processed in the given order. Within one source that order must
   * be monotonic; reordering updates from *different* sources does not change
   * the resulting view.
   */
  apply(receipts: readonly Receipt[]): BatchResult {
    if (!Array.isArray(receipts)) {
      throw new DiscoveryViewError("INVALID_INPUT", "apply expects an array of receipts");
    }

    // Private working copy: view record maps are cloned so every mutation stays
    // invisible until the single publish below.
    const working = new Map<SourceId, SourceState>();
    for (const [id, state] of this.sources) {
      working.set(id, {
        ...state,
        view: state.view ? { ...state.view, records: new Map(state.view.records) } : null,
      });
    }

    const results: BatchUpdateResult[] = [];
    for (let index = 0; index < receipts.length; index += 1) {
      results.push(this.applyReceipt(working, receipts[index]!, index));
    }

    // Publish in one assignment: the batch is atomic to external observers.
    this.sources = working;

    return { outcome: summarise(results), results, ...counts(results) };
  }

  private applyReceipt(
    working: Map<SourceId, SourceState>,
    receipt: Receipt,
    index: number,
  ): BatchUpdateResult {
    if (!receipt || typeof receipt !== "object") {
      throw new DiscoveryViewError("INVALID_INPUT", `receipt ${index} must be a {update, receivedAt} object`);
    }
    const { update, receivedAt } = receipt;
    if (!update || typeof update !== "object") {
      throw new DiscoveryViewError("INVALID_INPUT", `receipt ${index} must carry an update object`);
    }
    if (!Number.isFinite(receivedAt)) {
      throw new DiscoveryViewError("INVALID_INPUT", `receipt ${index}: receivedAt must be a finite timestamp`);
    }
    const state = working.get(update.sourceId);
    if (!state) {
      return {
        index,
        sourceId: String(update.sourceId),
        status: "rejected",
        reason: "unknown-source",
      };
    }
    if (!validateUpdate(update)) {
      state.issue = {
        sourceId: state.config.sourceId,
        reason: "invalid",
        generation: Number.isInteger(update.generation) ? update.generation : 0,
        sequence: Number.isInteger(update.sequence) ? update.sequence : 0,
      };
      return { index, sourceId: state.config.sourceId, status: "rejected", reason: "invalid" };
    }

    const outcome = applyOne(state, update, receivedAt);
    if (outcome.status === "applied") {
      return { index, sourceId: state.config.sourceId, status: "applied", reason: null };
    }
    if (outcome.status === "ignored") {
      return { index, sourceId: state.config.sourceId, status: "ignored", reason: outcome.reason };
    }
    return { index, sourceId: state.config.sourceId, status: "rejected", reason: outcome.reason };
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /**
   * Read the synthesised view at `now`. Purely observational: the returned
   * value is a fresh structure the caller may keep.
   */
  query(now: number, options: QueryOptions = {}): DiscoveryView {
    assertFiniteTime(now, "now");
    const usable = [...this.sources.values()].filter((state) => isUsable(state, now));

    const keys = new Set<FactKey>();
    for (const state of usable) {
      for (const key of state.view!.records.keys()) keys.add(key);
    }

    const instances: InstanceResolution[] = [];
    for (const key of [...keys].sort()) {
      const { serviceId, instanceId } = splitKey(key);
      if (options.serviceId !== undefined && options.serviceId !== serviceId) continue;
      if (options.instanceId !== undefined && options.instanceId !== instanceId) continue;
      instances.push(this.resolveInstance(serviceId, instanceId, key, usable, now));
    }

    // An instance asked for by full coordinates that no usable source holds
    // still gets an explicit (absent) answer with its provenance.
    if (options.instanceId !== undefined && options.serviceId !== undefined && instances.length === 0) {
      const { serviceId, instanceId } = options;
      instances.push(this.resolveInstance(serviceId, instanceId, factKey(serviceId, instanceId), usable, now));
    }

    return {
      at: now,
      instances,
      sources: [...this.sources.values()]
        .sort((a, b) => a.config.priority - b.config.priority)
        .map((state) => toStatus(state, now)),
    };
  }

  /** Resolve one instance at `now`, even if no source currently holds a fact. */
  resolve(serviceId: ServiceId, instanceId: string, now: number): InstanceResolution {
    assertNonEmpty(serviceId, "serviceId");
    assertNonEmpty(instanceId, "instanceId");
    assertFiniteTime(now, "now");
    const usable = [...this.sources.values()].filter((state) => isUsable(state, now));
    return this.resolveInstance(serviceId, instanceId, factKey(serviceId, instanceId), usable, now);
  }

  /** Render the view as a plain, JSON-serialisable object. */
  render(now: number, options: QueryOptions = {}): DiscoveryView {
    return this.query(now, options);
  }

  /** Status of one source as observed at `now`. */
  status(sourceId: SourceId, now: number): SourceStatus {
    assertFiniteTime(now, "now");
    return toStatus(this.requireSource(sourceId), now);
  }

  /**
   * The problem currently preventing a source from contributing, or the
   * conflict reported against it. `null` when the source is healthy.
   *
   * The distinct reasons let callers tell a synchronisation failure (`gap` /
   * `source-conflict`) from ordinary expiry (`expired`).
   */
  issueOf(sourceId: SourceId, now: number): SourceIssue | null {
    assertFiniteTime(now, "now");
    const state = this.requireSource(sourceId);
    if (state.blocked) return state.issue;
    const view = state.view;
    if (view !== null && now >= view.expiresAt) {
      return {
        sourceId,
        reason: "expired",
        generation: view.generation,
        sequence: view.sequence,
      };
    }
    return state.issue;
  }

  /** Configured source ids, highest priority first. */
  sourceIds(): SourceId[] {
    return [...this.sources.values()]
      .sort((a, b) => a.config.priority - b.config.priority)
      .map((state) => state.config.sourceId);
  }

  private resolveInstance(
    serviceId: ServiceId,
    instanceId: string,
    key: FactKey,
    usable: readonly SourceState[],
    now: number,
  ): InstanceResolution {
    const candidates: Array<{ state: SourceState; held: HeldRecord }> = [];
    for (const state of usable) {
      const held = state.view!.records.get(key);
      if (held) candidates.push({ state, held });
    }

    if (candidates.length === 0) {
      return {
        serviceId,
        instanceId,
        state: "absent",
        shadowed: this.unusableHolders(key, now),
      };
    }

    // Lower priority number wins. Priorities are unique, so precedence is total.
    candidates.sort((a, b) => a.state.config.priority - b.state.config.priority);
    const winner = candidates[0]!;
    const winnerIsTombstone = winner.held.record.kind === "tombstone";

    const shadowed: ShadowedFact[] = [];
    for (let i = 1; i < candidates.length; i += 1) {
      const other = candidates[i]!;
      shadowed.push({
        sourceId: other.state.config.sourceId,
        priority: other.state.config.priority,
        generation: other.held.generation,
        sequence: other.held.sequence,
        reason: winnerIsTombstone ? "overridden-by-tombstone" : "lower-priority",
      });
    }
    // Sources that hold the instance but are not in force explain, for example,
    // why a lower-priority source is answering at all.
    shadowed.push(...this.unusableHolders(key, now));
    shadowed.sort(byPriority);

    const source: SourceRef = {
      sourceId: winner.state.config.sourceId,
      generation: winner.held.generation,
      sequence: winner.held.sequence,
    };

    if (winnerIsTombstone) {
      return { serviceId, instanceId, state: "deleted", source, shadowed };
    }
    return {
      serviceId,
      instanceId,
      state: "available",
      value: (winner.held.record as { kind: "value"; value: unknown }).value,
      source,
      shadowed,
    };
  }

  /**
   * Facts held for `key` by sources whose view is currently not in force. These
   * are the "why did that source not answer" entries on a resolution.
   */
  private unusableHolders(key: FactKey, now: number): ShadowedFact[] {
    const out: ShadowedFact[] = [];
    for (const state of this.sources.values()) {
      const view = state.view;
      if (!view || !view.records.has(key)) continue;
      if (isUsable(state, now)) continue;
      out.push({
        sourceId: state.config.sourceId,
        priority: state.config.priority,
        generation: view.generation,
        sequence: view.sequence,
        reason: "source-unusable",
      });
    }
    return out;
  }

  private requireSource(sourceId: SourceId): SourceState {
    const state = this.sources.get(sourceId);
    if (!state) {
      throw new DiscoveryViewError("UNKNOWN_SOURCE", `source ${sourceId} is not configured`);
    }
    return state;
  }
}

// ---------------------------------------------------------------------
// Update application
// ---------------------------------------------------------------------

function applyOne(state: SourceState, update: SourceUpdate, receivedAt: number): InternalResult {
  const generation = update.generation;
  const sequence = update.sequence;

  // 1. Older generations never change state.
  if (state.generation !== null && generation < state.generation) {
    return { status: "ignored", reason: "outdated-generation" };
  }

  // 2. Older sequences in the active generation never change state.
  if (
    state.generation !== null &&
    generation === state.generation &&
    state.highWater !== null &&
    sequence < state.highWater
  ) {
    return { status: "ignored", reason: "outdated-sequence" };
  }

  // 3. A newer generation restarts ordering. Only a snapshot can establish it.
  if (state.generation === null || generation > state.generation) {
    if (update.kind !== "snapshot") {
      // A delta with no baseline: facts from the superseded generation cannot
      // carry over. The view stays unusable until a snapshot arrives.
      state.generation = generation;
      state.highWater = null;
      state.view = null;
      state.blocked = true;
      state.issue = gapIssue(state, update);
      return { status: "rejected", reason: "gap" };
    }
    acceptSnapshot(state, update, receivedAt);
    return { status: "applied" };
  }

  // 4. Same generation and same sequence as the update already consumed, with a
  //    view currently in force: compare content. (While a gap has the view
  //    disabled there is nothing to conflict with, so the gap diagnostic is
  //    preserved below instead of being overwritten by a content mismatch.)
  if (!state.blocked && state.view !== null && state.highWater !== null && sequence === state.highWater) {
    if (isEquivalent(state, update)) {
      // Replay: inert. In particular it does not re-declare validity.
      return { status: "ignored", reason: "duplicate" };
    }
    // Same generation + sequence with different content: a source conflict.
    // The view currently in force is kept exactly as it was.
    state.issue = {
      sourceId: state.config.sourceId,
      reason: "source-conflict",
      generation,
      sequence,
    };
    return { status: "rejected", reason: "conflict" };
  }

  // 5. A full snapshot (re)builds the baseline. It is the only update that can
  //    recover a gap-blocked view or open a first baseline. After a gap it must
  //    be strictly newer than the last accepted sequence, or it would re-enable
  //    a view the source has already superseded.
  if (update.kind === "snapshot") {
    if (state.blocked && state.highWater !== null && sequence <= state.highWater) {
      state.issue = gapIssue(state, update);
      return { status: "rejected", reason: "gap" };
    }
    acceptSnapshot(state, update, receivedAt);
    return { status: "applied" };
  }

  // 6. A delta continues only a view that a snapshot once grounded, in the same
  //    generation, and only at the immediate next sequence.
  if (state.view === null || state.blocked) {
    state.issue = gapIssue(state, update);
    return { status: "rejected", reason: "gap" };
  }
  if (receivedAt >= state.view.expiresAt) {
    // The declared window has closed: values and tombstones lapsed together.
    // A delta must not silently revive them; a fresh full snapshot is needed.
    // No state change is made, so the view stays unusable exactly as it is.
    state.issue = {
      sourceId: state.config.sourceId,
      reason: "expired",
      generation: state.view.generation,
      sequence: state.view.sequence,
    };
    return { status: "rejected", reason: "expired" };
  }
  if (state.highWater === null || sequence !== state.highWater + 1) {
    // Missing sequence: stop using the entire view until a full snapshot.
    // Keep the view and high-water mark so a conflict against the last accepted
    // update is still detectable, and so stale input cannot roll us backwards.
    state.blocked = true;
    state.issue = gapIssue(state, update);
    return { status: "rejected", reason: "gap" };
  }

  acceptDelta(state, update, receivedAt);
  return { status: "applied" };
}

function gapIssue(state: SourceState, update: SourceUpdate): SourceIssue {
  return {
    sourceId: state.config.sourceId,
    reason: "gap",
    generation: update.generation,
    sequence: update.sequence,
  };
}

function acceptSnapshot(state: SourceState, update: SnapshotUpdate, receivedAt: number): void {
  const records = new Map<FactKey, HeldRecord>();
  for (const [serviceId, byInstance] of update.records) {
    for (const [instanceId, record] of byInstance) {
      records.set(factKey(serviceId, instanceId), {
        serviceId,
        instanceId,
        record,
        generation: update.generation,
        sequence: update.sequence,
      });
    }
  }

  state.generation = update.generation;
  state.highWater = update.sequence;
  state.blocked = false;
  state.view = {
    generation: update.generation,
    sequence: update.sequence,
    records,
    receiptAt: receivedAt,
    expiresAt: receivedAt + update.ttlMs,
    contentFingerprint: fingerprintView(update.generation, update.sequence, records),
  };
  state.issue = null;
}

function acceptDelta(state: SourceState, update: DeltaUpdate, receivedAt: number): void {
  const view = state.view!;
  const records = new Map(view.records);
  const key = factKey(update.serviceId, update.instanceId);
  if (update.record === undefined) {
    records.delete(key);
  } else {
    records.set(key, {
      serviceId: update.serviceId,
      instanceId: update.instanceId,
      record: update.record,
      generation: update.generation,
      sequence: update.sequence,
    });
  }

  state.highWater = update.sequence;
  state.view = {
    generation: update.generation,
    sequence: update.sequence,
    records,
    receiptAt: receivedAt,
    // Each accepted update declares the whole view's validity from its own
    // local receipt instant. This is a fresh fact, not a duplicate replay.
    expiresAt: receivedAt + update.ttlMs,
    contentFingerprint: fingerprintView(update.generation, update.sequence, records),
  };
  state.issue = null;
}

/**
 * Whether `update` describes exactly what is already held at its sequence.
 * Equivalence is judged by the *view content* the update implies: an update
 * whose effect on the held records is nil is a replay, whatever its shape.
 * Anything that would change the content is a conflict.
 */
function isEquivalent(state: SourceState, update: SourceUpdate): boolean {
  const view = state.view;
  if (view === null) return false;
  if (view.generation !== update.generation || view.sequence !== update.sequence) return false;

  if (update.kind === "snapshot") {
    return snapshotFingerprint(update) === view.contentFingerprint;
  }

  // A delta at the held sequence: applying it to the records already holding
  // its own effect must leave them unchanged.
  const key = factKey(update.serviceId, update.instanceId);
  const held = view.records.get(key);
  if (update.record === undefined) return held === undefined;
  if (held === undefined) return false;
  if (held.generation !== update.generation || held.sequence !== update.sequence) return false;
  return JSON.stringify(stableRecord(held.record)) === JSON.stringify(stableRecord(update.record));
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function byPriority(a: ShadowedFact, b: ShadowedFact): number {
  return a.priority - b.priority;
}

function isUsable(state: SourceState, now: number): boolean {
  const view = state.view;
  if (view === null || state.blocked) return false;
  return now < view.expiresAt;
}

function toStatus(state: SourceState, now: number): SourceStatus {
  const view = state.view;
  const expired = view !== null && !state.blocked && now >= view.expiresAt;
  return {
    sourceId: state.config.sourceId,
    priority: state.config.priority,
    generation: state.generation,
    sequence: state.highWater,
    usable: isUsable(state, now),
    blocked: state.blocked,
    expired,
    receivedAt: view ? view.receiptAt : null,
    expiresAt: view ? view.expiresAt : null,
    issue: expired
      ? {
          sourceId: state.config.sourceId,
          reason: "expired",
          generation: view!.generation,
          sequence: view!.sequence,
        }
      : state.issue,
  };
}

function assertFiniteTime(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new DiscoveryViewError("INVALID_INPUT", `${name} must be a finite timestamp`);
  }
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DiscoveryViewError("INVALID_INPUT", `${name} must be a non-empty string`);
  }
}

function validateUpdate(update: SourceUpdate): boolean {
  if (!update || (update.kind !== "snapshot" && update.kind !== "delta")) return false;
  if (!isSequence(update.generation) || !isSequence(update.sequence)) return false;
  if (!Number.isFinite(update.ttlMs) || update.ttlMs < 0) return false;
  if (update.kind === "snapshot") {
    if (!(update.records instanceof Map)) return false;
    for (const [serviceId, byInstance] of update.records) {
      if (typeof serviceId !== "string" || serviceId.length === 0) return false;
      if (!(byInstance instanceof Map)) return false;
      for (const [instanceId, record] of byInstance) {
        if (typeof instanceId !== "string" || instanceId.length === 0) return false;
        if (!isRecord(record)) return false;
      }
    }
    return true;
  }
  if (typeof update.serviceId !== "string" || update.serviceId.length === 0) return false;
  if (typeof update.instanceId !== "string" || update.instanceId.length === 0) return false;
  return update.record === undefined || isRecord(update.record);
}

function isSequence(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_SAFE;
}

function isRecord(value: unknown): value is InstanceRecord {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "value" || kind === "tombstone";
}

function summarise(results: readonly BatchUpdateResult[]): BatchOutcome {
  if (results.length === 0) return "applied";
  const { applied, rejected } = counts(results);
  if (applied > 0 && rejected === 0) return "applied";
  if (applied > 0) return "partially-applied";
  if (rejected > 0) return "rejected";
  return "unchanged";
}

function counts(results: readonly BatchUpdateResult[]): {
  applied: number;
  ignored: number;
  rejected: number;
} {
  let applied = 0;
  let ignored = 0;
  let rejected = 0;
  for (const result of results) {
    if (result.status === "applied") applied += 1;
    else if (result.status === "ignored") ignored += 1;
    else rejected += 1;
  }
  return { applied, ignored, rejected };
}

/**
 * Fingerprint of the complete view a snapshot describes: its generation,
 * sequence and full (service, instance) fact map.
 */
function snapshotFingerprint(update: SnapshotUpdate): string {
  const records = new Map<FactKey, HeldRecord>();
  for (const [serviceId, byInstance] of update.records) {
    for (const [instanceId, record] of byInstance) {
      records.set(factKey(serviceId, instanceId), {
        serviceId,
        instanceId,
        record,
        generation: update.generation,
        sequence: update.sequence,
      });
    }
  }
  return fingerprintView(update.generation, update.sequence, records);
}

function fingerprintView(
  generation: Generation,
  sequence: SequenceNumber,
  records: ReadonlyMap<FactKey, HeldRecord>,
): string {
  const entries = [...records.entries()]
    .map(([key, held]) => [key, stableRecord(held.record)] as const)
    .sort((a, b) => compareString(a[0], b[0]));
  return JSON.stringify([generation, sequence, entries]);
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableRecord(record: InstanceRecord): unknown {
  if (record.kind === "tombstone") return ["tombstone"];
  return ["value", stableValue(record.value)];
}

/** Deterministically serialise arbitrary JSON-ish values for fingerprints. */
function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return ["number", String(value)];
    if (typeof value === "bigint") return ["bigint", value.toString()];
    if (typeof value === "undefined") return ["undefined"];
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = stableValue(source[key]);
  return out;
}
