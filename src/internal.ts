/**
 * Internal (non-public) contracts shared by the layer stack, the expression
 * evaluator and the engine. Not exported from the package entry point.
 */

import type {
  BaseLookupRecord,
  DefinitionKind,
  EvaluationErrorCode,
  Expr,
  LiteralValue,
  MissingReason,
  RefHop,
  ResultProvenance,
} from './types.ts';
import type { Quantity } from './quantity.ts';

/** A normalized layer value. */
export type InternalValue =
  | { kind: 'literal'; literal: LiteralValue }
  | { kind: 'deletion' }
  | { kind: 'expression'; expression: Expr; fingerprint: string };

/**
 * The winning definition of a path for a given search start position.
 * `position` is the priority index into the layer stack (0 = highest).
 */
export type Definition =
  | { kind: 'absent' }
  | {
      kind: 'deletion';
      position: number;
      layerIndex: number;
      layerId: string;
    }
  | {
      kind: 'literal';
      position: number;
      layerIndex: number;
      layerId: string;
      literal: LiteralValue;
    }
  | {
      kind: 'expression';
      position: number;
      layerIndex: number;
      layerId: string;
      expression: Expr;
      fingerprint: string;
    };

/** Successful node metadata, retained in the cache. */
export interface NodeProvenance extends Omit<ResultProvenance, 'evaluatedAtRevision'> {
  /** Revision in which this node was actually recomputed. */
  computedAtRevision: number;
}

export interface NodeMissing {
  reason: MissingReason;
  definitionLayer: string | null;
  dependencies: string[];
}

/** An error before it is bound to a particular batch root. */
export interface InternalError {
  code: EvaluationErrorCode;
  /** Primary config path (or `context:<key>`) that caused the failure. */
  source: string;
  /** Every source involved in the failing operation. */
  sources: string[];
  message: string;
  /** Reference hops from the computing node to the error site. */
  refs: RefHop[];
}

/** One direct dependency edge, recorded with the boundary it was searched from. */
export interface DepEdge {
  /** Boundary id of the originating search (`\u0000root` for the top). */
  boundary: string;
  path: string;
  /** Child node signature observed at compute time. */
  signature: string;
}

/**
 * One immutable cache entry for a `path@boundary` node.
 *
 * `signature` captures everything observable about the outcome;
 * `definitionKey` captures which definition currently wins; `ctxSignatures`
 * and `depSignatures` capture the inputs the outcome was computed from.
 * Together they decide whether the entry can be reused in a later revision.
 */
export interface NodeEntry {
  key: string;
  path: string;
  fromPosition: number;
  definitionKey: string;
  signature: string;
  status: 'value' | 'missing' | 'error';
  /** Winning definition layer id; null when the path is absent. */
  layerId: string | null;
  kind: DefinitionKind;
  value?: LiteralValue;
  /** Exact magnitude of `value` when it is numeric. */
  exact?: Quantity;
  provenance?: NodeProvenance;
  missing?: NodeMissing;
  error?: InternalError;
  /** Signatures of context keys read directly by this node. */
  ctxSignatures: { key: string; signature: string }[];
  /** Direct node dependencies with the signature observed at compute time. */
  depSignatures: DepEdge[];
  /** Transitive metadata, retained for provenance reporting. */
  transContextKeys: string[];
  transReferencedPaths: string[];
  transRefs: RefHop[];
  transBaseLookups: BaseLookupRecord[];
  computedAtRevision: number;
  /** False when the entry must not be persisted (e.g. a detected cycle). */
  cacheable: boolean;
}

/** Accumulates the dependencies and provenance of one expression evaluation. */
export interface Collector {
  ctxSignatures: Map<string, string>;
  deps: Map<string, DepEdge>;
  /** Direct hops, in resolution order. */
  refs: RefHop[];
  /** Direct hops interleaved with each child's own chain. */
  transRefs: RefHop[];
  /** Human-readable dependency labels (`ctx:…`, `ref:…`, `base:…`). */
  labels: string[];
  /** Transitive context keys and referenced paths. */
  transContextKeys: Set<string>;
  transReferencedPaths: Set<string>;
  /** Transitive base lookups. */
  transBaseLookups: BaseLookupRecord[];
  /** Set when a dependency could not be cached (e.g. a detected cycle). */
  uncacheable: boolean;
}

export function newCollector(): Collector {
  return {
    ctxSignatures: new Map(),
    deps: new Map(),
    refs: [],
    transRefs: [],
    labels: [],
    transContextKeys: new Set(),
    transReferencedPaths: new Set(),
    transBaseLookups: [],
    uncacheable: false,
  };
}

/** Outcome of evaluating one expression node. */
export type EvalResult =
  | {
      status: 'value';
      value: LiteralValue;
      origin: string;
      /**
       * Exact magnitude behind a numeric `value`. Numeric literals are stored
       * as decimal strings, which cannot represent repeating fractions; keeping
       * the rational alongside lets chained arithmetic stay exact across
       * reference boundaries.
       */
      exact?: Quantity;
    }
  | {
      status: 'missing';
      reason: MissingReason;
      layerId: string | null;
      labels: string[];
      /** Path or `context:<key>` that came up empty. */
      sourcePath: string;
    }
  | { status: 'error'; error: InternalError };

/** Callbacks the expression evaluator needs from the engine. */
export interface EvalEnvironment {
  /** Path whose definition hosts this expression. */
  sitePath: string;
  /** Priority position of the hosting definition. */
  position: number;
  /** Layer id of the hosting definition. */
  layerId: string;
  /** Reads a request-context field, recording its signature. */
  readContext(key: string, collector: Collector): EvalResult;
  /** Resolves a config path from the top (its final value), recording a hop. */
  ref(path: string, collector: Collector): EvalResult;
  /** Resolves the nearest definition strictly below the hosting definition. */
  base(path: string, collector: Collector): EvalResult;
}

/** Node key: `${boundary}\u0001${path}`. */
export function nodeKey(boundary: string, path: string): string {
  return `${boundary}\u0001${path}`;
}
