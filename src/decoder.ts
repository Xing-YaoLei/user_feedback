/**
 * Incremental gRPC-Web response body decoder.
 *
 * The decoder consumes raw HTTP response-body bytes — the binary wire format
 * or grpc-web-text base64 — and produces, in arrival order:
 *
 *  - one `message` item per uncompressed data frame, and
 *  - exactly one `trailer` item, produced by `finish()` and only after the
 *    *entire* input has been validated: input ended, no truncated frame, no
 *    frame after the trailer, a well-formed trailer payload, and exactly one
 *    `grpc-status`.
 *
 * Because the trailer item never appears while bytes may still arrive, neither
 * "HTTP 200" nor "first message received" can be mistaken for success.
 *
 * Usage is pull based:
 *
 *     decoder.write(chunk);              // accept input (any chunking)
 *     for (let m = decoder.next(); m; m = decoder.next()) use(m.data);
 *     const trailer = decoder.finish();  // validates everything, returns trailer
 *
 * `write()` only buffers and base64-decodes; `next()` parses one frame per
 * call.  The decoder therefore keeps no queue of decoded messages: a consumer
 * that stops calling `next()` stops decoding, so a stream adapter can withhold
 * its write callback and propagate backpressure upstream.
 *
 * Limiting
 * --------
 * `maxUnparsedBytes` caps bytes buffered beyond the frames already consumed.
 * It is enforced whenever `next()` runs out of complete frames (and at
 * `finish()`), i.e. at every point where the remaining bytes are known to be an
 * incomplete frame or junk.  `maxMessageSize` caps a single data frame payload
 * and is enforced as soon as its header is available, before the payload is
 * buffered.  Both raise distinct error codes.
 *
 * The decoder is pure and single-threaded — no timers, sockets or global
 * mutable state — so any number of decoders can be interleaved freely.
 */

import { Base64StreamDecoder } from './base64.ts';
import { FrameReader, HEADER_SIZE } from './frame.ts';
import { GrpcStatusError, LimitError, ProtocolError } from './errors.ts';
import { parseTrailer, validateTrailer } from './trailer.ts';
import type { Trailer, ValidatedTrailer } from './trailer.ts';

export type GrpcWebMode = 'binary' | 'text';

export interface DecoderOptions {
  /** Body encoding: `binary` wire format or `text` (base64). Default `binary`. */
  readonly mode?: GrpcWebMode;
  /** Maximum payload of a single data frame. Default 4 MiB. */
  readonly maxMessageSize?: number;
  /** Maximum bytes buffered that have not been consumed as complete frames. Default 8 MiB. */
  readonly maxUnparsedBytes?: number;
  /** Maximum payload of the trailer frame. Default 64 KiB. */
  readonly maxTrailerSize?: number;
}

export interface MessageItem {
  readonly type: 'message';
  readonly data: Buffer;
}

export interface TrailerItem {
  readonly type: 'trailer';
  readonly status: number;
  readonly statusText: string;
  /** Percent-decoded grpc-message, or undefined when the field was absent. */
  readonly message: string | undefined;
  /** Raw grpc-message value, or undefined when the field was absent. */
  readonly rawMessage: string | undefined;
  readonly trailer: Trailer;
}

export type DecodedItem = MessageItem | TrailerItem;

export const DEFAULT_MAX_MESSAGE_SIZE = 4 * 1024 * 1024;
export const DEFAULT_MAX_UNPARSED_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_TRAILER_SIZE = 64 * 1024;

/** Input is decoded in bounded slices so one huge chunk is not copied whole. */
const INPUT_SLICE_BYTES = 64 * 1024;

function requirePositiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export class GrpcWebResponseDecoder {
  readonly mode: GrpcWebMode;
  readonly #frames: FrameReader;
  readonly #base64: Base64StreamDecoder | null;
  readonly #maxUnparsedBytes: number;

  #trailer: ValidatedTrailer | null = null;
  #ended = false;
  #succeeded = false;
  #bytesReceived = 0;
  #messagesEmitted = 0;

  constructor(options: DecoderOptions = {}) {
    const mode = options.mode ?? 'binary';
    if (mode !== 'binary' && mode !== 'text') {
      throw new TypeError(`mode must be "binary" or "text", got ${String(mode)}`);
    }
    this.mode = mode;

    this.#frames = new FrameReader({
      maxMessageSize: requirePositiveInteger(
        'maxMessageSize',
        options.maxMessageSize,
        DEFAULT_MAX_MESSAGE_SIZE,
      ),
      maxTrailerSize: requirePositiveInteger(
        'maxTrailerSize',
        options.maxTrailerSize,
        DEFAULT_MAX_TRAILER_SIZE,
      ),
    });
    this.#maxUnparsedBytes = requirePositiveInteger(
      'maxUnparsedBytes',
      options.maxUnparsedBytes,
      DEFAULT_MAX_UNPARSED_BYTES,
    );
    this.#base64 = mode === 'text' ? new Base64StreamDecoder() : null;
  }

  /** Total body bytes accepted by `write()`. */
  get bytesReceived(): number {
    return this.#bytesReceived;
  }

  /** Number of data messages produced so far. */
  get messagesEmitted(): number {
    return this.#messagesEmitted;
  }

  /** Bytes buffered that have not been consumed as complete frames. */
  get bufferedBytes(): number {
    return this.#frames.bufferedBytes;
  }

  /** True once a validated trailer frame has been parsed. */
  get trailerSeen(): boolean {
    return this.#trailer !== null;
  }

  /** True once the input ended and every check passed. */
  get finished(): boolean {
    return this.#succeeded;
  }

  /** True once `finish()` has been attempted (successfully or not). */
  get ended(): boolean {
    return this.#ended;
  }

  /**
   * Accept one body chunk of any size and with any internal split pattern.
   * Bytes are buffered and base64-decoded here; frames are parsed by `next()`.
   *
   * Throws `ProtocolError` / `UnsupportedCompressionError` / `LimitError` for
   * problems visible without completing a frame (an invalid base64 character,
   * a frame header with the compressed bit, an oversized declared length, ...).
   */
  write(chunk: Uint8Array): void {
    if (this.#ended) {
      throw new ProtocolError('received body bytes after the response body ended', 'MALFORMED_FRAME');
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('chunk must be a Uint8Array');
    }

    for (let offset = 0; offset < chunk.length; offset += INPUT_SLICE_BYTES) {
      const end = Math.min(offset + INPUT_SLICE_BYTES, chunk.length);
      const slice = chunk.subarray(offset, end);
      this.#bytesReceived += slice.length;

      const decoded: Uint8Array = this.#base64 ? this.#base64.feed(slice) : slice;
      if (decoded.length > 0) {
        this.#frames.append(decoded);
      }
      // Surface header-level problems (compression, flags, declared size) as
      // early as possible; `peekHeader` does not consume anything.
      this.#frames.peekHeader();
    }
  }

  /**
   * Pull the next data message, or null when no complete data frame is
   * buffered.  Trailer frames are consumed and validated here.
   */
  next(): MessageItem | null {
    for (;;) {
      const frame = this.#frames.next();
      if (frame === null) {
        // Nothing complete is buffered.  If the trailer was already seen, any
        // remaining bytes are a partial frame following it — already fatal.
        if (this.#trailer !== null && this.#frames.bufferedBytes > 0) {
          throw new ProtocolError(
            `input continues with ${this.#frames.bufferedBytes} byte(s) after the trailer frame; ` +
              'the trailer must be the last frame',
            'FRAME_AFTER_TRAILER',
          );
        }
        // Everything complete has been consumed; whatever remains is an
        // incomplete frame or junk, and is subject to the buffer limit.
        this.#checkUnparsedLimit();
        return null;
      }

      if (this.#trailer !== null) {
        throw new ProtocolError(
          'received a frame after the trailer frame; the trailer must be the last frame',
          'FRAME_AFTER_TRAILER',
        );
      }

      if (frame.kind === 'trailer') {
        this.#trailer = validateTrailer(parseTrailer(frame.payload));
        continue;
      }

      this.#messagesEmitted++;
      return { type: 'message', data: frame.payload };
    }
  }

  /**
   * End the input and validate the entire exchange.  Returns the single
   * trailer item only when every check passes; throws otherwise.
   *
   * Call `next()` until it returns null first; any complete frame left
   * buffered is reported as a caller error rather than silently dropped.
   */
  finish(): TrailerItem {
    if (this.#ended) {
      throw new ProtocolError('finish() was called more than once', 'MALFORMED_FRAME');
    }
    this.#ended = true;

    // A dangling base64 quartet or unfinished padding is truncated input.
    this.#base64?.end();

    const buffered = this.#frames.bufferedBytes;
    if (buffered !== 0) {
      this.#checkUnparsedLimit();
      // The trailer must be the last thing in the body.  Once it has been seen
      // and bytes remain — even a partial frame header — nothing can follow it.
      if (this.#trailer !== null) {
        throw new ProtocolError(
          `input continues with ${buffered} byte(s) after the trailer frame; ` +
            'the trailer must be the last frame',
          'FRAME_AFTER_TRAILER',
        );
      }
      const header = this.#frames.peekHeader();
      if (header !== null && buffered >= HEADER_SIZE + header.length) {
        throw new Error(
          `cannot finish with ${buffered} buffered byte(s) still forming a complete frame; ` +
            'call next() until it returns null before finish()',
        );
      }
      throw new ProtocolError(
        `input ended with ${buffered} unparsed byte(s); the frame stream is truncated ` +
          '(a frame header or payload was incomplete)',
        'TRUNCATED_INPUT',
      );
    }
    if (this.#trailer === null) {
      throw new ProtocolError(
        'response ended without a trailer frame; a gRPC call is not successful without grpc-status',
        'MISSING_TRAILER',
      );
    }

    this.#succeeded = true;
    return trailerItem(this.#trailer);
  }

  #checkUnparsedLimit(): void {
    const buffered = this.#frames.bufferedBytes;
    if (buffered > this.#maxUnparsedBytes) {
      throw new LimitError(
        `unparsed frame buffer grew to ${buffered} bytes, exceeding the ` +
          `${this.#maxUnparsedBytes}-byte limit`,
        'BUFFER_LIMIT_EXCEEDED',
      );
    }
  }
}

