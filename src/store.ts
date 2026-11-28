import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  appendFileSync,
  fsyncSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { IntervalSet } from "./interval.ts";
import {
  BackpressureError,
  CorruptStateError,
  DuplicateRecordError,
  InvalidLineageError,
  InvalidTopologyError,
  UnknownGenerationError,
  UnknownOffsetError,
  UnknownRecordError,
} from "./errors.ts";
import {
  recordKey,
  sameRecord,
  spgKeyOf,
  type Blocker,
  type CompactStats,
  type LineageStoreOptions,
  type RecordId,
  type SinkReport,
  type SourcePositionExplanation,
  type StoreStats,
  type Topology,
} from "./types.ts";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = "snapshot.json";
const WAL_FILE = "wal.log";

interface InternalRecord {
  id: RecordId;
  /** Predecessor records this output depends on (empty for source records). */
  inputs: RecordId[];
  /** Successor records declared so far. */
  successors: RecordId[];
  /** All successors have been declared (zero successors means filtered out). */
  sealed: boolean;
  /** Sink only: terminal confirmation received. */
  confirmed: boolean;
  /** Derived: sealed and every reachable terminal output is confirmed. */
  complete: boolean;
}

interface SpgMeta {
  stage: string;
  partition: number;
  generation: number;
}

type WalEvent =
  | { t: "register"; seq: number; id: RecordId; inputs: RecordId[] }
  | { t: "seal"; seq: number; id: RecordId }
  | { t: "confirm"; seq: number; id: RecordId };

interface Snapshot {
  version: number;
  seq: number;
  topology: Topology;
  records: InternalRecord[];
  spgMaxOffset: Record<string, number>;
  spgMeta: Record<string, SpgMeta>;
  spgCompletePrefix: Record<string, number>;
  /** Evicted complete prefix per SPG — facts covered by this summary may be dropped. */
  spgSummary: Record<string, number>;
  sourceCommit: Record<string, number>;
  sinkConfirms: Record<string, OffsetIntervalJson[]>;
  liveCount: number;
}

interface OffsetIntervalJson {
  start: number;
  end: number;
}

/**
 * Local-directory backed offset lineage store.
 *
 * All mutations are validated atomically before anything is appended to the
 * WAL: a rejected registration/seal leaves no partial state behind.
 */
export class LineageStore {
  private readonly dir: string;
  private readonly walPath: string;
  private readonly snapPath: string;
  private readonly capacity: number | undefined;
  private topology: Topology;
  private stageKinds: Map<string, string>;
  private edgePairs: Set<string>;

  private records = new Map<string, InternalRecord>();
  private spgMaxOffset = new Map<string, number>();
  private spgMeta = new Map<string, SpgMeta>();
  private spgCompletePrefix = new Map<string, number>();
  private spgSummary = new Map<string, number>();
  private sourceCommit = new Map<string, number>();
  private sinkConfirms = new Map<string, IntervalSet>();
  private liveCount = 0;
  private seq = 0;

  private walFd: number | undefined;

  private constructor(
    dir: string,
    topology: Topology,
    options: LineageStoreOptions | undefined,
  ) {
    this.dir = dir;
    this.walPath = join(dir, WAL_FILE);
    this.snapPath = join(dir, SNAPSHOT_FILE);
    this.capacity = options?.capacity;
    this.topology = topology;
    this.stageKinds = new Map(topology.stages.map((s) => [s.name, s.kind]));
    this.edgePairs = new Set(topology.edges.map((e) => `${e.from}->${e.to}`));
  }

