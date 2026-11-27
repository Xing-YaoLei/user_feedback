/**
 * Test-only protobuf encoding helpers.
 *
 * These are deliberately hand-rolled so the tests do not depend on the
 * implementation under test. They also give us exact control over
 * non-canonical encodings (which must be preserved verbatim).
 */

export function tag(fieldNumber: number, wireType: number): Buffer {
  return varint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

export function varint(value: bigint | number): Buffer {
  let remaining = typeof value === 'number' ? BigInt(value) : value;
  if (remaining < 0n) {
    remaining = BigInt.asUintN(64, remaining);
  }
  const bytes: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

/** Intentionally over-long (non-canonical) varint: value padded to `width` bytes. */
export function paddedVarint(value: number, width: number): Buffer {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  for (let index = 0; index < width - 1; index += 1) {
    bytes.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining & 0x7fn));
  return Buffer.from(bytes);
}

export function zigzag64(value: bigint): Buffer {
  return varint(BigInt.asUintN(64, (value << 1n) ^ (value >> 63n)));
}

export function fixed64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export function fixed32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

export function delimited(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 2), varint(payload.length), payload]);
}

export function utf8Field(fieldNumber: number, text: string): Buffer {
  return delimited(fieldNumber, Buffer.from(text, 'utf8'));
}

export function varintField(fieldNumber: number, value: bigint | number): Buffer {
  return Buffer.concat([tag(fieldNumber, 0), varint(value)]);
}

export function fixed64Field(fieldNumber: number, value: bigint): Buffer {
  return Buffer.concat([tag(fieldNumber, 1), fixed64(value)]);
}

export function fixed32Field(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([tag(fieldNumber, 5), fixed32(value)]);
}

export interface RawField {
  fieldNumber: number;
  wireType: number;
  start: number;
  payload: Buffer;
  raw: Buffer;
}

/** Independent minimal scanner used to assert byte-level output layout. */
export function scan(buffer: Buffer): RawField[] {
  const result: RawField[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = cursor;
    const { value: rawTag, next: afterTag } = readVarintAt(buffer, cursor);
    const fieldNumber = Number(rawTag >> 3n);
    const wireType = Number(rawTag & 7n);
    cursor = afterTag;

    let payload: Buffer;

    if (wireType === 0) {
      const { next } = readVarintAt(buffer, cursor);
      payload = buffer.subarray(cursor, next);
      cursor = next;
    } else if (wireType === 1) {
      payload = buffer.subarray(cursor, cursor + 8);
      cursor += 8;
    } else if (wireType === 2) {
      const { value: size, next } = readVarintAt(buffer, cursor);
      cursor = next;
      payload = buffer.subarray(cursor, cursor + Number(size));
      cursor += Number(size);
    } else if (wireType === 5) {
      payload = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    } else {
      throw new Error(`scan: unsupported wire type ${wireType}`);
    }

    result.push({ fieldNumber, wireType, start, payload, raw: buffer.subarray(start, cursor) });
  }

  return result;
}

export function readVarintAt(buffer: Buffer, start: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = start;

  for (;;) {
    if (cursor >= buffer.length) throw new Error('readVarintAt: truncated');
    const byte = buffer[cursor]!;
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
  }
}
