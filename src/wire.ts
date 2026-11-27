/**
 * Wire-format scanner.
 *
 * Responsibilities:
 *   - walk the message field by field, validating every tag, length and
 *     varint, with byte-accurate error positions;
 *   - reject groups explicitly (wire types 3/4);
 *   - accumulate known-field values using protobuf semantics (last occurrence
 *     for singular fields, wire-order merging of packed and unpacked for
 *     repeated numeric fields);
 *   - record the exact byte range of every field so untouched fields can be
 *     copied verbatim.
 *
 * The scanner never mutates the input and never produces partial output.
 */

import { ProtobufRewriteError } from './errors.ts';
import type {
  DecodedKnownField,
  DecodedMessage,
  DecodedUnknownField,
  NormalizedField,
  NormalizedSchema,
} from './types.ts';
import { MAX_FIELD_NUMBER } from './types.ts';
import { decodeZigZag64, readFixed32, readFixed64, readVarint } from './varint.ts';
import { decodeUtf8, findInvalidUtf8 } from './utf8.ts';

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_START_GROUP = 3;
export const WIRE_END_GROUP = 4;
export const WIRE_FIXED32 = 5;

/** Wire type a singular instance of each supported scalar uses. */
const NATURAL_WIRE_TYPE: Readonly<Record<NormalizedField['type'], number>> = {
  uint64: WIRE_VARINT,
  sint64: WIRE_VARINT,
  fixed64: WIRE_FIXED64,
  fixed32: WIRE_FIXED32,
  string: WIRE_LENGTH_DELIMITED,
  bytes: WIRE_LENGTH_DELIMITED,
};

const EXPECTED_WIRE_TEXT: Readonly<Record<NormalizedField['type'], string>> = {
  uint64: 'wire type 0 (varint)',
  sint64: 'wire type 0 (varint, zig-zag)',
  fixed64: 'wire type 1 (fixed64)',
  fixed32: 'wire type 5 (fixed32)',
  string: 'wire type 2 (length-delimited)',
  bytes: 'wire type 2 (length-delimited)',
};

export interface ParsedField {
  readonly fieldNumber: number;
  readonly wireType: number;
  /** Offset of the first tag byte. */
  readonly start: number;
  /** Offset one past the last byte of the field. */
  readonly end: number;
  /** Offset of the first payload byte (after tag and, for wire type 2, length). */
  readonly payloadStart: number;
  /** Offset one past the last payload byte. */
  readonly payloadEnd: number;
  /** Value of a wire-type-0 field; null otherwise. */
  readonly varintValue: bigint | null;
}

export interface ParsedMessage {
  readonly fields: readonly ParsedField[];
  readonly known: ReadonlyMap<number, DecodedKnownField>;
  readonly unknown: readonly DecodedUnknownField[];
}

interface KnownAccumulator {
  readonly descriptor: NormalizedField;
  occurrences: number;
  singular: bigint | string | Uint8Array | null;
  repeatedValues: bigint[] | null;
}

function wrongWireType(
  field: NormalizedField,
  actual: number,
  offset: number,
  expected: string,
): never {
  throw new ProtobufRewriteError(
    'WRONG_WIRE_TYPE',
    `Field ${field.fieldNumber} (${field.type}) has wire type ${actual} at byte ${offset}; expected ${expected}`,
    { offset, fieldNumber: field.fieldNumber, wireType: actual, fieldStart: offset },
  );
}

function readScalarPayload(
  field: NormalizedField,
  wireType: number,
  buffer: Uint8Array,
  payloadStart: number,
  payloadEnd: number,
  fieldStart: number,
  varintValue: bigint | null,
): bigint {
  const natural = NATURAL_WIRE_TYPE[field.type];

  if (wireType !== natural) {
    const expected = field.repeated
      ? `${EXPECTED_WIRE_TEXT[field.type]} or wire type 2 (packed)`
      : EXPECTED_WIRE_TEXT[field.type];
    wrongWireType(field, wireType, fieldStart, expected);
  }

  switch (field.type) {
    case 'uint64':
      return varintValue as bigint;
    case 'sint64':
      return decodeZigZag64(varintValue as bigint);
    case 'fixed64':
      return readFixed64(buffer, payloadStart);
    case 'fixed32':
      return readFixed32(buffer, payloadStart);
    default:
      throw new ProtobufRewriteError(
        'INTERNAL',
        `readScalarPayload called for non-numeric type ${field.type}`,
        { fieldNumber: field.fieldNumber, fieldStart },
      );
  }
}