  /**
   * Open (or create) a store in `dir`.
   * A new store requires a topology; an existing store restores its own and
   * rejects a mismatched one.
   */
  static open(dir: string, topology?: Topology, options?: LineageStoreOptions): LineageStore {
    mkdirSync(dir, { recursive: true });
    const walPath = join(dir, WAL_FILE);
    const snapPath = join(dir, SNAPSHOT_FILE);
    const hasSnapshot = existsSync(snapPath);
    const hasWal = existsSync(walPath);

    if (!hasSnapshot && !hasWal) {
      if (!topology) {
        throw new InvalidTopologyError("topology is required when creating a new store");
      }
      validateTopology(topology);
      const store = new LineageStore(dir, topology, options);
      store.walFd = openSync(store.walPath, "a");
      store.checkpoint(); // persist the initial topology snapshot
      return store;
    }

    let snapshot: Snapshot | undefined;
    if (hasSnapshot) {
      snapshot = JSON.parse(readFileSync(snapPath, "utf8")) as Snapshot;
      if (snapshot.version !== SNAPSHOT_VERSION) {
        throw new CorruptStateError(`unsupported snapshot version ${snapshot.version}`);
      }
      if (topology && !topologyEqual(topology, snapshot.topology)) {
        throw new InvalidTopologyError("provided topology does not match the persisted one");
      }
      validateTopology(snapshot.topology);
    } else if (!topology) {
      throw new InvalidTopologyError("topology is required and no snapshot was found");
    } else {
      validateTopology(topology);
    }
    const effectiveTopology = snapshot?.topology ?? (topology as Topology);
    const store = new LineageStore(dir, effectiveTopology, options);
    store.restore(snapshot);

    if (hasWal) {
      const lines = readFileSync(walPath, "utf8").split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        const event = JSON.parse(line) as WalEvent;
        if (event.seq !== store.seq + 1) {
          throw new CorruptStateError(
            `WAL sequence gap: expected ${store.seq + 1}, got ${event.seq}`,
          );
        }
        store.applyEvent(event); // trusted replay: validation already happened before append
      }
    }

