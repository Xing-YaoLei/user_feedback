/**
 * Public type contracts for the layered configuration evaluator.
 */

/** Dimension tags understood by the exact unit arithmetic. */
export type Dimension = 'count' | 'time' | 'bytes';

export type TimeUnit = 'ns' | 'us' | 'ms' | 's' | 'min' | 'h' | 'd';
export type ByteUnit = 'b' | 'kb' | 'mb' | 'gb' | 'tb' | 'kib' | 'mib' | 'gib' | 'tib';
export type CountUnit = 'count';

export type Unit = TimeUnit | ByteUnit | CountUnit;

/**
 * A numeric value carrying a unit. `value` is kept as a decimal string so
 * literals never lose precision while entering the evaluator.
 */
export interface QuantityValue {
  kind: 'number';
  value: string;
  unit: Unit;
}

/** Any scalar literal that can be placed in a layer or produced by `$const`. */
export type LiteralValue =
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | QuantityValue;

/** Marker removing a path from its layer downward. */
export interface DeletionMarker {
  readonly kind: 'delete';
  readonly path?: string;
}

/** Expression AST node. */
export type Expr =
  | { $const: LiteralValue | string | number | boolean | null }
  | { $qty: string | { value: string | number; unit: string } }
  | { $ctx: string }
  | { $ref: string }
  | { $base: true | Record<string, never> | { path?: string } }
  | { $if: [Expr, Expr, Expr] }
  | { $exists: Expr }
  | { $coalesce: [Expr, ...Expr[]] }
  | { $eq: [Expr, Expr] }
  | { $ne: [Expr, Expr] }
  | { $lt: [Expr, Expr] }
  | { $lte: [Expr, Expr] }
  | { $gt: [Expr, Expr] }
  | { $gte: [Expr, Expr] }
  | { $and: [Expr, Expr, ...Expr[]] }
  | { $or: [Expr, Expr, ...Expr[]] }
  | { $not: Expr }
  | { $add: [Expr, Expr, ...Expr[]] }
  | { $sub: [Expr, Expr] }
  | { $mul: [Expr, Expr] }
  | { $div: [Expr, Expr] };

/** Wrapper marking a layer value as an inline expression. */
export interface InlineExpression {
  $expr: Expr;
}

/**
 * A value as written by a caller in a layer. Besides tagged literals and raw
 * primitives, an expression (wrapped in `{ $expr }`, or a bare operator object)
 * may be placed directly in a layer; it then defines that path at that layer
 * and may use `$base` to reach definitions in lower-priority layers.
 *
 * Plain strings shaped like `<number><unit>` (e.g. `"250ms"`) are read as
 * numeric quantities; wrap in `{ kind: 'string', value }` to force a string.
 */
export type LayerInputValue =
  | LiteralValue
  | DeletionMarker
  | InlineExpression
  | Expr
  | string
  | number
  | boolean
  | null;

/** One ordered override layer. `values` maps dot-separated paths to values. */
export interface Layer {
  /** Stable identifier, surfaced in provenance and dependency chains. */
  id: string;
  /** Dot-separated configuration paths. Layers are listed highest priority first. */
  values: Record<string, LayerInputValue>;
}

/** Expression registry keyed by configuration path. */
export type ExpressionRegistry = Record<string, Expr>;

/** How a path was defined. */
export type DefinitionKind = 'layer' | 'expression' | 'absent';

/** One hop in a configuration reference chain. */
export interface RefHop {
  /** Path that was referenced (for `base` hops, the path whose base was sought). */
  path: string;
  /** Layer that supplied the referenced definition, or null when missing. */
  layer: string | null;
  /** Structural role of the hop. */
  via: 'ref' | 'base';
}

/** Record of a `$base` lookup performed while computing a value. */
export interface BaseLookupRecord {
  /** Path whose lower definition was sought. */
  path: string;
  /** Layer id hosting the expression that requested the base lookup. */
  fromLayer: string;
  /** Layer that supplied the lower definition, or null when missing. */
  layer: string | null;
  /** What the lower definition turned out to be. */
  result: 'value' | 'deleted' | 'absent';
}

