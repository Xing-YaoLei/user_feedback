/**
 * Public entry point for the layered configuration evaluator.
 */

export { ConfigEvaluator, createConfigEvaluator, EvaluationBatch } from './engine.ts';
export type { BatchOptions, EvaluateOneOutcome } from './engine.ts';

export {
  LayerStack,
  REGISTRY_LAYER_ID,
  createStack,
  expressionFingerprint,
  normalizeEntry,
  normalizeLayer,
  normalizeRegistry,
} from './layers.ts';
export type { NormalizedLayer } from './layers.ts';

export { evaluateExpression } from './expression.ts';

export {
  DELETE,
  canonicalLiteral,
  deletePath,
  expr,
  inlineExpressionOf,
  isDeletion,
  literalTypeName,
  lookupContext,
  normalizeContextValue,
  normalizeLayerLiteral,
  snapshotContext,
} from './values.ts';

export {
  QuantityError,
  addQuantities,
  compareQuantities,
  convertQuantity,
  dimensionOf,
  divQuantities,
  equalQuantities,
  formatQuantity,
  isKnownUnit,
  makeQuantity,
  mulQuantities,
  parseQuantityText,
  quantityFromValue,
  quantityToValue,
  ratAdd,
  ratCmp,
  ratDiv,
  ratFromDecimal,
  ratMul,
  ratSub,
  ratToString,
  rational,
  subQuantities,
} from './quantity.ts';
export type { Quantity, Rational, UnitErrorCode } from './quantity.ts';

export type {
  BaseLookupRecord,
  BatchResult,
  ByteUnit,
  CacheStats,
  CountUnit,
  DefinitionKind,
  DeletionMarker,
  Dimension,
  EvaluationError,
  EvaluationErrorCode,
  EvaluationOutcome,
  EvaluatorOptions,
  Expr,
  ExpressionRegistry,
  InlineExpression,
  Layer,
  LayerInputValue,
  LayerUpdate,
  LiteralValue,
  MissingReason,
  MissingResult,
  QuantityValue,
  RefHop,
  ResultProvenance,
  ResultValue,
  TimeUnit,
  Unit,
} from './types.ts';
