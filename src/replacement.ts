/**
 * Replacement-value validation and canonical encoding.
 *
 * Every replacement is encoded eagerly, before any output is assembled, so a
 * bad replacement can never leave a half-written result behind.
 */

import { ProtobufRewriteError } from './errors.ts';
import type {
  EncodedReplacement,
  FieldReplacementInput,
  IntegerInput,
  NormalizedField,
  NormalizedSchema,
  ReplacementTableInput,
} from './types.ts';
import { encodeFixed64, encodeVarint, encodeZigZag64 } from './varint.ts';
import { encodeUtf8 } from './utf8.ts';

const UINT64_MAX = 0xffffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;
const INT64_MAX = 0x7fffffffffffffffn;
const UINT32_MAX = 0xffffffffn;

export interface NormalizedReplacements {
  /** Replacements keyed by field number; every entry refers to a known field. */
  readonly entries: ReadonlyMap<number, EncodedReplacement>;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'bigint') return `bigint ${value.toString()}n`;
  if (typeof value === 'number') return `number ${String(value)}`;
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  return value === null ? 'null' : typeof value;
}

function toBigInt(value: unknown, fieldNumber: number, where: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new ProtobufRewriteError(
        'INVALID_REPLACEMENT',
        `${where}: ${describeValue(value)} is not an integer`,
        { fieldNumber },
      );
    }
    // Only values that survive the round-trip are safe; beyond that a Number
    // literal has already lost precision before we ever see it.
    if (!Number.isSafeInteger(value)) {
      throw new ProtobufRewriteError(
        'INVALID_REPLACEMENT',
        `${where}: ${describeValue(value)} exceeds Number.MAX_SAFE_INTEGER; pass a bigint or decimal string to keep 64-bit precision`,
        { fieldNumber },
      );
    }
    return BigInt(value);
  }

  if (typeof value === 'string') {
    if (!/^-?[0-9]+$/.test(value)) {
      throw new ProtobufRewriteError(
        'INVALID_REPLACEMENT',
        `${where}: decimal string ${JSON.stringify(value)} is not a valid integer`,
        { fieldNumber },
      );
    }
    try {
      return BigInt(value);
    } catch {
      throw new ProtobufRewriteError(
        'INVALID_REPLACEMENT',
        `${where}: decimal string ${JSON.stringify(value)} is not a valid integer`,
        { fieldNumber },
      );
    }
  }

  throw new ProtobufRewriteError(
    'INVALID_REPLACEMENT',
    `${where}: expected an integer as bigint, number or decimal string, received ${describeValue(value)}`,
    { fieldNumber },
  );
}

function checkUint64(value: bigint, fieldNumber: number, where: string): bigint {
  if (value < 0n || value > UINT64_MAX) {
    throw new ProtobufRewriteError(
      'INVALID_REPLACEMENT',
      `${where}: ${value.toString()} is outside the uint64 range`,
      { fieldNumber },
    );
  }
  return value;
}

function checkInt64(value: bigint, fieldNumber: number, where: string): bigint {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new ProtobufRewriteError(
      'INVALID_REPLACEMENT',
      `${where}: ${value.toString()} is outside the sint64 range`,
      { fieldNumber },
    );
  }
  return value;
}

function checkFixed32(value: bigint, fieldNumber: number, where: string): bigint {
  if (value < 0n || value > UINT32_MAX) {
    throw new ProtobufRewriteError(
      'INVALID_REPLACEMENT',
      `${where}: ${value.toString()} is outside the fixed32 range`,
      { fieldNumber },
    );
  }
  return value;
}

function encodeScalarPayload(
  field: NormalizedField,
  value: unknown,
  where: string,
): { wireType: number; payload: Buffer } {
  switch (field.type) {
    case 'uint64': {
      const encoded = encodeVarint(
        checkUint64(toBigInt(value, field.fieldNumber, where), field.fieldNumber, where),
      );
      return { wireType: 0, payload: encoded };
    }
    case 'sint64': {
      const encoded = encodeVarint(
        encodeZigZag64(checkInt64(toBigInt(value, field.fieldNumber, where), field.fieldNumber, where)),
      );
      return { wireType: 0, payload: encoded };
    }
    case 'fixed64': {
      const encoded = encodeFixed64(
        checkUint64(toBigInt(value, field.fieldNumber, where), field.fieldNumber, where),
      );
      return { wireType: 1, payload: encoded };
    }
    case 'fixed32': {
      const fixed32 = checkFixed32(toBigInt(value, field.fieldNumber, where), field.fieldNumber, where);
      const payload = Buffer.alloc(4);
      payload.writeUInt32LE(Number(fixed32), 0);
      return { wireType: 5, payload };
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new ProtobufRewriteError(
          'INVALID_REPLACEMENT',
          `${where}: expected a string for a string field, received ${describeValue(value)}`,
          { fieldNumber: field.fieldNumber },
        );
      }
      return { wireType: 2, payload: encodeUtf8(value) };
    }
    case 'bytes': {
      if (!(value instanceof Uint8Array)) {
        throw new ProtobufRewriteError(
          'INVALID_REPLACEMENT',
          `${where}: expected a Uint8Array for a bytes field, received ${describeValue(value)}`,
          { fieldNumber: field.fieldNumber },
        );
      }
      return { wireType: 2, payload: Buffer.from(value) };
    }
    default: {
      // Unreachable: normalizeSchema filters the type union.
      throw new ProtobufRewriteError(
        'INTERNAL',
        `Unhandled field type ${String((field as { type: unknown }).type)}`,
        { fieldNumber: field.fieldNumber },
      );
    }
  }
}