/** Convert a validated trailer into its public item shape. */
export function trailerItem(validated: ValidatedTrailer): TrailerItem {
  return {
    type: 'trailer',
    status: validated.status,
    statusText: validated.statusText,
    message: validated.grpcMessage,
    rawMessage: validated.rawGrpcMessage,
    trailer: validated.trailer,
  };
}

/** Result of decoding a complete in-memory response body. */
export interface DecodedResponse {
  readonly messages: Buffer[];
  readonly trailer: TrailerItem;
}

export interface DecodeOptions extends DecoderOptions {
  /**
   * Throw `GrpcStatusError` when the (well-formed) trailer carries a non-zero
   * status, instead of returning it on `trailer.status`.  Off by default: a
   * non-zero status is a decoded response, not a decoding failure.
   */
  readonly throwOnNonZeroStatus?: boolean;
}

/**
 * Decode an iterable of body chunks, collecting every message in order and the
 * final trailer.  Wire-format problems always throw.
 */
export function decodeChunks(
  chunks: Iterable<Uint8Array>,
  options: DecodeOptions = {},
): DecodedResponse {
  const decoder = new GrpcWebResponseDecoder(options);
  const messages: Buffer[] = [];
  const drain = (): void => {
    for (let item = decoder.next(); item !== null; item = decoder.next()) {
      messages.push(item.data);
    }
  };
  for (const chunk of chunks) {
    decoder.write(chunk);
    drain();
  }
  const trailer = decoder.finish();
  if (options.throwOnNonZeroStatus && trailer.status !== 0) {
    throw new GrpcStatusError(
      trailer.status,
      trailer.statusText,
      trailer.message,
      trailer.rawMessage,
      trailer.trailer,
    );
  }
  return { messages, trailer };
}

/** Convenience: decode one contiguous body buffer. */
export function decodeResponse(body: Uint8Array, options: DecodeOptions = {}): DecodedResponse {
  return decodeChunks([body], options);
}
