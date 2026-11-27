/**
 * Schema normalization and validation.
 *
 * A schema is a field-number keyed description of the *known* fields. Anything
 * not listed is an unknown field and is preserved byte-for-byte.
 */

import { ProtobufRewriteError } from './errors.ts';
import {
  FIELD_TYPES,
  MAX_FIELD_NUMBER,
  type FieldDescriptorInput,
  type FieldSchemaInput,
  type FieldSpecInput,
  type FieldType,
  type NormalizedField,
  type NormalizedSchema,
} from './types.ts';

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

export function isKnownFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && FIELD_TYPE_SET.has(value);
}

function assertFieldNumber(candidate: unknown, where: string): number {
  if (typeof candidate !== 'number' || !Number.isInteger(candidate)) {
    throw new ProtobufRewriteError(
      'INVALID_SCHEMA',
      `${where}: field number must be an integer, received ${String(candidate)}`,
    );
  }
  if (candidate < 1 || candidate > MAX_FIELD_NUMBER) {
    throw new ProtobufRewriteError(
      'INVALID_SCHEMA',
      `${where}: field number ${candidate} is outside 1..${MAX_FIELD_NUMBER}`,
      { fieldNumber: candidate },
    );
  }
  return candidate;
}

function normalizeRepeated(value: FieldDescriptorInput, where: string): boolean {
  let repeated = false;

  if (value.repeated !== undefined) {
    if (typeof value.repeated !== 'boolean') {
      throw new ProtobufRewriteError(
        'INVALID_SCHEMA',
        `${where}: "repeated" must be a boolean`,
      );
    }
    repeated = value.repeated;
  }

  for (const key of ['label', 'rule'] as const) {
    const label = value[key];
    if (label === undefined) continue;
    if (label !== 'optional' && label !== 'singular' && label !== 'repeated') {
      throw new ProtobufRewriteError(
        'INVALID_SCHEMA',
        `${where}: "${key}" must be "optional", "singular" or "repeated"`,
      );
    }
    if (label === 'repeated') {
      if (value.repeated === false) {
        throw new ProtobufRewriteError(
          'INVALID_SCHEMA',
          `${where}: "repeated: false" contradicts "${key}: repeated"`,
        );
      }
      repeated = true;
    }
  }

  return repeated;
}

function normalizeSpec(
  spec: FieldSpecInput,
  fieldNumber: number,
  where: string,
): NormalizedField {
  let type: unknown;
  let repeated = false;

  if (typeof spec === 'string') {
    type = spec;
  } else if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    type = (spec as FieldDescriptorInput).type;
    repeated = normalizeRepeated(spec as FieldDescriptorInput, where);
  } else {
    throw new ProtobufRewriteError(
      'INVALID_SCHEMA',
      `${where}: expected a field type string or descriptor object`,
      { fieldNumber },
    );
  }

  if (!isKnownFieldType(type)) {
    throw new ProtobufRewriteError(
      'INVALID_SCHEMA',
      `${where}: unsupported field type ${JSON.stringify(type)}; expected one of ${FIELD_TYPES.join(', ')}`,
      { fieldNumber },
    );
  }

  // Protobuf only permits `repeated` on numeric scalar fields in this module's
  // supported surface. Strings/bytes are singular so that their wire bytes can
  // be validated as one unit and preserved in place.
  if (repeated && (type === 'string' || type === 'bytes')) {
    throw new ProtobufRewriteError(
      'INVALID_SCHEMA',
      `${where}: repeated is only supported for numeric field types (uint64, sint64, fixed64, fixed32)`,
      { fieldNumber },
    );
  }

  return Object.freeze({ fieldNumber, type, repeated });
}

