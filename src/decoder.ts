import {
  ProtocolError,
  encodeBlockAckFrame,
  encodeEntryAckFrame,
  parseFrame,
  utf8ByteLength,
  type ParsedBlockFrame,
  type ParsedFrame,
  type SlotRef,
} from "./wire.ts";

export interface KeyValue {
  key: string;
  value: string;
}

export const DEFAULT_MAX_BLOCKED_BLOCKS = 8;

export interface DecoderOptions {
  /**
   * Capacity reported alongside dictionary occupancy.  Purely informational;
   * eviction decisions belong to the encoder.
   */
  maxDictionaryBytes?: number;
  /**
   * How many blocked request blocks this decoder will withhold while waiting
   * for dictionary instructions.  The encoder must be configured with the same
   * number as `peerMaxBlockedBlocks`.
   */
  maxBlockedBlocks?: number;
  /**
   * What to do with a request block that would exceed `maxBlockedBlocks`:
   * abandon it immediately (default) or keep withholding it beyond the limit.
   */
  overLimitPolicy?: "abandon" | "allow";
  /** Emit an entry acknowledgement once an insert is applied. Default true. */
  autoAcknowledgeEntries?: boolean;
  onAck?: (frame: Uint8Array) => void;
}

export interface DecodedBlock {
  blockId: number;
  entries: KeyValue[];
  refs: SlotRef[];
}

export interface BlockedBlockReport {
  blockId: number;
  /** References that cannot be resolved from the current dictionary. */
  missing: SlotRef[];
  /** Every dictionary reference the block makes. */
  referenced: SlotRef[];
}

export interface ProtectedSlotReport {
  slot: number;
  generation: number;
  /** Withheld blocks that reference this exact slot generation. */
  blockingBlockIds: number[];
}

export interface DeferredEvictionReport {
  slot: number;
  generation: number;
  /** Withheld blocks that keep this entry alive. */
  blockingBlockIds: number[];
}

export interface DecoderMetrics {
  blocksReceived: number;
  blocksDecoded: number;
  blocksAbandoned: number;
  blocksRejectedOverLimit: number;
  duplicateBlocksIgnored: number;
  blockedBlockCount: number;
  maxBlockedBlocks: number;
  dictionaryBytes: number;
  dictionaryCapacity: number;
  dictionaryEntryCount: number;
  literalFields: number;
  referencedFields: number;
  entryAcksEmitted: number;
  blockAcksEmitted: number;
  deferredEvictions: number;
}

interface DecoderEntry {
  slot: number;
  generation: number;
  key: string;
  value: string;
  byteCost: number;
}

interface PendingBlock {
  frame: ParsedBlockFrame;
  missing: SlotRef[];
}

interface DeferredEviction {
  slot: number;
  generation: number;
}

function pairKey(slot: number, generation: number): string {
  return `${slot}:${generation}`;
}

/**
 * Decoder side of the metadata dictionary codec.
 *
 * Dictionary instructions and request blocks arrive on two independent,
 * individually ordered channels, so a request block may precede the
 * dictionary inserts it needs.  Such a block is withheld rather than failed;
 * the decoder retries withheld blocks whenever a dictionary instruction is
 * applied.  Dictionary instructions are always processed, even while blocks
 * are withheld.
 *
 * A withheld block's entries are protected from eviction: an evict that would
 * remove a referenced entry is deferred until the block is decoded or
 * abandoned, then applied.
 */
export class MetadataDecoder {
  readonly #maxDictionaryBytes: number | undefined;
  readonly #maxBlockedBlocks: number;
  readonly #overLimitPolicy: "abandon" | "allow";
  readonly #autoAck: boolean;
  readonly #onAck: ((frame: Uint8Array) => void) | undefined;

  #dictionary = new Map<number, DecoderEntry>();
  #dictionaryBytes = 0;
  #pending = new Map<number, PendingBlock>();
  #decoded = new Map<number, DecodedBlock>();
  #abandoned = new Set<number>();
  #deferredEvictions: DeferredEviction[] = [];
  #acknowledgedEntries = new Set<string>();
  #outbound: Uint8Array[] = [];

