/**
 * Wire format for the metadata dictionary codec.
 *
 * A *frame* is always delivered as one whole Uint8Array.  Dictionary
 * instructions and request blocks use two independent channels; each channel
 * is ordered, but a request block may overtake the dictionary instruction it
 * depends on because the channels have no relative ordering.
 *
 * Common frame header:
 *
 *   magic(0x4d) version(0x01) type(byte) payload...
 *
 * All integers are unsigned LEB128 varints.  Strings are length-prefixed UTF-8
 * byte strings; the length is a byte count, not a UTF-16 code-unit count.
 */

export const FRAME_MAGIC = 0x4d;
export const FRAME_VERSION = 0x01;

export const FrameType = {
  Insert: 0x01,
  Evict: 0x02,
  RequestBlock: 0x10,
  BlockAck: 0x20,
  EntryAck: 0x21,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export const AckOutcome = {
  Decoded: 0,
  Abandoned: 1,
} as const;

export type AckOutcomeValue = "decoded" | "abandoned";

/** Error thrown for malformed frames and protocol invariant violations. */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(message: string, code = "PROTOCOL_ERROR") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export interface SlotRef {
  slot: number;
  generation: number;
}

export interface ParsedInsertFrame {
  type: "insert";
  slot: number;
  generation: number;
  key: string;
  value: string;
  keyByteLength: number;
  valueByteLength: number;
}

export interface ParsedEvictFrame {
  type: "evict";
  slot: number;
  generation: number;
}

export type ParsedBlockField =
  | { kind: "literal"; key: string; value: string }
  | { kind: "reference"; slot: number; generation: number };

export interface ParsedBlockFrame {
  type: "block";
  blockId: number;
  fields: ParsedBlockField[];
}

export interface ParsedBlockAckFrame {
  type: "block-ack";
  blockId: number;
  outcome: AckOutcomeValue;
  refs: SlotRef[];
}

export interface ParsedEntryAckFrame {
  type: "entry-ack";
  slot: number;
  generation: number;
}

export type ParsedFrame =
  | ParsedInsertFrame
  | ParsedEvictFrame
  | ParsedBlockFrame
  | ParsedBlockAckFrame
  | ParsedEntryAckFrame;

export type EncodableBlockField =
  | { kind: "literal"; key: string; value: string }
  | { kind: "reference"; slot: number; generation: number };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function utf8Decode(bytes: Uint8Array, what = "string"): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new ProtocolError(`invalid UTF-8 in ${what}`, "INVALID_UTF8");
  }
}

export function varintByteLength(value: number): number {
  assertSafeUnsigned(value, "varint");
  let length = 1;
  let rest = value;
  while (rest >= 0x80) {
    rest = Math.floor(rest / 0x80);
    length += 1;
  }
  return length;
}

export function literalFieldByteLength(key: string, value: string): number {
  const keyLength = utf8ByteLength(key);
  const valueLength = utf8ByteLength(value);
  return (
    1 +
    varintByteLength(keyLength) +
    keyLength +
    varintByteLength(valueLength) +
    valueLength
  );
}

export function referenceFieldByteLength(slot: number, generation: number): number {
  return 1 + varintByteLength(slot) + varintByteLength(generation);
}