/** Decode a packed payload of numeric scalar values in wire order. */
function decodePackedPayload(
  field: NormalizedField,
  buffer: Uint8Array,
  payloadStart: number,
  payloadEnd: number,
  fieldStart: number,
  target: bigint[],
): void {
  let cursor = payloadStart;

  if (field.type === 'uint64' || field.type === 'sint64') {
    while (cursor < payloadEnd) {
      const { value, next } = readVarint(buffer, cursor, payloadEnd, {
        fieldStart,
        fieldNumber: field.fieldNumber,
      });
      target.push(field.type === 'sint64' ? decodeZigZag64(value) : value);
      cursor = next;
    }
    return;
  }

  const width = field.type === 'fixed64' ? 8 : 4;
  while (cursor < payloadEnd) {
    if (cursor + width > payloadEnd) {
      throw new ProtobufRewriteError(
        'TRUNCATED',
        `Packed ${field.type} payload for field ${field.fieldNumber} ends mid-element at byte ${payloadEnd}`,
        {
          offset: payloadEnd,
          fieldNumber: field.fieldNumber,
          fieldStart,
        },
      );
    }
    target.push(
      field.type === 'fixed64'
        ? readFixed64(buffer, cursor)
        : readFixed32(buffer, cursor),
    );
    cursor += width;
  }
}

function requireLengthDelimited(
  field: NormalizedField,
  wireType: number,
  fieldStart: number,
): void {
  if (wireType !== WIRE_LENGTH_DELIMITED) {
    wrongWireType(field, wireType, fieldStart, String(WIRE_LENGTH_DELIMITED));
  }
}

/**
 * Parse and validate a complete message.
 *
 * Throws ProtobufRewriteError on any malformed input; no partial result is
 * ever returned.
 */
export function parseMessage(
  buffer: Uint8Array,
  schema: NormalizedSchema,
): ParsedMessage {
  const length = buffer.length;
  const fields: ParsedField[] = [];
  const accumulators = new Map<number, KnownAccumulator>();
  const unknown: DecodedUnknownField[] = [];
  let cursor = 0;

  while (cursor < length) {
    const fieldStart = cursor;
    const tagResult = readVarint(buffer, cursor, length, { fieldStart });
    const tag = tagResult.value;
    cursor = tagResult.next;

    if (tag === 0n) {
      throw new ProtobufRewriteError(
        'INVALID_FIELD_NUMBER',
        `Field tag at byte ${fieldStart} encodes field number 0`,
        { offset: fieldStart, fieldNumber: 0, fieldStart },
      );
    }

    const wireTypeBig = tag & 0x07n;
    const fieldNumberBig = tag >> 3n;
    const wireType = Number(wireTypeBig);

    if (
      fieldNumberBig < 1n ||
      fieldNumberBig > BigInt(MAX_FIELD_NUMBER)
    ) {
      throw new ProtobufRewriteError(
        'INVALID_FIELD_NUMBER',
        `Field number ${fieldNumberBig.toString()} at byte ${fieldStart} is outside 1..${MAX_FIELD_NUMBER}`,
        {
          offset: fieldStart,
          fieldNumber:
            fieldNumberBig <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(fieldNumberBig)
              : null,
          fieldStart,
        },
      );
    }

    if (wireType === WIRE_START_GROUP || wireType === WIRE_END_GROUP) {
      throw new ProtobufRewriteError(
        'UNSUPPORTED_GROUP',
        `Group wire type ${wireType} for field ${fieldNumberBig.toString()} at byte ${fieldStart} is not supported`,
        {
          offset: fieldStart,
          fieldNumber: Number(fieldNumberBig),
          wireType,
          fieldStart,
        },
      );
    }

    if (
      wireType !== WIRE_VARINT &&
      wireType !== WIRE_FIXED64 &&
      wireType !== WIRE_LENGTH_DELIMITED &&
      wireType !== WIRE_FIXED32
    ) {
      throw new ProtobufRewriteError(
        'WRONG_WIRE_TYPE',
        `Invalid wire type ${wireType} for field ${fieldNumberBig.toString()} at byte ${fieldStart}`,
        {
          offset: fieldStart,
          fieldNumber: Number(fieldNumberBig),
          wireType,
          fieldStart,
        },
      );
    }

    const fieldNumber = Number(fieldNumberBig);
    let payloadStart: number;
    let payloadEnd: number;
    let varintValue: bigint | null = null;

    switch (wireType) {
      case WIRE_VARINT: {
        payloadStart = cursor;
        const result = readVarint(buffer, cursor, length, {
          fieldStart,
          fieldNumber,
        });
        varintValue = result.value;
        cursor = result.next;
        payloadEnd = cursor;
        break;
      }
      case WIRE_FIXED64: {
        payloadStart = cursor;
        if (cursor + 8 > length) {
          throw new ProtobufRewriteError(
            'TRUNCATED',
            `Fixed64 field ${fieldNumber} at byte ${fieldStart} is truncated: needs 8 payload bytes, only ${length - cursor} available`,
            { offset: length, fieldNumber, wireType, fieldStart },
          );
        }
        cursor += 8;
        payloadEnd = cursor;
        break;
      }
      case WIRE_FIXED32: {
        payloadStart = cursor;
        if (cursor + 4 > length) {
          throw new ProtobufRewriteError(
            'TRUNCATED',
            `Fixed32 field ${fieldNumber} at byte ${fieldStart} is truncated: needs 4 payload bytes, only ${length - cursor} available`,
            { offset: length, fieldNumber, wireType, fieldStart },
          );
        }
        cursor += 4;
        payloadEnd = cursor;
        break;
      }
      default: {
        // WIRE_LENGTH_DELIMITED
        payloadStart = cursor;
        const lengthResult = readVarint(buffer, cursor, length, {
          fieldStart,
          fieldNumber,
        });
        const declared = lengthResult.value;
        const available = BigInt(length - lengthResult.next);
        if (declared > available) {
          throw new ProtobufRewriteError(
            'TRUNCATED',
            `Length-delimited field ${fieldNumber} at byte ${fieldStart} declares ${declared.toString()} payload bytes but only ${available.toString()} are available`,
            { offset: length, fieldNumber, wireType, fieldStart },
          );
        }
        payloadStart = lengthResult.next;
        payloadEnd = payloadStart + Number(declared);
        cursor = payloadEnd;
        break;
      }
    }

    const parsed: ParsedField = {
      fieldNumber,
      wireType,
      start: fieldStart,
      end: cursor,
      payloadStart,
      payloadEnd,
      varintValue,
    };
    fields.push(parsed);

    const descriptor = schema.get(fieldNumber);
    if (descriptor === undefined) {
      unknown.push({
        fieldNumber,
        wireType,
        offset: fieldStart,
        bytes: Buffer.from(buffer.subarray(fieldStart, cursor)),
      });
      continue;
    }

    accumulateKnown(
      descriptor,
      parsed,
      buffer,
      accumulators,
      fieldStart,
    );
  }

  const known = new Map<number, DecodedKnownField>();
  for (const [fieldNumber, accumulator] of accumulators) {
    const descriptor = accumulator.descriptor;
    let value: DecodedKnownField['value'];

    if (descriptor.repeated) {
      value = accumulator.repeatedValues ?? [];
    } else {
      // Singular fields were validated and overwritten on every occurrence, so
      // the stored value is the last one seen.
      value = accumulator.singular as bigint | string | Uint8Array;
    }

    known.set(fieldNumber, Object.freeze({
      fieldNumber,
      type: descriptor.type,
      repeated: descriptor.repeated,
      value,
      occurrences: accumulator.occurrences,
    }));
  }

  return { fields, known, unknown };
}

