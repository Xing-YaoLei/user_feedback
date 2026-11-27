import type { DecodedBlock, MetadataDecoder } from "./decoder.ts";
import type { EncodedMetadataBlock, MetadataEncoder } from "./encoder.ts";
import type { SlotRef } from "./wire.ts";

export interface LinkOptions {
  /**
   * When true, acknowledgements queued by the decoder are handed back to the
   * encoder automatically after each delivery step.  Default true.
   */
  autoPumpAcks?: boolean;
  /** Invoked for every frame put on a channel, with its channel name. */
  onFrame?: (channel: "dictionary" | "block" | "feedback", frame: Uint8Array) => void;
}

export interface DeliveryResult {
  dictionaryFramesDelivered: number;
  blocksDelivered: number;
  decoded: DecodedBlock[];
  acksPumped: number;
}

/**
 * A caller-side adapter that models the transport: two independent FIFO
 * channels plus a feedback path.
 *
 * Each channel preserves its own order.  `deliver` lets the caller choose how
 * much of each channel to release, which is how cross-channel overtaking is
 * expressed:
 *
 *   link.send(block);            // enqueue dictionary frames + block frame
 *   link.deliverBlocks();        // block overtakes its dictionary frames
 *   link.deliverDictionary();    // dictionary catches up, blocks resume
 *
 * The link never reorders frames within a channel.
 */
export class TwoChannelLink {
  readonly #encoder: MetadataEncoder;
  readonly #decoder: MetadataDecoder;
  readonly #autoPumpAcks: boolean;
  readonly #onFrame: LinkOptions["onFrame"] | undefined;

  readonly #dictionaryQueue: Uint8Array[] = [];
  readonly #blockQueue: Uint8Array[] = [];

  constructor(encoder: MetadataEncoder, decoder: MetadataDecoder, options: LinkOptions = {}) {
    this.#encoder = encoder;
    this.#decoder = decoder;
    this.#autoPumpAcks = options.autoPumpAcks ?? true;
    this.#onFrame = options.onFrame;
  }

  /** Enqueues one encoded block and the dictionary frames it depends on. */
  send(block: EncodedMetadataBlock): void {
    for (const frame of block.dictionaryFrames) {
      this.#dictionaryQueue.push(frame);
      this.#onFrame?.("dictionary", frame);
    }
    this.#blockQueue.push(block.blockFrame);
    this.#onFrame?.("block", block.blockFrame);
  }

  /** Encodes `entries` and immediately enqueues the resulting frames. */
  encodeAndSend(entries: readonly { key: string; value: string }[]): EncodedMetadataBlock {
    const block = this.#encoder.encode(entries);
    this.send(block);
    return block;
  }

  get pendingDictionaryFrames(): number {
    return this.#dictionaryQueue.length;
  }

  get pendingBlockFrames(): number {
    return this.#blockQueue.length;
  }

  get pending(): number {
    return this.#dictionaryQueue.length + this.#blockQueue.length;
  }

  /** Delivers at most `count` dictionary instructions in channel order. */
  deliverDictionary(count = Number.POSITIVE_INFINITY): number {
    let delivered = 0;
    while (delivered < count && this.#dictionaryQueue.length > 0) {
      const frame = this.#dictionaryQueue.shift() as Uint8Array;
      this.#decoder.receiveDictionaryFrame(frame);
      delivered += 1;
    }
    if (this.#autoPumpAcks) this.pumpAcks();
    return delivered;
  }

  /** Delivers at most `count` request blocks in channel order. */
  deliverBlocks(count = Number.POSITIVE_INFINITY): number {
    let delivered = 0;
    while (delivered < count && this.#blockQueue.length > 0) {
      const frame = this.#blockQueue.shift() as Uint8Array;
      this.#decoder.receiveBlockFrame(frame);
      delivered += 1;
    }
    if (this.#autoPumpAcks) this.pumpAcks();
    return delivered;
  }

  /** Delivers everything currently queued, dictionary channel first. */
  flush(): DeliveryResult {
    const dictionaryFramesDelivered = this.deliverDictionary();
    const blocksDelivered = this.deliverBlocks();
    const acksPumped = this.pumpAcks();
    return {
      dictionaryFramesDelivered,
      blocksDelivered,
      decoded: this.#decoder.decodedBlocks(),
      acksPumped,
    };
  }

  /** Hands every queued decoder acknowledgement back to the encoder. */
  pumpAcks(): number {
    const frames = this.#decoder.drainAcks();
    for (const frame of frames) {
      this.#onFrame?.("feedback", frame);
      this.#encoder.receiveAck(frame);
    }
    return frames.length;
  }

  /** Abandons a withheld block and forwards the abandon ack to the encoder. */
  cancelBlock(blockId: number): { acknowledged: boolean; frame?: Uint8Array } {
    const result = this.#decoder.cancelBlock(blockId);
    if (result.frame !== undefined) {
      this.#onFrame?.("feedback", result.frame);
    }
    if (this.#autoPumpAcks) this.pumpAcks();
    return result;
  }

  blockedBlockIds(): number[] {
    return this.#decoder.pendingBlockIds;
  }

  /** Refuses evicting entries still referenced by withheld blocks. */
  protectedSlots(): { slot: number; generation: number; blockingBlockIds: number[] }[] {
    return this.#decoder.protectedSlots();
  }

  /** Converges: drains both channels and feedback until nothing is pending. */
  settle(maxRounds = 128): void {
    for (let round = 0; round < maxRounds; round += 1) {
      if (this.pending === 0 && this.pumpAcks() === 0) return;
      this.deliverDictionary();
      this.deliverBlocks();
    }
    throw new Error("two-channel link did not settle");
  }

  /** Reference sets for a decoded block, useful for assertions in callers. */
  static refsOf(block: DecodedBlock): SlotRef[] {
    return block.refs.map((ref) => ({ ...ref }));
  }
}