function assertSafeUnsigned(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer, got ${value}`);
  }
}

class ByteWriter {
  #bytes: number[] = [];

  get length(): number {
    return this.#bytes.length;
  }

  writeByte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`byte out of range: ${value}`);
    }
    this.#bytes.push(value);
  }

  writeVarint(value: number): void {
    assertSafeUnsigned(value, "varint");
    let rest = value;
    do {
      let byte = rest % 0x80;
      rest = Math.floor(rest / 0x80);
      if (rest > 0) byte |= 0x80;
      this.#bytes.push(byte);
    } while (rest > 0);
  }

  writeBytes(value: Uint8Array): void {
    for (const byte of value) this.#bytes.push(byte);
  }

  writeString(value: string): void {
    if (typeof value !== "string") {
      throw new TypeError("string field must be a string");
    }
    const encoded = textEncoder.encode(value);
    this.writeVarint(encoded.byteLength);
    this.writeBytes(encoded);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

class ByteReader {
  #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("frame must be a Uint8Array");
    }
    this.#bytes = bytes;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  get done(): boolean {
    return this.#offset === this.#bytes.byteLength;
  }

  readByte(what: string): number {
    if (this.remaining < 1) {
      throw new ProtocolError(`truncated frame while reading ${what}`, "TRUNCATED_FRAME");
    }
    return this.#bytes[this.#offset++];
  }

  readVarint(what: string): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte(what);
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        assertSafeUnsigned(value, what);
        return value;
      }
      multiplier *= 0x80;
    }
    throw new ProtocolError(`varint too long while reading ${what}`, "MALFORMED_VARINT");
  }

  readBytes(length: number, what: string): Uint8Array {
    if (length > this.remaining) {
      throw new ProtocolError(`truncated frame while reading ${what}`, "TRUNCATED_FRAME");
    }
    const slice = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  readString(what: string): string {
    const length = this.readVarint(`${what} length`);
    const bytes = this.readBytes(length, what);
    return utf8Decode(bytes, what);
  }

  expectEnd(): void {
    if (!this.done) {
      throw new ProtocolError(
        `trailing bytes in frame (${this.remaining} byte(s) left)`,
        "TRAILING_BYTES",
      );
    }
  }
}

function finishFrame(type: number, payload: ByteWriter): Uint8Array {
  const frame = new ByteWriter();
  frame.writeByte(FRAME_MAGIC);
  frame.writeByte(FRAME_VERSION);
  frame.writeByte(type);
  frame.writeBytes(payload.toUint8Array());
  return frame.toUint8Array();
}

export function encodeInsertFrame(input: {
  slot: number;
  generation: number;
  key: string;
  value: string;
}): Uint8Array {
  const payload = new ByteWriter();
  payload.writeVarint(input.slot);
  payload.writeVarint(input.generation);
  payload.writeString(input.key);
  payload.writeString(input.value);
  return finishFrame(FrameType.Insert, payload);
}

export function encodeEvictFrame(input: {
  slot: number;
  generation: number;
}): Uint8Array {
  const payload = new ByteWriter();
  payload.writeVarint(input.slot);
  payload.writeVarint(input.generation);
  return finishFrame(FrameType.Evict, payload);
}

export function encodeRequestBlockFrame(input: {
  blockId: number;
  fields: readonly EncodableBlockField[];
}): Uint8Array {
  const payload = new ByteWriter();
  payload.writeVarint(input.blockId);
  payload.writeVarint(input.fields.length);
  for (const field of input.fields) {
    if (field.kind === "literal") {
      payload.writeByte(0x00);
      payload.writeString(field.key);
      payload.writeString(field.value);
    } else if (field.kind === "reference") {
      payload.writeByte(0x01);
      payload.writeVarint(field.slot);
      payload.writeVarint(field.generation);
    } else {
      throw new TypeError(`unknown block field kind: ${String((field as { kind?: unknown }).kind)}`);
    }
  }
  return finishFrame(FrameType.RequestBlock, payload);
}

export function encodeBlockAckFrame(input: {
  blockId: number;
  outcome: AckOutcomeValue;
  refs?: readonly SlotRef[];
}): Uint8Array {
  const refs = input.refs ?? [];
  const payload = new ByteWriter();
  payload.writeVarint(input.blockId);
  if (input.outcome === "decoded") payload.writeByte(AckOutcome.Decoded);
  else if (input.outcome === "abandoned") payload.writeByte(AckOutcome.Abandoned);
  else throw new TypeError(`unknown ack outcome: ${String(input.outcome)}`);
  payload.writeVarint(refs.length);
  for (const ref of refs) {
    payload.writeVarint(ref.slot);
    payload.writeVarint(ref.generation);
  }
  return finishFrame(FrameType.BlockAck, payload);
}

export function encodeEntryAckFrame(input: { slot: number; generation: number }): Uint8Array {
  const payload = new ByteWriter();
  payload.writeVarint(input.slot);
  payload.writeVarint(input.generation);
  return finishFrame(FrameType.EntryAck, payload);
}

export function parseFrame(source: Uint8Array): ParsedFrame {
  const reader = new ByteReader(source);
  const magic = reader.readByte("magic");
  if (magic !== FRAME_MAGIC) {
    throw new ProtocolError(
      `bad frame magic 0x${magic.toString(16)} (expected 0x${FRAME_MAGIC.toString(16)})`,
      "BAD_MAGIC",
    );
  }
  const version = reader.readByte("version");
  if (version !== FRAME_VERSION) {
    throw new ProtocolError(`unsupported frame version ${version}`, "BAD_VERSION");
  }
  const type = reader.readByte("type");

  switch (type) {
    case FrameType.Insert: {
      const slot = reader.readVarint("insert slot");
      const generation = reader.readVarint("insert generation");
      const key = reader.readString("insert key");
      const value = reader.readString("insert value");
      reader.expectEnd();
      return {
        type: "insert",
        slot,
        generation,
        key,
        value,
        keyByteLength: utf8ByteLength(key),
        valueByteLength: utf8ByteLength(value),
      };
    }
    case FrameType.Evict: {
      const slot = reader.readVarint("evict slot");
      const generation = reader.readVarint("evict generation");
      reader.expectEnd();
      return { type: "evict", slot, generation };
    }
    case FrameType.RequestBlock: {
      const blockId = reader.readVarint("block id");
      const fieldCount = reader.readVarint("block field count");
      const fields: ParsedBlockField[] = [];
      for (let index = 0; index < fieldCount; index += 1) {
        const tag = reader.readByte("block field tag");
        if (tag === 0x00) {
          const key = reader.readString("literal key");
          const value = reader.readString("literal value");
          fields.push({ kind: "literal", key, value });
        } else if (tag === 0x01) {
          const slot = reader.readVarint("reference slot");
          const generation = reader.readVarint("reference generation");
          fields.push({ kind: "reference", slot, generation });
        } else {
          throw new ProtocolError(
            `unknown block field tag 0x${tag.toString(16)}`,
            "UNKNOWN_FIELD_TAG",
          );
        }
      }
      reader.expectEnd();
      return { type: "block", blockId, fields };
    }
    case FrameType.BlockAck: {
      const blockId = reader.readVarint("block ack id");
      const outcomeByte = reader.readByte("block ack outcome");
      let outcome: AckOutcomeValue;
      if (outcomeByte === AckOutcome.Decoded) outcome = "decoded";
      else if (outcomeByte === AckOutcome.Abandoned) outcome = "abandoned";
      else {
        throw new ProtocolError(
          `unknown block ack outcome 0x${outcomeByte.toString(16)}`,
          "UNKNOWN_ACK_OUTCOME",
        );
      }
      const refCount = reader.readVarint("block ack ref count");
      const refs: SlotRef[] = [];
      for (let index = 0; index < refCount; index += 1) {
        refs.push({
          slot: reader.readVarint("ack ref slot"),
          generation: reader.readVarint("ack ref generation"),
        });
      }
      reader.expectEnd();
      return { type: "block-ack", blockId, outcome, refs };
    }
    case FrameType.EntryAck: {
      const slot = reader.readVarint("entry ack slot");
      const generation = reader.readVarint("entry ack generation");
      reader.expectEnd();
      return { type: "entry-ack", slot, generation };
    }
    default:
      throw new ProtocolError(
        `unknown frame type 0x${type.toString(16)}`,
        "UNKNOWN_FRAME_TYPE",
      );
  }
}

/** Parses a frame unless a caller already supplied the parsed form. */
export function coerceFrame(frame: Uint8Array | ParsedFrame): ParsedFrame {
  if (frame instanceof Uint8Array) return parseFrame(frame);
  if (frame !== null && typeof frame === "object" && typeof frame.type === "string") {
    return frame;
  }
  throw new TypeError("expected a frame Uint8Array or parsed frame object");
}