function addField(
  target: Map<number, NormalizedField>,
  fieldNumber: number,
  spec: FieldSpecInput,
  where: string,
): void {
  const normalized = normalizeSpec(spec, fieldNumber, where);
  const existing = target.get(fieldNumber);
  if (existing !== undefined) {
    if (existing.type === normalized.type && existing.repeated === normalized.repeated) {
      return; // Duplicate but identical declarations are harmless.
    }
    throw new ProtobufRewriteError(
      'INVALID_SCHEMA',
      `${where}: conflicting declarations for field ${fieldNumber} (${existing.type}${existing.repeated ? ', repeated' : ''} vs ${normalized.type}${normalized.repeated ? ', repeated' : ''})`,
      { fieldNumber },
    );
  }
  target.set(fieldNumber, normalized);
}

function isRecordLike(value: object): value is Readonly<Record<string, FieldSpecInput>> {
  return !(value instanceof Map) && !Array.isArray(value);
}

function normalizeRecord(
  record: Readonly<Record<string, FieldSpecInput>>,
  target: Map<number, NormalizedField>,
  where: string,
  allowWrapper: boolean,
): void {
  const keys = Object.keys(record);

  if (allowWrapper && keys.length === 1 && keys[0] === 'fields') {
    normalizeInto(
      (record as unknown as { fields: FieldSchemaInput }).fields,
      target,
      `${where}.fields`,
      false,
    );
    return;
  }

  for (const key of keys) {
    if (key === 'fields') {
      throw new ProtobufRewriteError(
        'INVALID_SCHEMA',
        `${where}: "fields" cannot be mixed with direct field-number keys`,
      );
    }
    if (!/^[0-9]+$/.test(key)) {
      throw new ProtobufRewriteError(
        'INVALID_SCHEMA',
        `${where}: key ${JSON.stringify(key)} is not a positive integer field number`,
      );
    }
    const fieldNumber = assertFieldNumber(Number(key), `${where}[${key}]`);
    addField(target, fieldNumber, record[key] as FieldSpecInput, `${where}[${key}]`);
  }
}

function normalizeArray(
  entries: readonly unknown[],
  target: Map<number, NormalizedField>,
  where: string,
): void {
  entries.forEach((entry, index) => {
    const entryWhere = `${where}[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProtobufRewriteError(
        'INVALID_SCHEMA',
        `${entryWhere}: expected { fieldNumber, type, repeated? }`,
      );
    }
    const descriptor = entry as Record<string, unknown>;
    const fieldNumber = assertFieldNumber(descriptor['fieldNumber'], `${entryWhere}.fieldNumber`);

    const spec: Record<string, unknown> = { type: descriptor['type'] };
    if (descriptor['repeated'] !== undefined) spec['repeated'] = descriptor['repeated'];
    if (descriptor['label'] !== undefined) spec['label'] = descriptor['label'];
    if (descriptor['rule'] !== undefined) spec['rule'] = descriptor['rule'];

    addField(
      target,
      fieldNumber,
      spec as unknown as FieldDescriptorInput,
      entryWhere,
    );
  });
}

function normalizeInto(
  input: FieldSchemaInput,
  target: Map<number, NormalizedField>,
  where: string,
  allowWrapper: boolean,
): void {
  if (input instanceof Map) {
    for (const [key, spec] of input.entries()) {
      const fieldNumber = assertFieldNumber(key, `${where}<${String(key)}>`);
      addField(target, fieldNumber, spec, `${where}<${String(key)}>`);
    }
    return;
  }

  if (Array.isArray(input)) {
    normalizeArray(input, target, where);
    return;
  }

  if (input !== null && typeof input === 'object') {
    normalizeRecord(
      input as Readonly<Record<string, FieldSpecInput>>,
      target,
      where,
      allowWrapper,
    );
    return;
  }

  throw new ProtobufRewriteError(
    'INVALID_SCHEMA',
    `${where}: schema must be a Map, plain object, array of descriptors or { fields } wrapper`,
  );
}

/** Normalize any accepted schema shape into a frozen Map of field descriptors. */
export function normalizeSchema(input: FieldSchemaInput): NormalizedSchema {
  const target = new Map<number, NormalizedField>();
  normalizeInto(input, target, 'schema', true);
  return target;
}

/** Type guard used before touching arbitrary objects. */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export { isRecordLike };
