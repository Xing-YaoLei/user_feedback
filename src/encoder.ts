import {
  encodeEvictFrame,
  encodeInsertFrame,
  encodeRequestBlockFrame,
  literalFieldByteLength,
  parseFrame,
  referenceFieldByteLength,
  utf8ByteLength,
  varintByteLength,
  type EncodableBlockField,
  type ParsedBlockAckFrame,
  type ParsedEntryAckFrame,
  type ParsedFrame,
  type SlotRef,
} from "./wire.ts";

export interface KeyValue {
  key: string;
  value: string;
}

export type FrameChannel = "dictionary" | "block";

export const DEFAULT_PEER_MAX_BLOCKED_BLOCKS = 8;

export interface EncoderOptions {
  /** Maximum total UTF-8 bytes of dictionary keys plus values. */
  maxDictionaryBytes: number;
  /** Optional fixed slot count. Omit for an unbounded number of slots. */
  maxSlots?: number;
  /**
   * Number of request blocks the peer is willing to withhold while waiting
   * for dictionary entries.  A block may reference an entry the peer has not
   * acknowledged yet only while this many blocked blocks are in flight.
   */
  peerMaxBlockedBlocks?: number;
  /** Observes every emitted frame, in emission order, along with its channel. */
  onFrame?: (channel: FrameChannel, frame: Uint8Array) => void;
}

export interface EncodedMetadataBlock {
  /** Stable id for this block, reused verbatim in acknowledgements. */
  blockId: number;
  blockFrame: Uint8Array;
  /** Dictionary instructions that must be delivered for this block to decode. */
  dictionaryFrames: Uint8Array[];
  blockByteLength: number;
  dictionaryByteLength: number;
  totalByteLength: number;
  /** Size the request block would have had with literal fields only. */
  literalEquivalentBlockByteLength: number;
}

export interface EncoderMetrics {
  blocksEncoded: number;
  dictionaryFramesEmitted: number;
  dictionaryBytesEmitted: number;
  blockBytesEmitted: number;
  totalBytesEmitted: number;
  insertedEntries: number;
  evictedEntries: number;
  literalFields: number;
  referencedFields: number;
  /** Current dictionary occupancy in UTF-8 key+value bytes. */
  dictionaryBytes: number;
  dictionaryCapacity: number;
  dictionaryEntryCount: number;
  /** Outstanding blocks currently waiting on unacknowledged entries. */
  blockedBlockCount: number;
  peerMaxBlockedBlocks: number;
  receivedEntryAcks: number;
  receivedBlockAcks: number;
  duplicateAcksIgnored: number;
  staleAcksIgnored: number;
}

export interface EncoderProtectionReport {
  slot: number;
  generation: number;
  key: string;
  value: string;
  byteCost: number;
  acknowledged: boolean;
  /** Number of reference occurrences across outstanding blocks. */
  referenceCount: number;
  /** Blocks whose outstanding decode keeps this entry unevictable. */
  protectingBlockIds: number[];
}

export interface EncoderEntrySnapshot {
  slot: number;
  generation: number;
  key: string;
  value: string;
  byteCost: number;
  acknowledged: boolean;
  lastUsedTick: number;
}

export interface AckApplyResult {
  applied: boolean;
  type: "entry-ack" | "block-ack" | "ignored";
  reason?: string;
}

interface EncoderEntry {
  slot: number;
  generation: number;
  key: string;
  value: string;
  byteCost: number;
  lastUsedTick: number;
  acknowledged: boolean;
  /** blockId -> number of references the block holds to this entry. */
  protectedBy: Map<number, number>;
}

interface BlockRefRecord {
  slot: number;
  generation: number;
  count: number;
}

interface EncoderBlockRecord {
  blockId: number;
  refs: Map<string, BlockRefRecord>;
  acknowledged: boolean;
  outcome?: "decoded" | "abandoned";
}

const INFINITE = Number.POSITIVE_INFINITY;

function pairKey(slot: number, generation: number): string {
  return `${slot}:${generation}`;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`);
  return value;
}

function validateInteger(value: unknown, what: string, minimum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${what} must be an integer >= ${minimum}`);
  }
}

