/**
 * Public entry points: `rewriteMessage`, `decodeMessage`, and schema helpers.
 *
 * `rewriteMessage` is the module's core contract:
 *
 *   - it rewrites only the requested fields, at the position of each field's
 *     first wire occurrence, and removes that field's later occurrences;
 *   - it copies every untouched field and every unknown field byte-for-byte
 *     (original tag, original length, original payload);
 *   - fields that are replaced but absent from the input are appended in
 *     ascending field-number order;
 *   - repeated numeric replacements are always emitted packed;
 *   - it either returns a complete buffer or throws a ProtobufRewriteError
 *     carrying a byte position. It never returns a partially written result.
 */

import { ProtobufRewriteError } from './errors.ts';
import {
  normalizeReplacements,
  type NormalizedReplacements,
} from './replacement.ts';
import { normalizeSchema } from './schema.ts';
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  type DecodedMessage,
  type FieldSchemaInput,
  type FieldSpan,
  type NormalizedSchema,
  type OptionsInput,
  type ReplacementTableInput,
} from './types.ts';
import { parseMessage, type ParsedField } from './wire.ts';

export { ProtobufRewriteError } from './errors.ts';
export type {
  DecodedKnownField,
  DecodedMessage,
  DecodedUnknownField,
  FieldDescriptorInput,
  FieldReplacementInput,
  FieldSchemaInput,
  FieldSpan,
  FieldSpecInput,
  FieldType,
  NormalizedField,
  OptionsInput,
  ReplacementTableInput,
  RewriteOptions,
} from './types.ts';
export {
  DEFAULT_MAX_MESSAGE_BYTES,
  FIELD_TYPES,
  MAX_FIELD_NUMBER,
} from './types.ts';
export { normalizeSchema } from './schema.ts';
export {
  cleanupStaleTemps,
  tempPathFor,
  writeFileAtomic,
  type AtomicWriteHooks,
  type AtomicWriteOptions,
} from './atomic.ts';
export {
  rewriteAndStore,
  type GatewayRewriteRequest,
  type GatewayRewriteResult,
  type MessageStore,
} from './gateway.ts';

export interface EffectiveOptions {
  readonly maxMessageBytes: number;
}

function normalizeOptions(input: OptionsInput | undefined): EffectiveOptions {
  let rawMax: unknown = DEFAULT_MAX_MESSAGE_BYTES;

  if (typeof input === 'number') {
    rawMax = input;
  } else if (input !== undefined) {
    if (input === null || typeof input !== 'object') {
      throw new ProtobufRewriteError(
        'INVALID_OPTIONS',
        'options must be an object like { maxMessageBytes } or a number',
      );
    }
    const candidate = (input as { maxMessageBytes?: unknown }).maxMessageBytes;
    if (candidate !== undefined) {
      rawMax = candidate;
    }
  }

  if (
    typeof rawMax !== 'number' ||
    !Number.isSafeInteger(rawMax) ||
    rawMax < 0
  ) {
    throw new ProtobufRewriteError(
      'INVALID_OPTIONS',
      `maxMessageBytes must be a non-negative safe integer, received ${String(rawMax)}`,
    );
  }

  return Object.freeze({ maxMessageBytes: rawMax });
}

/** Resolve the caller's options into their effective values. */
export function resolveOptions(input?: OptionsInput): EffectiveOptions {
  return normalizeOptions(input);
}

function asBytes(input: unknown, what: string): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  throw new ProtobufRewriteError(
    'INVALID_INPUT',
    `${what} must be a Buffer or Uint8Array, received ${
      input === null ? 'null' : Array.isArray(input) ? 'Array' : typeof input
    }`,
  );
}

interface OutputBuilder {
  readonly pieces: Buffer[];
  total: number;
  readonly limit: number;
}

function appendRaw(
  builder: OutputBuilder,
  source: Uint8Array,
  start: number,
  end: number,
): void {
  const size = end - start;
  const next = builder.total + size;
  if (next > builder.limit) {
    // Even a verbatim copy can breach the ceiling if the caller lowered it
    // between input and output. Report both positions.
    throw new ProtobufRewriteError(
      'SIZE_LIMIT',
      `Rewritten message would be ${next} bytes, exceeding maxMessageBytes ${builder.limit}`,
      {
        limit: builder.limit,
        offset: start,
        fieldStart: start,
        outputOffset: builder.limit,
      },
    );
  }
  builder.pieces.push(Buffer.from(source.subarray(start, end)));
  builder.total = next;
}

function appendOwned(
  builder: OutputBuilder,
  bytes: Buffer,
  inputOffset: number,
): void {
  const next = builder.total + bytes.length;
  if (next > builder.limit) {
    throw new ProtobufRewriteError(
      'SIZE_LIMIT',
      `Rewritten message would be ${next} bytes, exceeding maxMessageBytes ${builder.limit}`,
      {
        limit: builder.limit,
        offset: inputOffset,
        fieldStart: inputOffset,
        outputOffset: builder.limit,
      },
    );
  }
  builder.pieces.push(bytes);
  builder.total = next;
}