/** Provenance of a successful result. */
export interface ResultProvenance {
  /** Path this provenance belongs to. */
  path: string;
  /** Id of the layer (or `<expression>`) that supplied the selected definition. */
  layer: string;
  /** Index into the layer stack; -1 for the expression registry. */
  layerIndex: number;
  kind: DefinitionKind;
  /** The selected expression, when the definition is expression-backed. */
  expression?: Expr;
  /** The selected layer value, when the definition is a literal or deletion. */
  literal?: LiteralValue | DeletionMarker;
  /** Human-readable dependency labels (`ctx:…`, `ref:…`, `base:…`). */
  dependencies: string[];
  /** Ordered referential dependency chain, outermost first. */
  refs: RefHop[];
  /** Every configuration path read (transitively), including missing ones. */
  referencedPaths: string[];
  /** Every request-context key read (transitively). */
  contextKeys: string[];
  /** All `$base` lookups performed (transitively). */
  baseLookups: BaseLookupRecord[];
  /** Revision under which this result was interpreted (the batch revision). */
  evaluatedAtRevision: number;
}

/** Why an evaluation failed. */
export type EvaluationErrorCode =
  | 'cycle'
  | 'unit_mismatch'
  | 'type_mismatch'
  | 'missing'
  | 'invalid_expression'
  | 'division_by_zero'
  | 'unknown_unit';

export interface EvaluationError {
  code: EvaluationErrorCode;
  /** Root path of the batch request that surfaced this error. */
  path: string;
  /** Primary path (or `context:<key>`) whose value caused the error. */
  source: string;
  /** All source paths involved in the failing operation. */
  sources: string[];
  /** Human-readable explanation. */
  message: string;
  /** Reference chain leading to the failure. */
  refs: RefHop[];
  /** Batch revision the failing evaluation ran under. */
  revision: number;
}

/** Successful result for one path. */
export interface ResultValue {
  value: LiteralValue;
  /** Defining layer id (or `<expression>`). */
  layer: string;
  /** Full provenance record. */
  definition: ResultProvenance;
  /** Batch revision. */
  revision: number;
}

/** Why a path is missing. */
export type MissingReason =
  /** Nothing in any layer or expression registry defines the path. */
  | 'absent'
  /** A deletion marker in the winning layer removed the path. */
  | 'deleted'
  /** An expression produced no value (e.g. an unset context field). */
  | 'unresolved';

/** Missing outcome: nothing defines the path (including after deletions). */
export interface MissingResult {
  missing: true;
  path: string;
  reason: MissingReason;
  /** Layer that deleted the path or hosted the missing expression. */
  definitionLayer: string | null;
  revision: number;
  /** Dependency labels that explain the absence. */
  dependencies: string[];
}

export type EvaluationOutcome =
  | { ok: true; result: ResultValue }
  | { ok: false; missing: MissingResult }
  | { ok: false; error: EvaluationError };

export interface BatchResult {
  /** Revision the whole batch was evaluated against. */
  revision: number;
  values: Record<string, ResultValue>;
  missing: string[];
  /** Path -> missing detail. */
  missingDetail: Record<string, MissingResult>;
  errors: Record<string, EvaluationError>;
  /** Per-path status for every requested root. */
  outcomes: Record<string, EvaluationOutcome>;
}

export interface EvaluatorOptions {
  layers: Layer[];
  expressions?: ExpressionRegistry;
  context?: Readonly<Record<string, unknown>>;
  /** Optional starting revision (defaults to 1). */
  revision?: number;
}

export interface CacheStats {
  /** Root path requests served across all batches. */
  evaluations: number;
  /** Root requests whose value node was reused. */
  cacheHits: number;
  /** Root requests that had to recompute their value node. */
  cacheMisses: number;
  /** Root cache reuse per path. */
  hitsByPath: Record<string, number>;
  /** Actual value-node computations per path (roots, references and base targets). */
  recomputationsByPath: Record<string, number>;
  /** Expression AST evaluations per defining path; literals never appear. */
  expressionEvaluationsByPath: Record<string, number>;
  /** Value-node cache reuse per path, including references and base targets. */
  nodeHitsByPath: Record<string, number>;
  /** Batches executed. */
  batches: number;
  /** Current evaluator revision. */
  revision: number;
}

export type LayerUpdate =
  /** Set (or overwrite) a value in an existing layer. */
  | { type: 'set'; layer: string; path: string; value: LayerInputValue }
  /** Remove the entry entirely from that layer (unlike a deletion marker). */
  | { type: 'delete'; layer: string; path: string }
  | { type: 'addLayer'; layer: Layer; at?: number }
  | { type: 'removeLayer'; layer: string }
  /** Replace the expression registry wholesale. */
  | { type: 'setExpressions'; expressions: ExpressionRegistry };