/**
 * Encoder side of the metadata dictionary codec.
 *
 * The encoder owns the dictionary contents and produces two independent frame
 * streams: dictionary instructions (insert/evict) and request blocks.  Its
 * central invariants are:
 *
 *  - an entry referenced by a block that has not been acknowledged is never
 *    evicted, so a withheld block can always be completed;
 *  - a reference to an entry the peer has not acknowledged is only emitted
 *    while fewer than `peerMaxBlockedBlocks` blocks are blocked;
 *  - a new entry is admitted only when the emitted insert is paid back by
 *    references that are cheaper than their literal encoding.
 */
export class MetadataEncoder {
  readonly #maxDictionaryBytes: number;
  readonly #maxSlots: number | undefined;
  readonly #peerMaxBlockedBlocks: number;
  readonly #onFrame: ((channel: FrameChannel, frame: Uint8Array) => void) | undefined;

  #entriesBySlot = new Map<number, EncoderEntry>();
  #index = new Map<string, Map<string, EncoderEntry>>();
  #observations = new Map<string, Map<string, number>>();
  #blocks = new Map<number, EncoderBlockRecord>();
  #slotGenerations = new Map<number, number>();
  #freeSlots: number[] = [];
  #nextSlot = 0;
  #dictionaryBytes = 0;
  #tick = 0;
  #nextBlockId = 1;