/**
 * Rewrite a protobuf message, changing only the fields listed in
 * `replacements`.
 *
 * @param input        Complete message bytes.
 * @param schema       Field-number keyed description of the known fields.
 * @param replacements Field-number keyed replacement values.
 * @param options      `{ maxMessageBytes }` or a bare number.
 * @returns            A new Buffer with the replacements applied.
 * @throws ProtobufRewriteError on malformed input, bad schema/replacement
 *         values, unsupported groups, or a size-limit breach.
 */
export function rewriteMessage(
  input: Uint8Array,
  schema: FieldSchemaInput,
  replacements: ReplacementTableInput,
  options?: OptionsInput,
): Buffer {
  const bytes = asBytes(input, 'input message');
  const normalizedOptions = normalizeOptions(options);
  const limit = normalizedOptions.maxMessageBytes;

  if (bytes.length > limit) {
    throw new ProtobufRewriteError(
      'SIZE_LIMIT',
      `Input message is ${bytes.length} bytes, exceeding maxMessageBytes ${limit}`,
      { limit, offset: limit },
    );
  }

  const normalizedSchema = normalizeSchema(schema);
  const normalizedReplacements = normalizeReplacements(
    replacements,
    normalizedSchema,
  );

  // Validation and replacement encoding both happen before this point, so a
  // parse failure or a bad value never yields partial output.
  const parsed = parseMessage(bytes, normalizedSchema);

  return assemble(bytes, parsed.fields, normalizedReplacements, limit);
}

function assemble(
  source: Uint8Array,
  fields: readonly ParsedField[],
  replacements: NormalizedReplacements,
  limit: number,
): Buffer {
  const builder: OutputBuilder = { pieces: [], total: 0, limit };
  const emitted = new Set<number>();

  for (const field of fields) {
    const replacement = replacements.entries.get(field.fieldNumber);

    if (replacement === undefined) {
      // Unknown or untouched known field: copy the exact original bytes.
      appendRaw(builder, source, field.start, field.end);
      continue;
    }

    if (emitted.has(field.fieldNumber)) {
      // Later occurrences of a replaced field are dropped.
      continue;
    }
    emitted.add(field.fieldNumber);

    if (replacement.buffer !== null) {
      // The new representation goes exactly where the field first appeared.
      appendOwned(builder, replacement.buffer, field.start);
    }
    // replacement.buffer === null means an empty repeated list: field dropped.
  }

  // Replaced fields absent from the input are appended in field-number order.
  const missing = [...replacements.entries.values()]
    .filter((entry) => !emitted.has(entry.fieldNumber))
    .sort((a, b) => a.fieldNumber - b.fieldNumber);

  for (const entry of missing) {
    if (entry.buffer === null) continue;
    appendOwned(builder, entry.buffer, source.length);
  }

  return Buffer.concat(builder.pieces, builder.total);
}

/**
 * List every field occurrence of a message, in wire order.
 */
export function inspectMessage(
  input: Uint8Array,
  schema: FieldSchemaInput,
  options?: OptionsInput,
): FieldSpan[] {
  const bytes = asBytes(input, 'input message');
  const limit = normalizeOptions(options).maxMessageBytes;

  if (bytes.length > limit) {
    throw new ProtobufRewriteError(
      'SIZE_LIMIT',
      `Input message is ${bytes.length} bytes, exceeding maxMessageBytes ${limit}`,
      { limit, offset: limit },
    );
  }

  const normalized = normalizeSchema(schema);
  const parsed = parseMessage(bytes, normalized);

  return parsed.fields.map((field) =>
    Object.freeze({
      fieldNumber: field.fieldNumber,
      wireType: field.wireType,
      known: normalized.has(field.fieldNumber),
      start: field.start,
      end: field.end,
      bytes: Buffer.from(bytes.subarray(field.start, field.end)),
    }),
  );
}

/**
 * Decode the known fields of a message without rewriting anything.
 *
 * Singular fields expose their last occurrence; repeated numeric fields expose
 * every value merged in wire order across packed and unpacked occurrences.
 * Unknown fields are returned in wire order with their exact original bytes.
 */
export function decodeMessage(
  input: Uint8Array,
  schema: FieldSchemaInput,
  options?: OptionsInput,
): DecodedMessage {
  const bytes = asBytes(input, 'input message');
  const limit = normalizeOptions(options).maxMessageBytes;

  if (bytes.length > limit) {
    throw new ProtobufRewriteError(
      'SIZE_LIMIT',
      `Input message is ${bytes.length} bytes, exceeding maxMessageBytes ${limit}`,
      { limit, offset: limit },
    );
  }

  const normalized: NormalizedSchema = normalizeSchema(schema);
  const parsed = parseMessage(bytes, normalized);

  return Object.freeze({
    fields: parsed.known,
    unknownFields: Object.freeze([...parsed.unknown]),
  });
}
