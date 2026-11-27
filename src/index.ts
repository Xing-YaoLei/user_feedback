export {
  FRAME_MAGIC,
  FRAME_VERSION,
  FrameType,
  AckOutcome,
  ProtocolError,
  encodeInsertFrame,
  encodeEvictFrame,
  encodeRequestBlockFrame,
  encodeBlockAckFrame,
  encodeEntryAckFrame,
  parseFrame,
  utf8Encode,
  utf8Decode,
  utf8ByteLength,
  varintByteLength,
  literalFieldByteLength,
  referenceFieldByteLength,
} from "./wire.ts";

export type {
  FrameTypeValue,
  AckOutcomeValue,
  SlotRef,
  ParsedInsertFrame,
  ParsedEvictFrame,
  ParsedBlockField,
  ParsedBlockFrame,
  ParsedBlockAckFrame,
  ParsedEntryAckFrame,
  ParsedFrame,
  EncodableBlockField,
} from "./wire.ts";

export {
  MetadataEncoder,
  DEFAULT_PEER_MAX_BLOCKED_BLOCKS,
} from "./encoder.ts";
export type {
  KeyValue,
  FrameChannel,
  EncoderOptions,
  EncodedMetadataBlock,
  EncoderMetrics,
  EncoderProtectionReport,
  EncoderEntrySnapshot,
  AckApplyResult,
} from "./encoder.ts";

export { MetadataDecoder, DEFAULT_MAX_BLOCKED_BLOCKS } from "./decoder.ts";
export type {
  DecoderOptions,
  DecodedBlock,
  BlockedBlockReport,
  ProtectedSlotReport,
  DeferredEvictionReport,
  DecoderMetrics,
} from "./decoder.ts";

export { TwoChannelLink } from "./link.ts";
export type { LinkOptions, DeliveryResult } from "./link.ts";

import { MetadataEncoder, type EncoderOptions } from "./encoder.ts";
import { MetadataDecoder, type DecoderOptions } from "./decoder.ts";
import { TwoChannelLink, type LinkOptions } from "./link.ts";

/**
 * Convenience pairing for local transports and tests.  The two channels stay
 * separate so the caller controls interleaving.
 */
export function createCodecPair(
  options: { encoder?: EncoderOptions; decoder?: DecoderOptions } = {},
): { encoder: MetadataEncoder; decoder: MetadataDecoder } {
  return {
    encoder: new MetadataEncoder(options.encoder ?? { maxDictionaryBytes: 1024 }),
    decoder: new MetadataDecoder(options.decoder ?? {}),
  };
}

/**
 * Creates a matched encoder/decoder pair plus a two-channel link.  The
 * decoder's advertised blocked-block allowance is propagated to the encoder so
 * both sides agree on the quota.
 */
export function createLinkedCodec(
  options: {
    maxDictionaryBytes?: number;
    maxSlots?: number;
    maxBlockedBlocks?: number;
    link?: LinkOptions;
  } = {},
): { encoder: MetadataEncoder; decoder: MetadataDecoder; link: TwoChannelLink } {
  const decoder = new MetadataDecoder({
    maxBlockedBlocks: options.maxBlockedBlocks,
    maxDictionaryBytes: options.maxDictionaryBytes,
  });
  const encoder = new MetadataEncoder({
    maxDictionaryBytes: options.maxDictionaryBytes ?? 1024,
    maxSlots: options.maxSlots,
    peerMaxBlockedBlocks: decoder.advertisedMaxBlockedBlocks,
  });
  return { encoder, decoder, link: new TwoChannelLink(encoder, decoder, options.link) };
}