function accumulateKnown(
  descriptor: NormalizedField,
  parsed: ParsedField,
  buffer: Uint8Array,
  accumulators: Map<number, KnownAccumulator>,
  fieldStart: number,
): void {
  let accumulator = accumulators.get(descriptor.fieldNumber);
  if (accumulator === undefined) {
    accumulator = {
      descriptor,
      occurrences: 0,
      singular: null,
      repeatedValues: descriptor.repeated ? [] : null,
    };
    accumulators.set(descriptor.fieldNumber, accumulator);
  }
  accumulator.occurrences += 1;

  const { wireType, payloadStart, payloadEnd, varintValue } = parsed;

  if (descriptor.repeated) {
    const values = accumulator.repeatedValues as bigint[];
    if (wireType === WIRE_LENGTH_DELIMITED) {
      decodePackedPayload(
        descriptor,
        buffer,
        payloadStart,
        payloadEnd,
        fieldStart,
        values,
      );
    } else {
      values.push(
        readScalarPayload(
          descriptor,
          wireType,
          buffer,
          payloadStart,
          payloadEnd,
          fieldStart,
          varintValue,
        ),
      );
    }
    return;
  }

  switch (descriptor.type) {
    case 'string': {
      requireLengthDelimited(descriptor, wireType, fieldStart);
      const invalid = findInvalidUtf8(buffer, payloadStart, payloadEnd);
      if (invalid >= 0) {
        throw new ProtobufRewriteError(
          'INVALID_UTF8',
          `Known string field ${descriptor.fieldNumber} at byte ${fieldStart} contains invalid UTF-8 at byte ${invalid}`,
          {
            offset: invalid,
            fieldNumber: descriptor.fieldNumber,
            fieldStart,
          },
        );
      }
      accumulator.singular = decodeUtf8(
        buffer.subarray(payloadStart, payloadEnd),
      );
      return;
    }
    case 'bytes': {
      requireLengthDelimited(descriptor, wireType, fieldStart);
      accumulator.singular = Buffer.from(
        buffer.subarray(payloadStart, payloadEnd),
      );
      return;
    }
    default: {
      accumulator.singular = readScalarPayload(
        descriptor,
        wireType,
        buffer,
        payloadStart,
        payloadEnd,
        fieldStart,
        varintValue,
      );
      return;
    }
  }
}