  #stats = {
    blocksEncoded: 0,
    dictionaryFramesEmitted: 0,
    dictionaryBytesEmitted: 0,
    blockBytesEmitted: 0,
    totalBytesEmitted: 0,
    insertedEntries: 0,
    evictedEntries: 0,
    literalFields: 0,
    referencedFields: 0,
    receivedEntryAcks: 0,
    receivedBlockAcks: 0,
    duplicateAcksIgnored: 0,
    staleAcksIgnored: 0,
  };

  constructor(options: EncoderOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("encoder options are required");
    }
    validateInteger(options.maxDictionaryBytes, "maxDictionaryBytes", 0);
    this.#maxDictionaryBytes = options.maxDictionaryBytes;

    if (options.maxSlots !== undefined) {
      validateInteger(options.maxSlots, "maxSlots", 0);
      this.#maxSlots = options.maxSlots;
      this.#freeSlots = Array.from({ length: options.maxSlots }, (_, index) => index);
      this.#nextSlot = options.maxSlots;
    }

    const allowance = options.peerMaxBlockedBlocks ?? DEFAULT_PEER_MAX_BLOCKED_BLOCKS;
    if (allowance !== INFINITE) {
      validateInteger(allowance, "peerMaxBlockedBlocks", 0);
    }
    this.#peerMaxBlockedBlocks = allowance;
    this.#onFrame = options.onFrame;
  }

  get dictionaryByteSize(): number {
    return this.#dictionaryBytes;
  }

  get dictionaryCapacity(): number {
    return this.#maxDictionaryBytes;
  }

  get dictionaryEntryCount(): number {
    return this.#entriesBySlot.size;
  }

  get peerMaxBlockedBlocks(): number {
    return this.#peerMaxBlockedBlocks;
  }

  get blockedBlockCount(): number {
    let count = 0;
    for (const block of this.#blocks.values()) {
      if (this.#blockWaitsOnEntry(block)) count += 1;
    }
    return count;
  }

  get freeSlotCount(): number {
    return this.#maxSlots === undefined ? INFINITE : this.#freeSlots.length;
  }

  /**
   * Encodes one request block.  Dictionary instructions needed by the block
   * are emitted first on the dictionary channel; the block itself goes on the
   * block channel.  Order and duplicate fields are preserved exactly.
   */
  encode(entries: readonly KeyValue[]): EncodedMetadataBlock {
    if (!Array.isArray(entries)) {
      throw new TypeError("encode expects an array of key/value entries");
    }
    const normalized: KeyValue[] = entries.map((entry, index) => {
      if (entry === null || typeof entry !== "object") {
        throw new TypeError(`entry ${index} must be an object with key and value`);
      }
      return {
        key: requireString(entry.key, `entry ${index} key`),
        value: requireString(entry.value, `entry ${index} value`),
      };
    });

    const inBlock = countPairs(normalized);
    const remaining = cloneCounts(inBlock);
    const blockId = this.#nextBlockId++;
    const block: EncoderBlockRecord = {
      blockId,
      refs: new Map(),
      acknowledged: false,
    };
    this.#blocks.set(blockId, block);

    const dictionaryFrames: Uint8Array[] = [];
    const fields: EncodableBlockField[] = [];
    let literalEquivalentBytes =
      3 + varintByteLength(blockId) + varintByteLength(normalized.length);

    for (const entry of normalized) {
      const { key, value } = entry;
      const literalCost = literalFieldByteLength(key, value);
      literalEquivalentBytes += literalCost;

      const remainingNow = takeRemaining(remaining, key, value);
      const priorObservations = this.#priorObservations(key, value);
      this.#observe(key, value);

      const existing = this.#lookup(key, value);
      if (existing !== undefined) {
        const refCost = referenceFieldByteLength(existing.slot, existing.generation);
        if (refCost < literalCost && this.#mayReference(block, existing)) {
          existing.lastUsedTick = this.#nextTick();
          fields.push({
            kind: "reference",
            slot: existing.slot,
            generation: existing.generation,
          });
          this.#recordReference(block, existing);
          this.#stats.referencedFields += 1;
          continue;
        }
        fields.push({ kind: "literal", key, value });
        this.#stats.literalFields += 1;
        continue;
      }

      // A brand-new pair is admitted only when its known uses pay back the
      // insert instruction: uses observed in earlier blocks plus uses left in
      // this block, the current one included.  The reference must also be
      // cheaper than its literal.  This keeps one-off metadata literal while
      // making repeated metadata actually shorter.
      const knownUses = priorObservations + remainingNow;
      const admission = this.#admissionCost(key, value);
      const savingsPerUse = literalCost - admission.referenceCost;
      const paysBack =
        knownUses >= 2 &&
        savingsPerUse > 0 &&
        knownUses * savingsPerUse > admission.insertCost;

      if (paysBack && this.#mayReference(block, undefined)) {
        const allocated = this.#allocateEntry(key, value, dictionaryFrames);
        if (allocated !== undefined) {
          fields.push({
            kind: "reference",
            slot: allocated.slot,
            generation: allocated.generation,
          });
          this.#recordReference(block, allocated);
          this.#stats.referencedFields += 1;
          continue;
        }
      }
      fields.push({ kind: "literal", key, value });
      this.#stats.literalFields += 1;
    }

    for (const frame of dictionaryFrames) this.#emit("dictionary", frame);
    const blockFrame = encodeRequestBlockFrame({ blockId, fields });
    this.#emit("block", blockFrame);

    const dictionaryByteLength = dictionaryFrames.reduce(
      (sum, frame) => sum + frame.byteLength,
      0,
    );
    this.#stats.blocksEncoded += 1;
    this.#stats.blockBytesEmitted += blockFrame.byteLength;

    return {
      blockId,
      blockFrame,
      dictionaryFrames,
      blockByteLength: blockFrame.byteLength,
      dictionaryByteLength,
      totalByteLength: blockFrame.byteLength + dictionaryByteLength,
      literalEquivalentBlockByteLength: literalEquivalentBytes,
    };
  }

  /**
   * Applies one feedback frame from the decoder.  Entry acknowledgements mark
   * a slot generation as known to the peer; block acknowledgements release
   * the block's references exactly once, and only for the exact slot
   * generation the block referenced, so stale feedback cannot affect a reused
   * slot.
   */
  receiveAck(frame: Uint8Array | ParsedFrame): AckApplyResult {
    const parsed = frame instanceof Uint8Array ? parseFrame(frame) : frame;
    if (parsed.type === "entry-ack") return this.#applyEntryAck(parsed);
    if (parsed.type === "block-ack") return this.#applyBlockAck(parsed);
    return { applied: false, type: "ignored", reason: `not an ack frame: ${parsed.type}` };
  }

  /** Explicit alias for the feedback direction. */
  receiveAckFrame(frame: Uint8Array | ParsedFrame): AckApplyResult {
    return this.receiveAck(frame);
  }

  getMetrics(): EncoderMetrics {
    return {
      ...this.#stats,
      dictionaryBytes: this.#dictionaryBytes,
      dictionaryCapacity: this.#maxDictionaryBytes,
      dictionaryEntryCount: this.#entriesBySlot.size,
      blockedBlockCount: this.blockedBlockCount,
      peerMaxBlockedBlocks: this.#peerMaxBlockedBlocks,
    };
  }

  /**
   * Reference-protection basis: for every dictionary entry, the outstanding
   * blocks that keep it from being evicted.  An entry with an empty
   * `protectingBlockIds` list is an eviction candidate.
   */
  referenceProtection(): EncoderProtectionReport[] {
    const report: EncoderProtectionReport[] = [];
    for (const entry of this.#entriesBySlot.values()) {
      let referenceCount = 0;
      for (const count of entry.protectedBy.values()) referenceCount += count;
      report.push({
        slot: entry.slot,
        generation: entry.generation,
        key: entry.key,
        value: entry.value,
        byteCost: entry.byteCost,
        acknowledged: entry.acknowledged,
        referenceCount,
        protectingBlockIds: [...entry.protectedBy.keys()].sort((a, b) => a - b),
      });
    }
    return report.sort((a, b) => a.slot - b.slot);
  }

  /** Slots that may currently be evicted: no outstanding block references them. */
  evictionCandidates(): SlotRef[] {
    const candidates: EncoderEntry[] = [];
    for (const entry of this.#entriesBySlot.values()) {
      if (entry.protectedBy.size === 0) candidates.push(entry);
    }
    return candidates
      .sort((a, b) => a.lastUsedTick - b.lastUsedTick)
      .map(({ slot, generation }) => ({ slot, generation }));
  }

  dictionarySnapshot(): EncoderEntrySnapshot[] {
    return [...this.#entriesBySlot.values()]
      .map((entry) => ({
        slot: entry.slot,
        generation: entry.generation,
        key: entry.key,
        value: entry.value,
        byteCost: entry.byteCost,
        acknowledged: entry.acknowledged,
        lastUsedTick: entry.lastUsedTick,
      }))
      .sort((a, b) => a.slot - b.slot);
  }

  getBlockState(blockId: number):
    | {
        blockId: number;
        acknowledged: boolean;
        outcome: "decoded" | "abandoned" | undefined;
        refs: SlotRef[];
      }
    | undefined {
    const block = this.#blocks.get(blockId);
    if (block === undefined) return undefined;
    return {
      blockId,
      acknowledged: block.acknowledged,
      outcome: block.outcome,
      refs: [...block.refs.values()].map(({ slot, generation }) => ({ slot, generation })),
    };
  }

  #nextTick(): number {
    this.#tick += 1;
    return this.#tick;
  }

  #priorObservations(key: string, value: string): number {
    return this.#observations.get(key)?.get(value) ?? 0;
  }

  #observe(key: string, value: string): void {
    let values = this.#observations.get(key);
    if (values === undefined) {
      values = new Map();
      this.#observations.set(key, values);
    }
    values.set(value, (values.get(value) ?? 0) + 1);
  }

  #lookup(key: string, value: string): EncoderEntry | undefined {
    return this.#index.get(key)?.get(value);
  }

  #predictedSlot(): number {
    if (this.#freeSlots.length > 0) {
      let best = this.#freeSlots[0];
      for (const slot of this.#freeSlots) if (slot < best) best = slot;
      return best;
    }
    return this.#nextSlot;
  }

  #admissionCost(key: string, value: string): { insertCost: number; referenceCost: number } {
    const slot = this.#predictedSlot();
    const generation = (this.#slotGenerations.get(slot) ?? 0) + 1;
    const keyBytes = utf8ByteLength(key);
    const valueBytes = utf8ByteLength(value);
    return {
      insertCost:
        3 +
        varintByteLength(slot) +
        varintByteLength(generation) +
        varintByteLength(keyBytes) +
        keyBytes +
        varintByteLength(valueBytes) +
        valueBytes,
      referenceCost: 1 + varintByteLength(slot) + varintByteLength(generation),
    };
  }

  /**
   * Whether `block` may add a reference to `entry` (or to a new entry when
   * `entry` is undefined).  References to acknowledged entries are always
   * allowed; references to unacknowledged entries require blocked-block quota.
   */
  #mayReference(block: EncoderBlockRecord, entry: EncoderEntry | undefined): boolean {
    if (entry !== undefined && entry.acknowledged) return true;
    if (this.#peerMaxBlockedBlocks === INFINITE) return true;
    if (this.#blockWaitsOnEntry(block)) return true;
    let others = 0;
    for (const other of this.#blocks.values()) {
      if (other.blockId === block.blockId) continue;
      if (this.#blockWaitsOnEntry(other)) others += 1;
    }
    return others < this.#peerMaxBlockedBlocks;
  }

  /** True when the block is outstanding and references an unacknowledged entry. */
  #blockWaitsOnEntry(block: EncoderBlockRecord): boolean {
    if (block.acknowledged) return false;
    for (const ref of block.refs.values()) {
      const entry = this.#entriesBySlot.get(ref.slot);
      if (
        entry !== undefined &&
        entry.generation === ref.generation &&
        !entry.acknowledged
      ) {
        return true;
      }
    }
    return false;
  }

  #recordReference(block: EncoderBlockRecord, entry: EncoderEntry): void {
    const key = pairKey(entry.slot, entry.generation);
    const record = block.refs.get(key);
    if (record === undefined) {
      block.refs.set(key, { slot: entry.slot, generation: entry.generation, count: 1 });
    } else {
      record.count += 1;
    }
    entry.protectedBy.set(block.blockId, (entry.protectedBy.get(block.blockId) ?? 0) + 1);
  }

  /**
   * Allocates a slot with a fresh generation for `key`/`value`, evicting only
   * unprotected entries.  Returns undefined when the entry cannot fit or no
   * space can be reclaimed, in which case the caller emits a literal.
   */
  #allocateEntry(
    key: string,
    value: string,
    dictionaryFrames: Uint8Array[],
  ): EncoderEntry | undefined {
    const byteCost = utf8ByteLength(key) + utf8ByteLength(value);
    if (byteCost > this.#maxDictionaryBytes) return undefined;

    const victims = this.#planVictims(byteCost);
    if (victims === undefined) return undefined;

    for (const victim of victims) {
      dictionaryFrames.push(
        encodeEvictFrame({ slot: victim.slot, generation: victim.generation }),
      );
      this.#removeEntry(victim);
      this.#stats.evictedEntries += 1;
    }

    let slot: number;
    if (this.#freeSlots.length > 0) {
      let bestIndex = 0;
      for (let index = 1; index < this.#freeSlots.length; index += 1) {
        if (this.#freeSlots[index] < this.#freeSlots[bestIndex]) bestIndex = index;
      }
      slot = this.#freeSlots.splice(bestIndex, 1)[0];
    } else if (this.#maxSlots === undefined) {
      slot = this.#nextSlot++;
    } else {
      return undefined;
    }

    const generation = (this.#slotGenerations.get(slot) ?? 0) + 1;
    this.#slotGenerations.set(slot, generation);

    const entry: EncoderEntry = {
      slot,
      generation,
      key,
      value,
      byteCost,
      lastUsedTick: this.#nextTick(),
      acknowledged: false,
      protectedBy: new Map(),
    };
    this.#entriesBySlot.set(slot, entry);
    let values = this.#index.get(key);
    if (values === undefined) {
      values = new Map();
      this.#index.set(key, values);
    }
    values.set(value, entry);
    this.#dictionaryBytes += byteCost;

    dictionaryFrames.push(encodeInsertFrame({ slot, generation, key, value }));
    this.#stats.insertedEntries += 1;
    return entry;
  }

  #planVictims(byteCost: number): EncoderEntry[] | undefined {
    const needSlot = this.#maxSlots !== undefined && this.#freeSlots.length === 0;
    if (!needSlot && this.#dictionaryBytes + byteCost <= this.#maxDictionaryBytes) {
      return [];
    }
    const candidates: EncoderEntry[] = [];
    for (const entry of this.#entriesBySlot.values()) {
      if (entry.protectedBy.size === 0) candidates.push(entry);
    }
    candidates.sort((a, b) => a.lastUsedTick - b.lastUsedTick);

    const victims: EncoderEntry[] = [];
    let freedBytes = 0;
    for (const candidate of candidates) {
      victims.push(candidate);
      freedBytes += candidate.byteCost;
      const bytesFit = freedBytes + byteCost <= this.#maxDictionaryBytes;
      const slotFreed = !needSlot || victims.length >= 1;
      if (bytesFit && slotFreed) return victims;
    }
    return undefined;
  }

  #removeEntry(entry: EncoderEntry): void {
    if (this.#entriesBySlot.get(entry.slot) === entry) {
      this.#entriesBySlot.delete(entry.slot);
    }
    const values = this.#index.get(entry.key);
    if (values !== undefined && values.get(entry.value) === entry) {
      values.delete(entry.value);
      if (values.size === 0) this.#index.delete(entry.key);
    }
    this.#dictionaryBytes -= entry.byteCost;
    if (!this.#freeSlots.includes(entry.slot)) this.#freeSlots.push(entry.slot);
  }

  #emit(channel: FrameChannel, frame: Uint8Array): void {
    if (channel === "dictionary") {
      this.#stats.dictionaryFramesEmitted += 1;
      this.#stats.dictionaryBytesEmitted += frame.byteLength;
    }
    this.#stats.totalBytesEmitted += frame.byteLength;
    if (this.#onFrame !== undefined) this.#onFrame(channel, frame);
  }

  #applyEntryAck(frame: ParsedEntryAckFrame): AckApplyResult {
    const entry = this.#entriesBySlot.get(frame.slot);
    if (entry === undefined || entry.generation !== frame.generation) {
      this.#stats.staleAcksIgnored += 1;
      return { applied: false, type: "entry-ack", reason: "no entry with that slot generation" };
    }
    if (entry.acknowledged) {
      this.#stats.duplicateAcksIgnored += 1;
      return { applied: false, type: "entry-ack", reason: "duplicate entry ack" };
    }
    entry.acknowledged = true;
    this.#stats.receivedEntryAcks += 1;
    return { applied: true, type: "entry-ack" };
  }

  #applyBlockAck(frame: ParsedBlockAckFrame): AckApplyResult {
    const block = this.#blocks.get(frame.blockId);
    if (block === undefined) {
      this.#stats.staleAcksIgnored += 1;
      return { applied: false, type: "block-ack", reason: "unknown block id" };
    }
    if (block.acknowledged) {
      this.#stats.duplicateAcksIgnored += 1;
      return { applied: false, type: "block-ack", reason: "duplicate block ack" };
    }
    block.acknowledged = true;
    block.outcome = frame.outcome;
    this.#stats.receivedBlockAcks += 1;

    // Release exactly once, and only for the exact slot generation this block
    // referenced.  A slot that has since been reused has a different
    // generation, so the entry now living there is untouched.
    for (const ref of block.refs.values()) {
      const entry = this.#entriesBySlot.get(ref.slot);
      if (entry === undefined || entry.generation !== ref.generation) continue;
      const remaining = (entry.protectedBy.get(block.blockId) ?? 0) - ref.count;
      if (remaining > 0) entry.protectedBy.set(block.blockId, remaining);
      else entry.protectedBy.delete(block.blockId);
    }
    return { applied: true, type: "block-ack" };
  }
}

function countPairs(entries: readonly KeyValue[]): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    let values = counts.get(entry.key);
    if (values === undefined) {
      values = new Map();
      counts.set(entry.key, values);
    }
    values.set(entry.value, (values.get(entry.value) ?? 0) + 1);
  }
  return counts;
}

function cloneCounts(source: Map<string, Map<string, number>>): Map<string, Map<string, number>> {
  const copy = new Map<string, Map<string, number>>();
  for (const [key, values] of source) copy.set(key, new Map(values));
  return copy;
}

function takeRemaining(
  counts: Map<string, Map<string, number>>,
  key: string,
  value: string,
): number {
  const values = counts.get(key);
  const remaining = values?.get(value) ?? 0;
  if (values !== undefined && remaining > 0) values.set(value, remaining - 1);
  return remaining;
}
