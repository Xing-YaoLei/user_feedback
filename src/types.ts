/**
 * Public schema model and wire-format types.
 *
 * A schema version is a named type table plus a root type. Type expressions
 * are plain data so they can be inspected and compared structurally.
 */

export type PrimitiveKind = 'boolean' | 'string' | 'int32' | 'int64' | 'float64';

export interface PrimitiveType {
  readonly kind: PrimitiveKind;
}

export interface ArrayType {
  readonly kind: 'array';
  readonly item: TypeExpr;
}

export interface RecordField {
  readonly id: number;
  readonly name: string;
  readonly type: TypeExpr;
  /**
   * Reader-side default. When this property is present (even when the value is
   * `false`, `0` or `''`) a reader that lacks a matching writer field fills the
   * value from this default. When absent the field is required.
   */
  readonly default?: unknown;
}

export interface RecordType {
  readonly kind: 'record';
  readonly fields: ReadonlyArray<RecordField>;
}

export interface UnionBranch {
  readonly tag: string;
  readonly type: TypeExpr;
}

export interface UnionType {
  readonly kind: 'union';
  readonly branches: ReadonlyArray<UnionBranch>;
}

export interface RefType {
  readonly kind: 'ref';
  readonly name: string;
}

export type TypeExpr =
  | PrimitiveType
  | ArrayType
  | RecordType
  | UnionType
  | RefType;

export interface SchemaDefinition {
  /** Named type table. Names are used by `ref` expressions and the root. */
  readonly types: Record<string, TypeExpr>;
  /** Root type: either a named type name or an inline type expression. */
  readonly root: string | TypeExpr;
}

/** A record value on the wire, keyed by decimal field id. */
export interface WireRecord {
  [fieldId: string]: WireValue;
}

export interface WireUnion {
  tag: string;
  value: WireValue;
}

/**
 * Wire values are the concrete messages the registry encodes and resolves.
 * - boolean/string/float64 -> JS boolean/string/number
 * - int32/int64 -> bigint (int64 stays exact at runtime)
 * - array -> WireValue[]
 * - record -> WireRecord
 * - union -> WireUnion
 * - ref -> the resolved underlying value
 */
export type WireValue =
  | boolean
  | string
  | number
  | bigint
  | WireValue[]
  | WireRecord
  | WireUnion;

export type CompatibilityStrategy = 'backward' | 'forward' | 'both';

export type Direction = 'backward' | 'forward';

/** How a reader obtains a value for one record field. */
export type FieldPlanStep =
  | { readonly kind: 'copy'; readonly writerFieldId: number }
  | { readonly kind: 'default'; readonly value: unknown }
  | { readonly kind: 'nested' };

export interface FieldPlan {
  readonly readerFieldId: number;
  readonly readerFieldName: string;
  readonly step: FieldPlanStep;
  /** Present when `step.kind === 'nested'`. */
  readonly nested?: PlanNode;
}

export interface RecordPlan {
  readonly kind: 'record';
  readonly fields: ReadonlyArray<FieldPlan>;
}

export interface ArrayPlan {
  readonly kind: 'array';
  readonly item: PlanNode;
}

/** Union selection is by tag; each branch may use a different plan. */
export interface UnionPlan {
  readonly kind: 'union';
  readonly branches: ReadonlyArray<{ readonly tag: string; readonly plan: PlanNode }>;
}

export interface PrimitivePlan {
  readonly kind: 'primitive';
  readonly from: PrimitiveKind;
  readonly to: PrimitiveKind;
  /** True when the conversion is exact for every writer value. */
  readonly identity: boolean;
}

export type PlanNode = PrimitivePlan | ArrayPlan | RecordPlan | UnionPlan;

/**
 * An incompatibility: the type path where it occurs plus a finite message that
 * was actually encoded in the writer schema and triggers this exact failure in
 * the reader.
 */
export interface Incompatibility {
  readonly path: ReadonlyArray<string | number>;
  readonly reason: string;
  readonly example: WireValue;
}

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly direction: Direction;
  readonly plan?: PlanNode;
  readonly incompatibility?: Incompatibility;
}

export interface RegisteredVersion {
  readonly id: number;
  readonly schema: SchemaDefinition;
}

export interface ResolutionPlan {
  readonly writerVersion: number;
  readonly readerVersion: number;
  readonly direction: Direction;
  /** Encoded writer message -> resolved reader message. */
  readonly resolve: (message: WireValue) => WireValue;
}

export interface RegisterResult {
  readonly version: number;
  readonly checks: ReadonlyArray<CompatibilityResult>;
}