    // Re-derive every derived fact from the materialized facts and check the
    // published safe frontiers never regress.
    store.rebuildDerived();
    store.walFd = openSync(store.walPath, "a");
    return store;
  }

  // ---------------------------------------------------------------- registration

  /**
   * Register a source input. Offsets inside one (stage, partition, generation)
   * must be registered gap-free starting at 0.
   */
  registerRecord(id: RecordId): void {
    if (this.stageKinds.get(id.stage) !== "source") {
      throw new InvalidLineageError(
        `registerRecord is only valid for source stages; ${id.stage} is ${this.stageKinds.get(id.stage)}`,
      );
    }
    this.validateFreshId(id);
    this.validateContiguity(id);
    this.checkCapacity();
    this.appendAndApply({ t: "register", seq: this.seq + 1, id, inputs: [] });
  }

  /**
   * Register an output record depending on one or more already-registered
   * inputs. One input may generate many successors (fan-out); one output may
   * merge many inputs (fan-in). Validation and persistence are atomic: on any
   * validation error no state changes and nothing is written.
   */
  registerOutput(output: RecordId, inputs: RecordId[]): void {
    if (inputs.length === 0) {
      throw new InvalidLineageError("output registration requires at least one input");
    }
    const outKind = this.stageKinds.get(output.stage);
    if (outKind === undefined) {
      throw new InvalidLineageError(`unknown stage ${output.stage}`);
    }
    if (outKind === "source") {
      throw new InvalidLineageError("a source stage cannot receive outputs");
    }
    const seenInputs = new Set<string>();
    for (const input of inputs) {
      const key = recordKey(input);
      if (seenInputs.has(key)) {
        throw new InvalidLineageError(`duplicate input ${key} in the same registration`);
      }
      seenInputs.add(key);
      if (!this.records.has(key)) {
        throw new UnknownRecordError(`input ${key} is not registered`);
      }
      if (!this.edgePairs.has(`${input.stage}->${output.stage}`)) {
        throw new InvalidLineageError(
          `topology has no edge ${input.stage}->${output.stage}`,
        );
      }
    }
    this.validateFreshId(output);
    this.validateContiguity(output);
    this.checkCapacity();
    this.appendAndApply({ t: "register", seq: this.seq + 1, id: output, inputs });
  }

  /**
   * Declare that all successors of `id` have now been registered. A seal with
   * zero successors explicitly means the record was filtered out. Idempotent.
   * Returns true when this call performed the seal.
   */
  seal(id: RecordId): boolean {
    const rec = this.requireRecord(id);
    if (rec.sealed) return false;
    this.appendAndApply({ t: "seal", seq: this.seq + 1, id });
    return true;
  }

  /**
   * Confirm a terminal (sink) output. Confirmations may arrive out of order;
   * holes are retained as discrete intervals. A late confirmation for an
   * offset already covered by compaction is accepted as an idempotent no-op
   * and still resolves to its generation via the identity tuple.
   * Returns true when the confirmation was new.
   */
  confirm(id: RecordId): boolean {
    const kind = this.stageKinds.get(id.stage);
    if (kind === undefined) {
      throw new InvalidLineageError(`unknown stage ${id.stage}`);
    }
    if (kind !== "sink") {
      throw new InvalidLineageError(`only sink records can be confirmed; ${id.stage} is ${kind}`);
    }
    const spg = spgKeyOf(id);
    const knownGeneration = this.spgMeta.has(spg) || this.spgSummary.has(spg);
    if (!knownGeneration) {
      throw new UnknownGenerationError(
        `no generation ${id.generation} registered for ${id.stage} partition ${id.partition}`,
      );
    }
    const maxOffset = this.spgMaxOffset.get(spg);
    const summary = this.spgSummary.get(spg) ?? 0;
    if (maxOffset !== undefined && id.offset > maxOffset) {
      throw new UnknownOffsetError(
        `offset ${id.offset} exceeds max registered offset ${maxOffset} for ${spg}`,
      );
    }
    if (id.offset < summary) {
      return false; // already covered by a compacted summary — late, harmless
    }
    const set = this.sinkConfirms.get(spg) ?? new IntervalSet();
    const newlyAdded = set.add(id.offset);
    this.sinkConfirms.set(spg, set);
    if (!newlyAdded) return false;

    this.appendAndApply({ t: "confirm", seq: this.seq + 1, id });
    return true;
  }

  // ---------------------------------------------------------------- queries

  /** Continuous committable frontier (next uncommitted offset) of a source partition. */
  getSourceCommitFrontier(source: string, partition: number, generation: number): number {
    if (this.stageKinds.get(source) !== "source") {
      throw new InvalidLineageError(`${source} is not a source stage`);
    }
    return this.sourceCommit.get(spgKeyOf({ stage: source, partition, generation })) ?? 0;
  }

  /** Terminal report: cumulative frontier plus every discrete confirmed interval. */
  getSinkReport(stage: string, partition: number, generation: number): SinkReport {
    if (this.stageKinds.get(stage) !== "sink") {
      throw new InvalidLineageError(`${stage} is not a sink stage`);
    }
    const spg = spgKeyOf({ stage, partition, generation });
    if (!this.spgMeta.has(spg) && !this.spgSummary.has(spg)) {
      throw new UnknownGenerationError(
        `no generation ${generation} registered for ${stage} partition ${partition}`,
      );
    }
    const set = this.sinkConfirms.get(spg);
    return {
      stage,
      partition,
      generation,
      maxOffset: (this.spgMaxOffset.get(spg) ?? -1) + 1,
      confirmedFrontier: set?.frontier ?? 0,
      intervals: set?.getIntervals() ?? [],
    };
  }

  /**
   * Explain exactly why one source position is blocked or committable.
   * With no explicit offset the next position after the commit frontier is
   * explained.
   */
  explainSourcePosition(
    source: string,
    partition: number,
    generation: number,
    offset?: number,
  ): SourcePositionExplanation {
    if (this.stageKinds.get(source) !== "source") {
      throw new InvalidLineageError(`${source} is not a source stage`);
    }
    const spg = spgKeyOf({ stage: source, partition, generation });
    if (!this.spgMeta.has(spg) && !this.spgSummary.has(spg)) {
      throw new UnknownGenerationError(
        `no generation ${generation} registered for ${source} partition ${partition}`,
      );
    }
    const commitFrontier = this.sourceCommit.get(spg) ?? 0;
    const maxOffset = this.spgMaxOffset.get(spg) ?? -1;
    const targetOffset = offset ?? commitFrontier;

    if (targetOffset < commitFrontier || targetOffset < (this.spgSummary.get(spg) ?? 0)) {
      return {
        source,
        partition,
        generation,
        offset: targetOffset,
        state: "committed",
        commitFrontier,
        blockers: [],
      };
    }
    if (targetOffset > maxOffset) {
      return {
        source,
        partition,
        generation,
        offset: targetOffset,
        state: "not-registered",
        commitFrontier,
        blockers: [],
      };
    }

    const target = this.records.get(
      recordKey({ stage: source, partition, generation, offset: targetOffset }),
    );
    if (!target) {
      throw new CorruptStateError(
        `record for explained position is missing: ${spg}#${targetOffset}`,
      );
    }

    const memo = new Map<string, Blocker[]>();
    const visiting = new Set<string>();
    const blockers = this.collectBlockers(target, memo, visiting);

    let state: string;
    if (blockers.length > 0) {
      state = "blocked";
    } else {
      // committable only when the whole prefix up to this offset is complete
      let prefixComplete = true;
      for (let o = commitFrontier; o < targetOffset; o++) {
        const earlier = this.records.get(
          recordKey({ stage: source, partition, generation, offset: o }),
        );
        if (!earlier || !earlier.complete) {
          prefixComplete = false;
          break;
        }
      }
      state = prefixComplete ? "committable" : "complete-pending-prefix";
    }

    return {
      source,
      partition,
      generation,
      offset: targetOffset,
      state,
      commitFrontier,
      blockers,
    };
  }

  /** Snapshot of record flags, mainly for tests and diagnostics. */
  getRecordState(id: RecordId): { sealed: boolean; confirmed: boolean; complete: boolean } {
    const rec = this.requireRecord(id);
    return { sealed: rec.sealed, confirmed: rec.confirmed, complete: rec.complete };
  }

  getStats(): StoreStats {
    let complete = 0;
    for (const rec of this.records.values()) if (rec.complete) complete++;
    return {
      liveRecords: this.liveCount,
      totalRecords: this.records.size,
      completeRecords: complete,
      spgCount: this.spgMeta.size,
    };
  }

  // ---------------------------------------------------------------- compaction

  /**
   * Drop facts already covered by per-SPG summaries.
   * A record is evicted only when it is complete, lies inside the complete
   * prefix of its own SPG, and every edge touching it is removed together with
   * it — so the remaining graph never contains dangling lineage.
   */
  compact(): CompactStats {
    const prefixOf = new Map<string, number>();
    for (const [k, prefix] of this.spgCompletePrefix) {
      if (prefix > 0) prefixOf.set(k, prefix);
    }

    // Initial candidates: complete records inside their SPG complete prefix.
    const eligible = new Set<string>();
    for (const rec of this.records.values()) {
      const spg = spgKeyOf(rec.id);
      const prefix = prefixOf.get(spg);
      if (prefix !== undefined && rec.complete && rec.id.offset < prefix) {
        eligible.add(recordKey(rec.id));
      }
    }

    // Fixpoint: keep anything adjacent (in either direction) to a non-evicted
    // record, so edges are always removed on both ends.
    let changed = true;
    while (changed) {
      changed = false;
      for (const key of [...eligible]) {
        const rec = this.records.get(key);
        if (!rec) throw new CorruptStateError(`eligible record vanished: ${key}`);
        for (const neighbor of [...rec.inputs, ...rec.successors]) {
          if (!this.records.has(recordKey(neighbor))) {
            throw new CorruptStateError(`dangling lineage reference to ${recordKey(neighbor)}`);
          }
          if (!eligible.has(recordKey(neighbor))) {
            eligible.delete(key);
            changed = true;
            break;
          }
        }
      }
    }

    const evictedSpg = new Set<string>();
    for (const key of eligible) {
      const rec = this.records.get(key);
      if (!rec) continue;
      evictedSpg.add(spgKeyOf(rec.id));
      this.records.delete(key);
    }

    // Extend summaries only over contiguous evicted prefixes.
    for (const spg of evictedSpg) {
      const prefix = prefixOf.get(spg) ?? 0;
      const oldSummary = this.spgSummary.get(spg) ?? 0;
      let newSummary = oldSummary;
      const meta = this.spgMeta.get(spg);
      if (!meta) throw new CorruptStateError(`missing SPG meta for ${spg}`);
      while (
        newSummary < prefix &&
        !this.records.has(
          recordKey({
            stage: meta.stage,
            partition: meta.partition,
            generation: meta.generation,
            offset: newSummary,
          }),
        )
      ) {
        newSummary++;
      }
      if (newSummary > oldSummary) this.spgSummary.set(spg, newSummary);
      if (newSummary === prefix) this.spgCompletePrefix.delete(spg);
      else this.spgCompletePrefix.set(spg, prefix);
    }

    // Invariant: no remaining edge points at a missing record.
    for (const rec of this.records.values()) {
      for (const neighbor of [...rec.inputs, ...rec.successors]) {
        if (!this.records.has(recordKey(neighbor))) {
          throw new CorruptStateError(
            `post-compaction dangling reference ${recordKey(rec.id)} -> ${recordKey(neighbor)}`,
          );
        }
      }
    }

    this.checkpoint();
    return {
      evictedRecords: eligible.size,
      remainingRecords: this.records.size,
      spgSummaries: this.spgSummary.size,
    };
  }

  /** Flush a snapshot and rotate the WAL; safe to call at any time. */
  checkpoint(): void {
    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      seq: this.seq,
      topology: this.topology,
      records: [...this.records.values()],
      spgMaxOffset: Object.fromEntries(this.spgMaxOffset),
      spgMeta: Object.fromEntries(this.spgMeta),
      spgCompletePrefix: Object.fromEntries(this.spgCompletePrefix),
      spgSummary: Object.fromEntries(this.spgSummary),
      sourceCommit: Object.fromEntries(this.sourceCommit),
      sinkConfirms: Object.fromEntries(
        [...this.sinkConfirms].map(([k, set]) => [k, set.toJSON()]),
      ),
      liveCount: this.liveCount,
    };
    const tmp = join(this.dir, `${SNAPSHOT_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, this.snapPath);
    if (this.walFd !== undefined) {
      closeSync(this.walFd);
      this.walFd = undefined;
      if (existsSync(this.walPath)) rmSync(this.walPath);
    }
    this.walFd = openSync(this.walPath, "a");
  }

  close(): void {
    if (this.walFd !== undefined) {
      fsyncSync(this.walFd);
      closeSync(this.walFd);
      this.walFd = undefined;
    }
  }

  // ---------------------------------------------------------------- internals

  private validateFreshId(id: RecordId): void {
    if (
      !Number.isInteger(id.offset) ||
      id.offset < 0 ||
      !Number.isInteger(id.partition) ||
      id.partition < 0 ||
      !Number.isInteger(id.generation) ||
      id.generation < 0
    ) {
      throw new InvalidLineageError(`invalid record identity ${JSON.stringify(id)}`);
    }
    if (!this.stageKinds.has(id.stage)) {
      throw new InvalidLineageError(`unknown stage ${id.stage}`);
    }
    if (this.records.has(recordKey(id))) {
      throw new DuplicateRecordError(`record ${recordKey(id)} is already registered`);
    }
  }

  private validateContiguity(id: RecordId): void {
    const spg = spgKeyOf(id);
    const maxOffset = this.spgMaxOffset.get(spg);
    const expected = maxOffset === undefined ? 0 : maxOffset + 1;
    if (id.offset !== expected) {
      throw new InvalidLineageError(
        `non-contiguous registration for ${spg}: expected offset ${expected}, got ${id.offset}`,
      );
    }
  }

  private checkCapacity(): void {
    if (this.capacity !== undefined && this.liveCount >= this.capacity) {
      throw new BackpressureError(
        `capacity ${this.capacity} reached with ${this.liveCount} live records; ` +
          `seal successors or confirm terminals to release slots`,
      );
    }
  }

  private requireRecord(id: RecordId): InternalRecord {
    const rec = this.records.get(recordKey(id));
    if (!rec) throw new UnknownRecordError(`record ${recordKey(id)} is not registered`);
    return rec;
  }

  private appendAndApply(event: WalEvent): void {
    if (this.walFd === undefined) {
      throw new CorruptStateError("store is closed");
    }
    appendFileSync(this.walFd, JSON.stringify(event) + "\n");
    fsyncSync(this.walFd);
    this.applyEvent(event);
    this.runSweep();
  }

  private applyEvent(event: WalEvent): void {
    this.seq = event.seq;
    if (event.t === "register") {
      const rec: InternalRecord = {
        id: event.id,
        inputs: event.inputs,
        successors: [],
        sealed: false,
        confirmed: false,
        complete: false,
      };
      this.records.set(recordKey(event.id), rec);
      for (const input of event.inputs) {
        const predecessor = this.records.get(recordKey(input));
        if (!predecessor) {
          throw new CorruptStateError(
            `WAL register references missing input ${recordKey(input)}`,
          );
        }
        predecessor.successors.push(event.id);
      }
      const spg = spgKeyOf(event.id);
      this.spgMaxOffset.set(spg, event.id.offset);
      this.spgMeta.set(spg, {
        stage: event.id.stage,
        partition: event.id.partition,
        generation: event.id.generation,
      });
      this.liveCount++;
    } else if (event.t === "seal") {
      const rec = this.records.get(recordKey(event.id));
      if (!rec) {
        throw new CorruptStateError(
          `WAL seal references missing record ${recordKey(event.id)}`,
        );
      }
      rec.sealed = true;
    } else {
      const rec = this.records.get(recordKey(event.id));
      const spg = spgKeyOf(event.id);
      const set = this.sinkConfirms.get(spg) ?? new IntervalSet();
      set.add(event.id.offset);
      this.sinkConfirms.set(spg, set);
      if (rec) rec.confirmed = true;
      // Missing rec means a late confirmation of a compacted record: the
      // interval fact is retained and generation is identified by the key.
    }
  }

  /**
   * Propagate completeness through the lineage DAG.
   * A record becomes complete when:
   *  - sink:     it has been confirmed and sealed
   *  - otherwise: it is sealed and every declared successor is complete.
   *              A zero-successor seal therefore completes immediately,
   *              which is how filtered inputs retire.
   */
  private runSweep(): void {
    // Reseed from every sealed-but-incomplete record on each sweep: a record
    // sealed earlier can become newly ready once a sibling drains, and a
    // zero-successor seal has no successor event that would re-enqueue it.
    const queue: InternalRecord[] = [];
    for (const rec of this.records.values()) {
      const isSink = this.stageKinds.get(rec.id.stage) === "sink";
      const ready = isSink ? rec.confirmed && rec.sealed : rec.sealed;
      if (ready && !rec.complete) queue.push(rec);
    }

    while (queue.length > 0) {
      const rec = queue.shift() as InternalRecord;
      if (rec.complete) continue;

      let ok: boolean;
      if (this.stageKinds.get(rec.id.stage) === "sink") {
        ok = rec.confirmed && rec.sealed;
      } else {
        ok = rec.sealed;
        for (const succId of rec.successors) {
          const succ = this.records.get(recordKey(succId));
          if (!succ) {
            throw new CorruptStateError(
              `record ${recordKey(rec.id)} references missing successor ${recordKey(succId)}`,
            );
          }
          if (!succ.complete) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;

      rec.complete = true;
      this.liveCount--;
      this.extendCompletePrefix(rec);
      for (const inputId of rec.inputs) {
        const predecessor = this.records.get(recordKey(inputId));
        if (predecessor && !predecessor.complete) queue.push(predecessor);
      }
    }

    this.publishSourceFrontiers();
  }

  private extendCompletePrefix(rec: InternalRecord): void {
    const spg = spgKeyOf(rec.id);
    const meta = this.spgMeta.get(spg);
    if (!meta) throw new CorruptStateError(`missing SPG meta for ${spg}`);
    let frontier = this.spgCompletePrefix.get(spg) ?? this.spgSummary.get(spg) ?? 0;
    while (
      this.records.has(
        recordKey({
          stage: meta.stage,
          partition: meta.partition,
          generation: meta.generation,
          offset: frontier,
        }),
      )
    ) {
      const next = this.records.get(
        recordKey({
          stage: meta.stage,
          partition: meta.partition,
          generation: meta.generation,
          offset: frontier,
        }),
      ) as InternalRecord;
      if (!next.complete) break;
      frontier++;
    }
    this.spgCompletePrefix.set(spg, frontier);
  }

  /**
   * A source partition advances only while its sealed records have all their
   * reachable terminal outputs confirmed — the complete prefix encodes exactly
   * that condition. Published frontiers are monotonic.
   */
  private publishSourceFrontiers(): void {
    const sourceNames = new Set(
      this.topology.stages.filter((s) => s.kind === "source").map((s) => s.name),
    );
    for (const [spg, meta] of this.spgMeta) {
      if (!sourceNames.has(meta.stage)) continue;
      const prefix = this.spgCompletePrefix.get(spg) ?? this.spgSummary.get(spg) ?? 0;
      const published = this.sourceCommit.get(spg) ?? 0;
      if (prefix > published) this.sourceCommit.set(spg, prefix);
    }
  }

  private collectBlockers(
    rec: InternalRecord,
    memo: Map<string, Blocker[]>,
    visiting: Set<string>,
  ): Blocker[] {
    const key = recordKey(rec.id);
    const cached = memo.get(key);
    if (cached) return cached;
    if (rec.complete) {
      memo.set(key, []);
      return [];
    }
    if (visiting.has(key)) {
      return [{ record: { ...rec.id }, reason: "cycle" }];
    }
    visiting.add(key);
    const blockers: Blocker[] = [];
    const kind = this.stageKinds.get(rec.id.stage);

    if (kind === "sink") {
      if (!rec.sealed) blockers.push({ record: { ...rec.id }, reason: "unsealed" });
      else if (!rec.confirmed) blockers.push({ record: { ...rec.id }, reason: "unconfirmed" });
    } else if (!rec.sealed) {
      blockers.push({ record: { ...rec.id }, reason: "unsealed" });
    } else {
      for (const succId of rec.successors) {
        const succ = this.records.get(recordKey(succId));
        if (!succ) {
          blockers.push({ record: { ...rec.id }, reason: "unregistered" });
          continue;
        }
        blockers.push(...this.collectBlockers(succ, memo, visiting));
      }
    }

    visiting.delete(key);
    memo.set(key, blockers);
    return blockers;
  }

  private restore(snapshot: Snapshot | undefined): void {
    if (!snapshot) return;
    this.seq = snapshot.seq;
    this.records = new Map(snapshot.records.map((r) => [recordKey(r.id), r]));
    this.spgMaxOffset = new Map(Object.entries(snapshot.spgMaxOffset));
    this.spgMeta = new Map(Object.entries(snapshot.spgMeta));
    this.spgCompletePrefix = new Map(Object.entries(snapshot.spgCompletePrefix));
    this.spgSummary = new Map(Object.entries(snapshot.spgSummary ?? {}));
    this.liveCount = snapshot.liveCount;
    this.sourceCommit = new Map(Object.entries(snapshot.sourceCommit));
    this.sinkConfirms = new Map(
      Object.entries(snapshot.sinkConfirms ?? {}).map(([k, ivs]) => [
        k,
        IntervalSet.fromIntervals(ivs),
      ]),
    );
  }

  /** Recompute every derived fact after replay and verify no regression. */
  private rebuildDerived(): void {
    const publishedBefore = new Map(this.sourceCommit);
    for (const rec of this.records.values()) rec.complete = false;
    this.spgCompletePrefix.clear();
    this.liveCount = this.records.size;
    this.runSweep();

    for (const [spg, frontierBefore] of publishedBefore) {
      const frontierAfter = this.sourceCommit.get(spg) ?? 0;
      if (frontierAfter < frontierBefore) {
        throw new CorruptStateError(
          `published safe frontier regressed for ${spg}: ${frontierBefore} -> ${frontierAfter}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------- topology helpers

function validateTopology(topology: Topology): void {
  const names = new Set<string>();
  for (const stage of topology.stages) {
    if (names.has(stage.name)) {
      throw new InvalidTopologyError(`duplicate stage name ${stage.name}`);
    }
    names.add(stage.name);
  }
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const name of names) {
    indegree.set(name, 0);
    adjacency.set(name, []);
  }
  const edgeSeen = new Set<string>();
  for (const edge of topology.edges) {
    if (!names.has(edge.from) || !names.has(edge.to)) {
      throw new InvalidTopologyError(`edge ${edge.from}->${edge.to} references unknown stage`);
    }
    const pair = `${edge.from}->${edge.to}`;
    if (edgeSeen.has(pair)) {
      throw new InvalidTopologyError(`duplicate edge ${pair}`);
    }
    edgeSeen.add(pair);
    const fromKind = topology.stages.find((s) => s.name === edge.from)?.kind;
    const toKind = topology.stages.find((s) => s.name === edge.to)?.kind;
    if (fromKind === "sink") {
      throw new InvalidTopologyError(`sink stage ${edge.from} cannot have outgoing edges`);
    }
    if (toKind === "source") {
      throw new InvalidTopologyError(`source stage ${edge.to} cannot have incoming edges`);
    }
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  // Kahn's algorithm — rejects cycles.
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift() as string;
    visited++;
    for (const next of adjacency.get(node) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited !== names.size) {
    throw new InvalidTopologyError("topology contains a cycle");
  }
  if (!topology.stages.some((s) => s.kind === "source")) {
    throw new InvalidTopologyError("topology needs at least one source");
  }
  if (!topology.stages.some((s) => s.kind === "sink")) {
    throw new InvalidTopologyError("topology needs at least one sink");
  }
}

function topologyEqual(a: Topology, b: Topology): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Re-export for callers that want a single import entry point.
export { sameRecord };
export type {
  RecordId,
  Topology,
  SinkReport,
  SourcePositionExplanation,
  StoreStats,
  CompactStats,
};
