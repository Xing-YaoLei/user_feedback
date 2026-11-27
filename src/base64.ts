/**
 * Incremental decoder for grpc-web-text response bodies.
 *
 * grpc-web-text is standard base64 over the binary frame stream.  Producers
 * differ in how they segment the encoding:
 *
 *  - some encode the stream once, so padding appears only at the very end;
 *  - some encode each write separately and concatenate the results, so several
 *    independently padded base64 segments appear back to back.
 *
 * Segment boundaries have nothing to do with gRPC frame boundaries, and an
 * input chunk may split a quartet, a padding run, a frame header or a trailer
 * line anywhere.  The decoder therefore keeps only the partial quartet (and a
 * pending padding expectation) between calls and resets at every padding
 * sequence.  Decoded bytes are emitted as soon as they exist.
 *
 * ASCII whitespace (SP, HTAB, CR, LF) between base64 characters is ignored,
 * which matches servers that wrap long text bodies.
 */

import { ProtocolError } from './errors.ts';
import type { GrpcWebErrorCode } from './errors.ts';

const PAD = 0x3d; // '='

const BASE64_VALUES = (() => {
  const table = new Int16Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

function base64Error(message: string, code: GrpcWebErrorCode = 'MALFORMED_BASE64'): ProtocolError {
  return new ProtocolError(message, code);
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

export class Base64StreamDecoder {
  /** Six-bit values of the current, not yet complete quartet (0..3 values). */
  #quartet = new Uint8Array(4);
  #quartetLength = 0;
  /** Number of trailing '=' characters still expected. */
  #expectPad = 0;
  #finished = false;
  /** Global count of base64 characters consumed, for error messages. */
  #position = 0;

  /** True when no partial quartet or padding is pending. */
  get atSegmentBoundary(): boolean {
    return this.#quartetLength === 0 && this.#expectPad === 0;
  }

  /**
   * Feed raw body bytes (ASCII base64 text) and return the bytes decoded from
   * this chunk.  Throws `ProtocolError` on an invalid character or misplaced
   * padding.
   */
  feed(input: Uint8Array): Buffer {
    if (this.#finished) {
      throw base64Error('base64 body received data after the input ended');
    }

    // Every base64 character yields at most 3/4 of a byte; reserving the input
    // length is a safe upper bound.
    const out = Buffer.allocUnsafe(Math.ceil((input.length * 3) / 4) + 3);
    let outLength = 0;

    for (let i = 0; i < input.length; i++) {
      const byte = input[i]!;
      if (isWhitespace(byte)) continue;

      if (this.#expectPad > 0) {
        if (byte !== PAD) {
          throw base64Error(
            `base64 padding at position ${this.#position} is incomplete (expected '=')`,
          );
        }
        this.#position++;
        this.#expectPad--;
        if (this.#expectPad === 0) {
          outLength = this.#flushQuartet(out, outLength);
        }
        continue;
      }

      if (byte === PAD) {
        this.#position++;
        const q = this.#quartet;
        const n = this.#quartetLength;
        if (n === 2) {
          // "xx==" -> one byte, emitted after the second '='.
          this.#expectPad = 1;
          continue;
        }
        if (n === 3) {
          // "xxx=" -> two bytes; the quartet is complete.
          outLength = this.#flushQuartet(out, outLength);
          continue;
        }
        throw base64Error(
          `base64 padding at position ${this.#position} follows ${n} base64 character(s); ` +
            'padding is only valid after 2 or 3 characters',
        );
      }

      const value = byte < 128 ? BASE64_VALUES[byte]! : -1;
      if (value < 0) {
        throw base64Error(
          `invalid base64 character 0x${byte.toString(16).padStart(2, '0')} at position ${this.#position}`,
        );
      }
      this.#position++;
      this.#quartet[this.#quartetLength++] = value;
      if (this.#quartetLength === 4) {
        outLength = this.#flushQuartet(out, outLength);
      }
    }

    return out.subarray(0, outLength);
  }

  /**
   * Signal the end of the body.  A dangling partial quartet or an unfinished
   * padding run means the body was truncated.
   */
  end(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#expectPad > 0) {
      throw base64Error('base64 body ended in the middle of a padding run', 'TRUNCATED_INPUT');
    }
    if (this.#quartetLength !== 0) {
      throw base64Error(
        `base64 body ended after ${this.#quartetLength} of 4 characters in a quartet`,
        'TRUNCATED_INPUT',
      );
    }
  }

  #flushQuartet(out: Buffer, outLength: number): number {
    const q = this.#quartet;
    switch (this.#quartetLength) {
      case 4:
        out[outLength++] = (q[0]! << 2) | (q[1]! >> 4);
        out[outLength++] = ((q[1]! & 0x0f) << 4) | (q[2]! >> 2);
        out[outLength++] = ((q[2]! & 0x03) << 6) | q[3]!;
        break;
      case 3:
        out[outLength++] = (q[0]! << 2) | (q[1]! >> 4);
        out[outLength++] = ((q[1]! & 0x0f) << 4) | (q[2]! >> 2);
        break;
      case 2:
        out[outLength++] = (q[0]! << 2) | (q[1]! >> 4);
        break;
      default:
        throw base64Error('internal error: flushed an empty base64 quartet');
    }
    this.#quartetLength = 0;
    return outLength;
  }
}

/** Encode bytes as one padded base64 segment (convenience for tests/tools). */
export function encodeBase64Segment(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
