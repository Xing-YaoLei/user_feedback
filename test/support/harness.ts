import {
  encodeRequestBlockFrame,
  parseFrame,
  type EncodableBlockField,
  type KeyValue,
  type MetadataDecoder,
  type MetadataEncoder,
  type ParsedFrame,
} from "../../src/index.ts";

/**
 * Two-channel harness.
 *
 * The dictionary channel and the block channel are separate FIFO queues.
 * Nothing forces them to be drained together: a test can deliver every block
 * before any dictionary instruction, deliver them in lockstep, or interleave
 * arbitrarily.  Within each channel order is always preserved.
 */
export class FrameBus {
  readonly dictionaryQueue: Uint8Array[] = [];
  readonly blockQueue: Uint8Array[] = [];
  readonly dictionaryLog: Uint8Array[] = [];
  readonly blockLog: Uint8Array[] = [];

  readonly encoder: MetadataEncoder;
  readonly decoder: MetadataDecoder;

  /** Every frame ever put on the wire, tagged with its channel. */
  readonly wireLog: { channel: "dictionary" | "block"; frame: Uint8Array }[] = [];

  constructor(encoder: MetadataEncoder, decoder: MetadataDecoder) {
    this.encoder = encoder;
    this.decoder = decoder;
  }

  enqueue(encoded: {
    blockFrame: Uint8Array;
    dictionaryFrames: Uint8Array[];
  }): this {
    for (const frame of encoded.dictionaryFrames) {
      this.dictionaryQueue.push(frame);
      this.dictionaryLog.push(frame);
      this.wireLog.push({ channel: "dictionary", frame });
    }
    this.blockQueue.push(encoded.blockFrame);
    this.blockLog.push(encoded.blockFrame);
    this.wireLog.push({ channel: "block", frame: encoded.blockFrame });
    return this;
  }

  get pendingFrames(): number {
    return this.dictionaryQueue.length + this.blockQueue.length;
  }

  deliverDictionary(): boolean {
    const frame = this.dictionaryQueue.shift();
    if (frame === undefined) return false;
    this.decoder.receiveDictionaryFrame(frame);
    return true;
  }

  deliverBlock(): boolean {
    const frame = this.blockQueue.shift();
    if (frame === undefined) return false;
    this.decoder.receiveBlockFrame(frame);
    return true;
  }

  deliverDictionaryFrame(frame: Uint8Array): void {
    this.decoder.receiveDictionaryFrame(frame);
  }

  deliverBlockFrame(frame: Uint8Array): void {
    this.decoder.receiveBlockFrame(frame);
  }

  drainDictionary(): number {
    let count = 0;
    while (this.deliverDictionary()) count += 1;
    return count;
  }

  drainBlocks(): number {
    let count = 0;
    while (this.deliverBlock()) count += 1;
    return count;
  }

  /** Drains both channels in a caller-chosen order until both are empty. */
  drain(order: "dictionary-first" | "block-first" | "alternate" = "alternate"): void {
    let turn = 0;
    while (this.pendingFrames > 0) {
      const preferDictionary =
        order === "dictionary-first" ||
        (order === "alternate" && turn % 2 === 0);
      const stepped = preferDictionary
        ? this.deliverDictionary() || this.deliverBlock()
        : this.deliverBlock() || this.deliverDictionary();
      if (!stepped) break;
      turn += 1;
    }
  }

  /**
   * Moves every acknowledgement the decoder has queued back to the encoder,
   * preserving the order in which the decoder produced them.
   */
  pumpAcks(): number {
    const frames = this.decoder.drainAcks();
    for (const frame of frames) this.encoder.receiveAck(frame);
    return frames.length;
  }

  /** Decodes the queued frames and exchanges feedback until quiescent. */
  settle(): void {
    for (let round = 0; round < 64; round += 1) {
      this.drain("dictionary-first");
      const acks = this.pumpAcks();
      if (acks === 0 && this.pendingFrames === 0) return;
    }
    throw new Error("harness did not settle; a channel is still busy");
  }

  /** Replays previously logged frames, e.g. after a decoder restart. */
  replayDictionaryLog(target: MetadataDecoder = this.decoder): void {
    for (const frame of this.dictionaryLog) target.receiveDictionaryFrame(frame);
  }

  replayBlockLog(target: MetadataDecoder = this.decoder): void {
    for (const frame of this.blockLog) target.receiveBlockFrame(frame);
  }
}

/** Byte length of the same block encoded with literal fields only. */
export function literalBlockByteLength(blockId: number, entries: readonly KeyValue[]): number {
  const fields: EncodableBlockField[] = entries.map((entry) => ({
    kind: "literal",
    key: entry.key,
    value: entry.value,
  }));
  return encodeRequestBlockFrame({ blockId, fields }).byteLength;
}

export function parse(frame: Uint8Array): ParsedFrame {
  return parseFrame(frame);
}

export function referenceFields(frame: Uint8Array): { slot: number; generation: number }[] {
  const parsed = parseFrame(frame);
  if (parsed.type !== "block") throw new Error("not a block frame");
  return parsed.fields
    .filter((field) => field.kind === "reference")
    .map((field) => ({ slot: field.slot, generation: field.generation }));
}

export function blockFields(frame: Uint8Array) {
  const parsed = parseFrame(frame);
  if (parsed.type !== "block") throw new Error("not a block frame");
  return parsed.fields;
}

/** Deterministic PRNG (mulberry32) so interleaving scenarios are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}