/** Varint-encoded tag byte sequence. */
function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

function encodeSingular(
  field: NormalizedField,
  value: unknown,
  where: string,
): Buffer {
  const { wireType, payload } = encodeScalarPayload(field, value, where);

  if (wireType === 2) {
    return Buffer.concat([
      encodeTag(field.fieldNumber, 2),
      encodeVarint(BigInt(payload.length)),
      payload,
    ]);
  }

  return Buffer.concat([encodeTag(field.fieldNumber, wireType), payload]);
}

const WIRE_TYPES_FOR_PACKING = new Set(['uint64', 'sint64', 'fixed64', 'fixed32']);

/**
 * Repeated numeric replacements are always emitted packed, regardless of how
 * the original field was encoded on the wire.
 */
function encodeRepeated(field: NormalizedField, value: unknown, where: string): Buffer {
  if (!Array.isArray(value)) {
    throw new ProtobufRewriteError(
      'INVALID_REPLACEMENT',
      `${where}: repeated field ${field.fieldNumber} requires an array of values, received ${describeValue(value)}`,
      { fieldNumber: field.fieldNumber },
    );
  }

  if (value.length === 0) {
    // An empty repeated list means "write nothing"; the caller drops this field.
    return Buffer.alloc(0);
  }

  if (!WIRE_TYPES_FOR_PACKING.has(field.type)) {
    throw new ProtobufRewriteError(
      'INTERNAL',
      `${where}: field ${field.fieldNumber} is repeated but its type cannot be packed`,
      { fieldNumber: field.fieldNumber },
    );
  }

  const pieces: Buffer[] = [];
  let payloadLength = 0;

  value.forEach((item, index) => {
    const itemWhere = `${where}[${index}]`;
    const { wireType, payload } = encodeScalarPayload(field, item, itemWhere);

    // Packed elements use only the scalar encoding; wire type 1/5 are fixed
    // width and 0 is a varint, both are legal inside a packed payload.
    if (wireType !== 0 && wireType !== 1 && wireType !== 5) {
      throw new ProtobufRewriteError(
        'INTERNAL',
        `${itemWhere}: unpackable scalar encoding`,
        { fieldNumber: field.fieldNumber },
      );
    }

    pieces.push(payload);
    payloadLength += payload.length;
  });

  return Buffer.concat([
    encodeTag(field.fieldNumber, 2),
    encodeVarint(BigInt(payloadLength)),
    ...pieces,
  ]);
}

/** Encode one replacement entry into its final field byte form. */
function encodeReplacement(
  field: NormalizedField,
  raw: FieldReplacementInput,
  where: string,
): Buffer | null {
  if (field.repeated) {
    const encoded = encodeRepeated(field, raw, where);
    return encoded.length === 0 ? null : encoded;
  }

  return encodeSingular(field, raw, where);
}

function collectEntries(
  input: ReplacementTableInput,
): ReadonlyArray<readonly [unknown, unknown]> {
  if (input instanceof Map) {
    return [...input.entries()];
  }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return Object.keys(input).map((key) => [key, (input as Record<string, unknown>)[key]] as const);
  }
  throw new ProtobufRewriteError(
    'INVALID_REPLACEMENT',
    'replacements must be a Map<number, value> or a field-number keyed plain object',
  );
}

/**
 * Validate and encode all replacements up front.
 *
 * Any unknown field number, wrong value shape, or out-of-range integer throws
 * before a single output byte is written.
 */
export function normalizeReplacements(
  input: ReplacementTableInput,
  schema: NormalizedSchema,
): NormalizedReplacements {
  const entries = new Map<number, EncodedReplacement>();

  for (const [rawKey, rawValue] of collectEntries(input)) {
    let fieldNumber: number;

    if (typeof rawKey === 'number') {
      fieldNumber = rawKey;
    } else if (typeof rawKey === 'string' && /^[0-9]+$/.test(rawKey)) {
      fieldNumber = Number(rawKey);
    } else {
      throw new ProtobufRewriteError(
        'INVALID_FIELD_NUMBER',
        `Replacement key ${JSON.stringify(rawKey)} is not a positive integer field number`,
      );
    }

    if (!Number.isInteger(fieldNumber) || fieldNumber < 1) {
      throw new ProtobufRewriteError(
        'INVALID_FIELD_NUMBER',
        `Replacement field number ${String(rawKey)} is invalid`,
        { fieldNumber: Number.isFinite(fieldNumber) ? fieldNumber : null },
      );
    }

    const field = schema.get(fieldNumber);
    if (field === undefined) {
      throw new ProtobufRewriteError(
        'INVALID_REPLACEMENT',
        `Cannot replace field ${fieldNumber}: it is not declared in the schema`,
        { fieldNumber },
      );
    }

    const buffer = encodeReplacement(field, rawValue as FieldReplacementInput, `replacement[${fieldNumber}]`);
    entries.set(fieldNumber, Object.freeze({ fieldNumber, field, buffer }));
  }

  return Object.freeze({ entries });
}

export { encodeTag };
