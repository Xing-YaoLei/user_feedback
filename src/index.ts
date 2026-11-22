export type {
  Type,
  TypeKind,
  Schema,
  FieldDef,
  RecordType,
  UnionType,
  UnionBranch,
  ArrayType,
  RefType,
  WireValue,
  TypePath,
  PathStep,
  Direction,
} from './types.ts';
export {
  I32_MIN,
  I32_MAX,
  I64_MIN,
  I64_MAX,
  F64_EXACT_INT_MIN,
  F64_EXACT_INT_MAX,
} from './types.ts';

export {
  SchemaValidationError,
  CompatibilityError,
  ParseError,
  renderPath,
} from './errors.ts';

export { encodeWire, decodeWire, isWireUnion, isPlainRecord } from './wire.ts';

export { validateSchema } from './validate.ts';
export type { ValidatedSchema } from './validate.ts';

export { numericLossless, buildCounterexample } from './compat.ts';
export type { CheckOutcome, CheckFailure } from './compat.ts';

export { buildPlan } from './plan.ts';
export type {
  Plan,
  RecipeNode,
  LeafNode,
  ArrayNode,
  RecordNode,
  UnionNode,
  DefaultNode,
  RecordFieldRecipe,
  UnionBranchRecipe,
} from './plan.ts';

export { SchemaRegistry } from './registry.ts';
export type { RegistrationResult } from './registry.ts';