  #stats = {
    blocksReceived: 0,
    blocksDecoded: 0,
    blocksAbandoned: 0,
    blocksRejectedOverLimit: 0,
    duplicateBlocksIgnored: 0,
    literalFields: 0,
    referencedFields: 0,
    entryAcksEmitted: 0,
    blockAcksEmitted: 0,
    deferredEvictions: 0,
  };

  constructor(options: DecoderOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("decoder options must be an object");
    }
    if (options.maxDictionaryBytes !== undefined) {
      if (
        typeof options.maxDictionaryBytes !== "number" ||
        !Number.isSafeInteger(options.maxDictionaryBytes) ||
        options.maxDictionaryBytes < 0
      ) {
        throw new RangeError("maxDictionaryBytes must be a non-negative integer");
      }
      this.#maxDictionaryBytes = options.maxDictionaryBytes;
    }
    const limit = options.maxBlockedBlocks ?? DEFAULT_MAX_BLOCKED_BLOCKS;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("maxBlockedBlocks must be a non-negative integer");
    }
    this.#maxBlockedBlocks = limit;

    const policy = options.overLimitPolicy ?? "abandon";
    if (policy !== "abandon" && policy !== "allow") {
      throw new TypeError('overLimitPolicy must be "abandon" or "allow"');
    }
    this.#overLimitPolicy = policy;
    this.#autoAck = options.autoAcknowledgeEntries ?? true;
    this.#onAck = options.onAck;
  }

  get blockedBlockCount(): number {
    return this.#pending.size;
  }

  get pendingBlockIds(): number[] {
    return [...this.#pending.keys()].sort((a, b) => a - b);
  }

  get dictionaryBytes(): number {
    return this.#dictionaryBytes;
  }

  get dictionaryEntryCount(): number {
    return this.#dictionary.size;
  }

  /** Blocked-block allowance this decoder advertises to its encoder. */
  get advertisedMaxBlockedBlocks(): number {
    return this.#maxBlockedBlocks;
  }

  /** Same value under a plainer name, for wiring into the encoder. */
  get maxBlockedBlocks(): number {
    return this.#maxBlockedBlocks;
  }

  /**
   * Applies one frame from the dictionary channel (insert or evict).  Returns
   * every request block that became decodable as a result.  Safe to call at
   * any time, including while request blocks are withheld.
   */
  receiveDictionaryFrame(frame: Uint8Array | ParsedFrame): DecodedBlock[] {
    const parsed = toParsed(frame);
    if (parsed.type === "insert") {
      this.#applyInsert(parsed.slot, parsed.generation, parsed.key, parsed.value);
    } else if (parsed.type === "evict") {
      this.#applyEvict(parsed.slot, parsed.generation);
    } else {
      throw new TypeError(
        `dictionary channel received a ${parsed.type} frame; expected insert or evict`,
      );
    }
    return this.#retryPending();
  }

  /**
   * Applies one frame from the request-block channel.  Returns the decoded
   * block, or undefined when the block is withheld, ignored as a duplicate, or
   * rejected for exceeding the blocked-block allowance.
   */
  receiveBlockFrame(frame: Uint8Array | ParsedFrame): DecodedBlock | undefined {
    const parsed = toParsed(frame);
    if (parsed.type !== "block") {
      throw new TypeError(`block channel received a ${parsed.type} frame; expected a block`);
    }
    if (this.#decoded.has(parsed.blockId) || this.#abandoned.has(parsed.blockId)) {
      this.#stats.duplicateBlocksIgnored += 1;
      return undefined;
    }
    if (this.#pending.has(parsed.blockId)) {
      this.#stats.duplicateBlocksIgnored += 1;
      return undefined;
    }

    const refs = collectRefs(parsed);
    const missing = unresolvedRefs(refs, (ref) => this.#resolve(ref) !== undefined);
    if (missing.length === 0) {
      this.#stats.blocksReceived += 1;
      return this.#decode(parsed);
    }

    if (
      this.#overLimitPolicy === "abandon" &&
      this.#pending.size >= this.#maxBlockedBlocks
    ) {
      // Refusing to withhold beyond the advertised allowance: the block is
      // abandoned outright and the encoder is told to release its references.
      this.#stats.blocksReceived += 1;
      this.#stats.blocksRejectedOverLimit += 1;
      this.#abandoned.add(parsed.blockId);
      this.#emitBlockAck(parsed.blockId, "abandoned", refs);
      return undefined;
    }

    this.#stats.blocksReceived += 1;
    this.#pending.set(parsed.blockId, { frame: parsed, missing });
    return undefined;
  }

  /**
   * Routes a frame to a channel explicitly, or infers the channel from its
   * type when none is given.
   */
  receive(frame: Uint8Array | ParsedFrame, channel?: "dictionary" | "block"): DecodedBlock[] {
    const parsed = toParsed(frame);
    const target =
      channel ??
      (parsed.type === "insert" || parsed.type === "evict" ? "dictionary" : "block");
    if (target === "dictionary") return this.receiveDictionaryFrame(parsed);
    const decoded = this.receiveBlockFrame(parsed);
    return decoded === undefined ? [] : [decoded];
  }

  /**
   * Abandons a withheld block and emits an abandon acknowledgement.  No
   * metadata is produced for the block.  Cancelling an already-decided block
   * is a no-op, so repeated cancellation releases encoder references once.
   */
  cancelBlock(blockId: number): { acknowledged: boolean; frame?: Uint8Array } {
    if (this.#decoded.has(blockId) || this.#abandoned.has(blockId)) {
      this.#stats.duplicateBlocksIgnored += 1;
      return { acknowledged: false };
    }
    const pending = this.#pending.get(blockId);
    if (pending === undefined) return { acknowledged: false };
    this.#pending.delete(blockId);
    this.#abandoned.add(blockId);
    this.#stats.blocksAbandoned += 1;
    const frame = this.#emitBlockAck(blockId, "abandoned", collectRefs(pending.frame));
    this.#releaseDeferredEvictions();
    return { acknowledged: true, frame };
  }

  /** Abandons every withheld block, returning the emitted ack frames. */
  cancelAllBlocked(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const blockId of this.pendingBlockIds) {
      const result = this.cancelBlock(blockId);
      if (result.frame !== undefined) frames.push(result.frame);
    }
    return frames;
  }

  /** Retries every withheld block against the current dictionary. */
  retryBlocked(): DecodedBlock[] {
    return this.#retryPending();
  }

  hasDecodedBlock(blockId: number): boolean {
    return this.#decoded.has(blockId);
  }

  getDecodedBlock(blockId: number): DecodedBlock | undefined {
    return this.#decoded.get(blockId);
  }

  decodedBlocks(): DecodedBlock[] {
    return [...this.#decoded.values()].sort((a, b) => a.blockId - b.blockId);
  }

  blockedBlocks(): BlockedBlockReport[] {
    return [...this.#pending.entries()]
      .map(([blockId, pending]) => ({
        blockId,
        missing: pending.missing.map((ref) => ({ ...ref })),
        referenced: collectRefs(pending.frame),
      }))
      .sort((a, b) => a.blockId - b.blockId);
  }

  /**
   * Reference-protection basis: entries held alive only because a withheld
   * block references that exact slot generation.
   */
  protectedSlots(): ProtectedSlotReport[] {
    const protection = new Map<string, ProtectedSlotReport>();
    for (const [blockId, pending] of this.#pending) {
      for (const ref of collectRefs(pending.frame)) {
        if (this.#resolve(ref) === undefined) continue;
        const key = pairKey(ref.slot, ref.generation);
        const existing = protection.get(key);
        if (existing === undefined) {
          protection.set(key, {
            slot: ref.slot,
            generation: ref.generation,
            blockingBlockIds: [blockId],
          });
        } else if (!existing.blockingBlockIds.includes(blockId)) {
          existing.blockingBlockIds.push(blockId);
        }
      }
    }
    return [...protection.values()]
      .map((report) => ({
        ...report,
        blockingBlockIds: report.blockingBlockIds.sort((a, b) => a - b),
      }))
      .sort((a, b) => a.slot - b.slot || a.generation - b.generation);
  }

  /** Evictions postponed because a withheld block still needs the entry. */
  deferredEvictions(): DeferredEvictionReport[] {
    const reports: DeferredEvictionReport[] = [];
    for (const eviction of this.#deferredEvictions) {
      const blocking = new Set<number>();
      for (const [blockId, pending] of this.#pending) {
        for (const ref of collectRefs(pending.frame)) {
          if (ref.slot === eviction.slot && ref.generation === eviction.generation) {
            blocking.add(blockId);
          }
        }
      }
      reports.push({
        slot: eviction.slot,
        generation: eviction.generation,
        blockingBlockIds: [...blocking].sort((a, b) => a - b),
      });
    }
    return reports.sort((a, b) => a.slot - b.slot || a.generation - b.generation);
  }

  /** Drains acknowledgement frames queued for the encoder, in order. */
  drainAcks(): Uint8Array[] {
    const frames = this.#outbound;
    this.#outbound = [];
    return frames;
  }

  getMetrics(): DecoderMetrics {
    return {
      ...this.#stats,
      blockedBlockCount: this.#pending.size,
      maxBlockedBlocks: this.#maxBlockedBlocks,
      dictionaryBytes: this.#dictionaryBytes,
      dictionaryCapacity: this.#maxDictionaryBytes ?? Number.POSITIVE_INFINITY,
      dictionaryEntryCount: this.#dictionary.size,
    };
  }

  #applyInsert(slot: number, generation: number, key: string, value: string): void {
    const existing = this.#dictionary.get(slot);
    if (existing !== undefined) {
      if (existing.generation > generation) return; // stale replay
      if (existing.generation === generation) return; // idempotent replay
      // A newer generation replaces the slot, but a withheld block may still
      // need the generation being replaced.  Refuse to drop it from under the
      // block: report the conflict instead of corrupting a pending decode.
      if (this.#isEntryProtected(slot, existing.generation)) {
        throw new ProtocolError(
          `insert for slot ${slot} generation ${generation} would discard ` +
            `generation ${existing.generation}, still referenced by a withheld block`,
          "PROTECTED_GENERATION_REPLACED",
        );
      }
      this.#dictionaryBytes -= existing.byteCost;
    }
    const entry: DecoderEntry = {
      slot,
      generation,
      key,
      value,
      byteCost: utf8ByteLength(key) + utf8ByteLength(value),
    };
    this.#dictionary.set(slot, entry);
    this.#dictionaryBytes += entry.byteCost;

    if (this.#autoAck && !this.#acknowledgedEntries.has(pairKey(slot, generation))) {
      this.#acknowledgedEntries.add(pairKey(slot, generation));
      this.#queueAck(encodeEntryAckFrame({ slot, generation }), "entry");
    }
  }

  #applyEvict(slot: number, generation: number): void {
    const existing = this.#dictionary.get(slot);
    if (existing === undefined || existing.generation !== generation) return;

    if (this.#isEntryProtected(slot, generation)) {
      // Never remove an entry a withheld block still needs; remember it and
      // apply the eviction once that block is decided.
      if (
        !this.#deferredEvictions.some(
          (eviction) => eviction.slot === slot && eviction.generation === generation,
        )
      ) {
        this.#deferredEvictions.push({ slot, generation });
        this.#stats.deferredEvictions += 1;
      }
      return;
    }
    this.#dropEntry(slot);
  }

  #isEntryProtected(slot: number, generation: number): boolean {
    for (const pending of this.#pending.values()) {
      for (const ref of collectRefs(pending.frame)) {
        if (ref.slot === slot && ref.generation === generation) return true;
      }
    }
    return false;
  }

  #dropEntry(slot: number): void {
    const entry = this.#dictionary.get(slot);
    if (entry === undefined) return;
    this.#dictionary.delete(slot);
    this.#dictionaryBytes -= entry.byteCost;
  }

  #releaseDeferredEvictions(): void {
    if (this.#deferredEvictions.length === 0) return;
    const remaining: DeferredEviction[] = [];
    for (const eviction of this.#deferredEvictions) {
      const entry = this.#dictionary.get(eviction.slot);
      if (entry === undefined || entry.generation !== eviction.generation) continue;
      if (this.#isEntryProtected(eviction.slot, eviction.generation)) {
        remaining.push(eviction);
        continue;
      }
      this.#dropEntry(eviction.slot);
    }
    this.#deferredEvictions = remaining;
  }

  #resolve(ref: SlotRef): DecoderEntry | undefined {
    const entry = this.#dictionary.get(ref.slot);
    if (entry === undefined || entry.generation !== ref.generation) return undefined;
    return entry;
  }

  #retryPending(): DecodedBlock[] {
    const decoded: DecodedBlock[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [blockId, pending] of [...this.#pending]) {
        const missing = unresolvedRefs(
          collectRefs(pending.frame),
          (ref) => this.#resolve(ref) !== undefined,
        );
        if (missing.length > 0) {
          pending.missing = missing;
          continue;
        }
        this.#pending.delete(blockId);
        decoded.push(this.#decode(pending.frame));
        progressed = true;
      }
    }
    if (decoded.length > 0) this.#releaseDeferredEvictions();
    return decoded;
  }

  #decode(frame: ParsedBlockFrame): DecodedBlock {
    const entries: KeyValue[] = [];
    const refs: SlotRef[] = [];
    for (const field of frame.fields) {
      if (field.kind === "literal") {
        entries.push({ key: field.key, value: field.value });
        this.#stats.literalFields += 1;
        continue;
      }
      const entry = this.#resolve(field);
      if (entry === undefined) {
        throw new Error(
          `internal error: unresolved reference for block ${frame.blockId}`,
        );
      }
      entries.push({ key: entry.key, value: entry.value });
      refs.push({ slot: field.slot, generation: field.generation });
      this.#stats.referencedFields += 1;
    }
    const decoded: DecodedBlock = { blockId: frame.blockId, entries, refs };
    this.#decoded.set(frame.blockId, decoded);
    this.#stats.blocksDecoded += 1;
    this.#emitBlockAck(frame.blockId, "decoded", refs);
    return decoded;
  }

  #emitBlockAck(
    blockId: number,
    outcome: "decoded" | "abandoned",
    refs: SlotRef[],
  ): Uint8Array {
    const frame = encodeBlockAckFrame({ blockId, outcome, refs });
    this.#queueAck(frame, "block");
    return frame;
  }

  #queueAck(frame: Uint8Array, kind: "entry" | "block"): void {
    if (kind === "entry") this.#stats.entryAcksEmitted += 1;
    else this.#stats.blockAcksEmitted += 1;
    this.#outbound.push(frame);
    if (this.#onAck !== undefined) this.#onAck(frame);
  }
}

function collectRefs(frame: ParsedBlockFrame): SlotRef[] {
  const refs: SlotRef[] = [];
  for (const field of frame.fields) {
    if (field.kind === "reference") {
      refs.push({ slot: field.slot, generation: field.generation });
    }
  }
  return refs;
}

/** Missing references, de-duplicated by slot+generation but order-preserving. */
function unresolvedRefs(refs: readonly SlotRef[], isResolved: (ref: SlotRef) => boolean): SlotRef[] {
  const seen = new Set<string>();
  const missing: SlotRef[] = [];
  for (const ref of refs) {
    if (isResolved(ref)) continue;
    const key = pairKey(ref.slot, ref.generation);
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push({ slot: ref.slot, generation: ref.generation });
  }
  return missing;
}

function toParsed(frame: Uint8Array | ParsedFrame): ParsedFrame {
  if (frame instanceof Uint8Array) return parseFrame(frame);
  if (frame !== null && typeof frame === "object" && typeof frame.type === "string") {
    return frame;
  }
  throw new TypeError("expected a frame Uint8Array or a parsed frame object");
}
