/**
 * Public type surface of the field rewriter.
 *
 * The wire-level contract is intentionally small: fields 1..2^29-1, wire types
 * 0/1/2/5, and the known scalar types listed below. Groups are rejected.
 */

export const FIELD_TYPES = [
  'uint64',
  'sint64',
  'fixed64',
  'fixed32',
  'string',
  'bytes',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];
export type NumericFieldType = Exclude<FieldType, 'string' | 'bytes'>;

/** Shorthand string form, e.g. `{ 1: 'uint64' }`. */
export type FieldSpecInput = FieldType | FieldDescriptorInput;

export interface FieldDescriptorInput {
  type: FieldType;
  /** true / label / rule all mark a repeated numeric field. */
  repeated?: boolean;
  label?: 'optional' | 'singular' | 'repeated';
  rule?: 'optional' | 'singular' | 'repeated';
}

export interface ArrayFieldDescriptorInput extends FieldDescriptorInput {
  fieldNumber: number;
}

export interface ObjectSchemaWrapper {
  fields:
    | ReadonlyMap<number, FieldSpecInput>
    | Readonly<Record<string, FieldSpecInput>>
    | readonly ArrayFieldDescriptorInput[];
}

/**
 * A field-number keyed description of the known fields in a message.
 *
 * Accepted shapes:
 *   new Map([[1, 'uint64'], [2, { type: 'string' }]])
 *   { 1: 'uint64', 2: { type: 'string' }, 5: { type: 'uint64', repeated: true } }
 *   [{ fieldNumber: 1, type: 'uint64' }, ...]
 *   { fields: <any of the above> }
 */
export type FieldSchemaInput =
  | ReadonlyMap<number, FieldSpecInput>
  | Readonly<Record<string, FieldSpecInput>>
  | readonly ArrayFieldDescriptorInput[]
  | ObjectSchemaWrapper;

export interface NormalizedField {
  readonly fieldNumber: number;
  readonly type: FieldType;
  readonly repeated: boolean;
}

export type NormalizedSchema = ReadonlyMap<number, NormalizedField>;

/** Integers may be bigint, a safe JS number, or a decimal string. */
export type IntegerInput = bigint | number | string;

/**
 * Replacement values:
 *   - integer scalar types: bigint | number | decimal string
 *   - string: string
 *   - bytes: Uint8Array (Buffer included) | byte array
 *   - repeated numeric: array of integer inputs
 */
export type FieldReplacementInput =
  | IntegerInput
  | Uint8Array
  | readonly (number | bigint | string)[];

export type ReplacementTableInput =
  | ReadonlyMap<number, FieldReplacementInput>
  | Readonly<Record<string, FieldReplacementInput>>;

export interface RewriteOptions {
  /**
   * Hard ceiling for both the input message and the produced message.
   * Defaults to 64 MiB. Non-negative safe integer.
   */
  maxMessageBytes?: number;
}

export type OptionsInput = RewriteOptions | number;

export interface DecodedKnownField {
  readonly fieldNumber: number;
  readonly type: FieldType;
  readonly repeated: boolean;
  /**
   * Singular numeric: bigint (the last occurrence wins).
   * Singular string: string (the last occurrence wins).
   * Singular bytes: Uint8Array (the last occurrence wins).
   * Repeated numeric: bigint[] merged in wire order across packed and
   * unpacked occurrences.
   */
  readonly value: bigint | string | Uint8Array | readonly bigint[];
  /** How many times the field appeared on the wire. */
  readonly occurrences: number;
}

export interface DecodedUnknownField {
  readonly fieldNumber: number;
  readonly wireType: number;
  /** Offset of the first tag byte. */
  readonly offset: number;
  /** Exact original bytes: tag + length (if any) + payload. */
  readonly bytes: Buffer;
}

/**
 * A single field occurrence located in the raw message bytes.
 *
 * Useful for callers that want to audit a rewrite without decoding values.
 */
export interface FieldSpan {
  readonly fieldNumber: number;
  readonly wireType: number;
  readonly known: boolean;
  readonly start: number;
  readonly end: number;
  /** Exact original bytes of tag + length + payload. */
  readonly bytes: Buffer;
}

export interface DecodedMessage {
  /** Known fields only, merged according to protobuf semantics. */
  readonly fields: ReadonlyMap<number, DecodedKnownField>;
  /** Unknown fields in wire order, each with its untouched raw bytes. */
  readonly unknownFields: readonly DecodedUnknownField[];
}

export const MAX_FIELD_NUMBER = 536870911; // 2^29 - 1
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface EncodedReplacement {
  readonly fieldNumber: number;
  readonly field: NormalizedField;
  /**
   * Fully encoded field (tag/length/payload), or null for an empty repeated
   * list, which is omitted from the output entirely.
   */
  readonly buffer: Buffer | null;
}
