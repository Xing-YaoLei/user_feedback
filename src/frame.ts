/**
 * Binary gRPC-Web frame reader.
 *
 * Wire format per frame:
 *
 *     +--------+------------------+------------------+
 *     | flag   | length (u32 BE)  | payload          |
 *     | 1 byte | 4 bytes          | `length` bytes   |
 *     +--------+------------------+------------------+
 *
 * Flag bit 0 (0x01) is the compressed bit and flag bit 7 (0x80) marks a
 * trailer frame.  Only uncompressed data frames (0x00) and uncompressed
 * trailer frames (0x80) are accepted; any other flag is either an unsupported
 * compression or a malformed frame.
 *
 * Input arrives in arbitrary chunk boundaries, so the reader keeps a growable
 * byte queue and only hands out complete frames.
 */

import { LimitError, ProtocolError, UnsupportedCompressionError } from './errors.ts';

export const FLAG_DATA = 0x00;
export const FLAG_TRAILER = 0x80;
export const FLAG_COMPRESSED = 0x01;

export const HEADER_SIZE = 5;

/** Initial capacity of the pending-bytes buffer. */
const INITIAL_CAPACITY = 8 * 1024;

export type FrameEvent =
  | { readonly kind: 'message'; readonly payload: Buffer }
  | { readonly kind: 'trailer'; readonly payload: Buffer };

export interface FrameReaderOptions {
  readonly maxMessageSize: number;
  readonly maxTrailerSize: number;
}

export class FrameReader {
  /** Pending bytes live in `#buffer[#start, #end)`. */
  #buffer: Buffer = Buffer.alloc(INITIAL_CAPACITY);
  #start = 0;
  #end = 0;
  readonly #maxMessageSize: number;
  readonly #maxTrailerSize: number;

  constructor(options: FrameReaderOptions) {
    this.#maxMessageSize = options.maxMessageSize;
    this.#maxTrailerSize = options.maxTrailerSize;
  }

  /** Bytes received but not yet consumed as a complete frame. */
  get bufferedBytes(): number {
    return this.#end - this.#start;
  }

  /** Append raw frame-stream bytes, copying them into the pending buffer. */
  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#ensureCapacity(chunk.length);
    // Copy: the caller owns `chunk` and may reuse or mutate it afterwards.
    this.#buffer.set(chunk, this.#end);
    this.#end += chunk.length;
  }

  /**
   * Validate the next frame header without consuming it.  Returns null when
   * fewer than five bytes are buffered.  Compression, flag and size problems
   * are raised here, i.e. as soon as the header arrives, so an unsupported or
   * oversized frame is rejected before its payload is buffered.
   */
  peekHeader(): { flag: number; length: number } | null {
    if (this.bufferedBytes < HEADER_SIZE) return null;
    const flag = this.#buffer[this.#start]!;
    const length = this.#buffer.readUInt32BE(this.#start + 1);

    if ((flag & FLAG_COMPRESSED) !== 0) {
      throw new UnsupportedCompressionError(
        `frame flag 0x${flag.toString(16).padStart(2, '0')} sets the compressed bit; ` +
          'only uncompressed data frames and uncompressed trailer frames are supported',
      );
    }
    if (flag !== FLAG_DATA && flag !== FLAG_TRAILER) {
      throw new ProtocolError(
        `unsupported frame flag 0x${flag.toString(16).padStart(2, '0')}; ` +
          'expected 0x00 (data frame) or 0x80 (trailer frame)',
        'MALFORMED_FRAME',
      );
    }
    if (flag === FLAG_TRAILER) {
      if (length > this.#maxTrailerSize) {
        throw new LimitError(
          `trailer frame payload is ${length} bytes, exceeding the ` +
            `${this.#maxTrailerSize}-byte trailer limit`,
          'TRAILER_TOO_LARGE',
        );
      }
    } else if (length > this.#maxMessageSize) {
      throw new LimitError(
        `message frame payload is ${length} bytes, exceeding the ` +
          `${this.#maxMessageSize}-byte message limit`,
        'MESSAGE_TOO_LARGE',
      );
    }
    return { flag, length };
  }

  /**
   * Consume and return the next complete frame, or null when more bytes are
   * needed.  Header problems throw immediately (see `peekHeader`).
   */
  next(): FrameEvent | null {
    const header = this.peekHeader();
    if (header === null) return null;
    if (this.bufferedBytes < HEADER_SIZE + header.length) return null;

    const payloadStart = this.#start + HEADER_SIZE;
    const payloadEnd = payloadStart + header.length;
    // Copy out so the payload does not pin the pending buffer.
    const payload = Buffer.from(this.#buffer.subarray(payloadStart, payloadEnd));

    this.#start = payloadEnd;
    if (this.#start === this.#end) {
      this.#start = 0;
      this.#end = 0;
    }
    this.#compactIfWorthwhile();

    return header.flag === FLAG_TRAILER
      ? { kind: 'trailer', payload }
      : { kind: 'message', payload };
  }

  /** Make room for `extra` more bytes. */
  #ensureCapacity(extra: number): void {
    if (this.#end + extra <= this.#buffer.length) return;

    const pending = this.bufferedBytes;
    // Move pending bytes to the front first; that often frees enough space.
    if (this.#start > 0) {
      this.#buffer.copyWithin(0, this.#start, this.#end);
      this.#start = 0;
      this.#end = pending;
      if (this.#end + extra <= this.#buffer.length) return;
    }

    let capacity = Math.max(this.#buffer.length, INITIAL_CAPACITY);
    while (capacity < this.#end + extra) capacity *= 2;
    const grown = Buffer.allocUnsafe(capacity);
    this.#buffer.copy(grown, 0, 0, this.#end);
    this.#buffer = grown;
  }

  /** Drop a large consumed prefix so it does not stay allocated forever. */
  #compactIfWorthwhile(): void {
    if (this.#start >= 64 * 1024 && this.#start >= this.#buffer.length / 2) {
      const pending = this.bufferedBytes;
      this.#buffer.copyWithin(0, this.#start, this.#end);
      this.#start = 0;
      this.#end = pending;
      if (this.#buffer.length > 4 * INITIAL_CAPACITY && pending * 4 < this.#buffer.length) {
        this.#buffer = Buffer.from(this.#buffer.subarray(0, pending));
      }
    }
  }
}

/**
 * Encode one frame (utility for tests, examples and mock servers).  The
 * decoder is strict about the flag byte, so callers must pass `FLAG_DATA` or
 * `FLAG_TRAILER` themselves.
 */
export function encodeFrame(flag: number, payload: Uint8Array): Buffer {
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header[0] = flag;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
