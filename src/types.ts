/**
 * Core type declarations for the schema registry.
 *
 * All TypeScript here uses erasable syntax only, so the files can be run
 * directly by Node's built-in TypeScript support (no compilation step).
 */

// ---------------------------------------------------------------------------
// Schema definition types
// ---------------------------------------------------------------------------

export type TypeKind =
  | 'bool'
  | 'string'
  | 'i32'
  | 'i64'
  | 'f64'
  | 'array'
  | 'record'
  | 'union'
  | 'ref';

export interface BoolType {
  kind: 'bool';
}
export interface StringType {
  kind: 'string';
}
export interface I32Type {
  kind: 'i32';
}
export interface I64Type {
  kind: 'i64';
}
export interface F64Type {
  kind: 'f64';
}
export interface ArrayType {
  kind: 'array';
  items: Type;
}
export interface RefType {
  kind: 'ref';
  /** Name of the named type in the schema's type table. */
  name: string;
}

export interface FieldDef {
  /** Stable positive integer wire id. Names may change between versions. */
  id: number;
  /** Field name, used only inside one schema version. */
  name: string;
  type: Type;
  /** When absent (undefined), the field is mandatory. */
  default?: unknown;
  hasDefault: boolean;
}

export interface RecordType {
  kind: 'record';
  fields: FieldDef[];
}

export interface UnionBranch {
  /** Stable discriminator tag; a branch is selected by exact tag equality. */
  tag: string;
  type: Type;
}

export interface UnionType {
  kind: 'union';
  branches: UnionBranch[];
}

export type Type =
  | BoolType
  | StringType
  | I32Type
  | I64Type
  | F64Type
  | ArrayType
  | RecordType
  | UnionType
  | RefType;

export interface Schema {
  version: string;
  /** Named type table; names are used by `ref` nodes. */
  types: Record<string, Type>;
  /** Entry type; either a named type reference target or an inline type. */
  root: Type;
}

// ---------------------------------------------------------------------------
// Wire (encoded) values
// ---------------------------------------------------------------------------

/**
 * Canonical wire payload:
 *  - bool/string/f64/i32 use plain JSON values
 *  - i64 uses a bigint (exact at runtime; encode/decode wrap it as a tagged
 *    JSON string so the message can also survive JSON serialization)
 *  - arrays use plain arrays
 *  - records are plain objects keyed by the stable positive field id
 *  - unions are tagged envelopes `{ tag, value }`
 */
export type WireValue =
  | boolean
  | string
  | number
  | bigint
  | WireValue[]
  | { [fieldId: string]: WireValue }
  | { tag: string; value: WireValue };

// ---------------------------------------------------------------------------
// Type paths produced by compatibility analysis and parsing failures
// ---------------------------------------------------------------------------

export type PathStep =
  | { kind: 'root' }
  | { kind: 'field'; id: number; name: string }
  | { kind: 'array-item'; index: number }
  | { kind: 'union-branch'; tag: string };

export type TypePath = PathStep[];

// ---------------------------------------------------------------------------
// Compatibility direction and registration policies
// ---------------------------------------------------------------------------

/**
 * - backward: every previously registered version's writer can be read by
 *   the new schema's reader (old write -> new read)
 * - forward: every previously registered version's reader can read messages
 *   written by the new schema (new write -> old read)
 * - bidirectional: both directions
 */
export type Direction = 'backward' | 'forward' | 'bidirectional';

// ---------------------------------------------------------------------------
// Numeric domains
// ---------------------------------------------------------------------------

export const I32_MIN = -2147483648;
export const I32_MAX = 2147483647;
export const I64_MIN = -9223372036854775808n;
export const I64_MAX = 9223372036854775807n;
export const F64_EXACT_INT_MAX = 9007199254740992; // 2^53 inclusive
export const F64_EXACT_INT_MIN = -9007199254740992;
