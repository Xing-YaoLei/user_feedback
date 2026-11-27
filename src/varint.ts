/**
 * Strict 64-bit varint and zig-zag primitives.
 *
 * Wire values are always represented as `bigint`, so no precision is lost even
 * for values above Number.MAX_SAFE_INTEGER.
 */

import { ProtobufRewriteError } from './errors.ts';

export interface VarintResult {
  readonly value: bigint;
  readonly next: number;
}

export interface VarintContext {
  /** Start offset of the enclosing field (tag byte), for diagnostics. */
  readonly fieldStart?: number;
  /** Field number of the enclosing field, for diagnostics. */
  readonly fieldNumber?: number;
}

/**
 * Read a protobuf varint from `start`, never reading at or past `boundary`.
 *
 * Error offsets:
 *   - TRUNCATED: `offset` is the first byte position that does not exist.
 *   - VARINT_OVERFLOW: `offset` is the offending tenth byte.
 * `context.fieldStart` always points at the start of the enclosing field.
 */
export function readVarint(
  buffer: Uint8Array,
  start: number,
  boundary: number,
  context: VarintContext = {},
): VarintResult {
  const fieldStart = context.fieldStart ?? start;
  const fieldNumber = context.fieldNumber ?? null;
  let value = 0n;

  for (let index = 0; index < 10; index += 1) {
    const position = start + index;
    if (position >= boundary) {
      throw new ProtobufRewriteError(
        'TRUNCATED',
        `Truncated varint starting at byte ${start}: data ends at byte ${boundary}`,
        { offset: position, fieldStart, fieldNumber },
      );
    }

    const byte = buffer[position] as number;

    if (index === 9) {
      // The tenth group contributes bits 63..69. Only 0 or 1 are representable
      // in a uint64; anything larger (including a continuation bit) overflows.
      if (byte > 0x01) {
        throw new ProtobufRewriteError(
          'VARINT_OVERFLOW',
          `Varint starting at byte ${start} overflows 64 bits at byte ${position}`,
          { offset: position, fieldStart, fieldNumber },
        );
      }
      value |= BigInt(byte) << 63n;
      return { value, next: position + 1 };
    }

    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) {
      return { value, next: position + 1 };
    }
  }

  // Unreachable: the tenth byte either terminates or overflows above.
  throw new ProtobufRewriteError(
    'VARINT_OVERFLOW',
    `Varint starting at byte ${start} overflows 64 bits`,
    { offset: start + 9, fieldStart, fieldNumber },
  );
}

/** Encode an unsigned 64-bit value as a canonical varint. */
export function encodeVarint(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new ProtobufRewriteError(
      'INVALID_REPLACEMENT',
      `Varint value ${value.toString()} is outside the uint64 range`,
    );
  }

  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0n);

  return Buffer.from(bytes);
}

/** Convert a signed int64 to its unsigned zig-zag representation. */
export function encodeZigZag64(value: bigint): bigint {
  return BigInt.asUintN(64, (value << 1n) ^ (value >> 63n));
}

/** Convert an unsigned zig-zag representation back to a signed int64. */
export function decodeZigZag64(value: bigint): bigint {
  return BigInt.asIntN(64, (value >> 1n) ^ -(value & 1n));
}

export function readFixed64(buffer: Uint8Array, start: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(buffer[start + index] as number);
  }
  return value;
}

export function readFixed32(buffer: Uint8Array, start: number): bigint {
  const b0 = buffer[start] as number;
  const b1 = buffer[start + 1] as number;
  const b2 = buffer[start + 2] as number;
  const b3 = buffer[start + 3] as number;
  // `>>> 0` keeps the result unsigned even when the top bit is set.
  return BigInt((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0);
}

export function encodeFixed64(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}
