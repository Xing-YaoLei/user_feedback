/**
 * The evaluation engine.
 *
 * A batch pins exactly one revision: the layer stack, context snapshot and
 * revision number are captured when the batch begins and never re-read. All
 * reference resolution, branch selection and type checking inside that batch
 * are therefore interpreted against a single consistent configuration, even if
 * the evaluator is mutated while the batch is alive.
 *
 * Caching is dependency-driven. Each cached node records:
 *
 * - the definition it resolved to (`definitionKey`: winning layer id + content),
 * - the context signatures it read directly,
 * - the signature of every node it referenced.
 *
 * A node is reused only when all three still match. Because signatures describe
 * *observable outcomes* rather than revisions, an unrelated layer or context
 * change leaves every dependent reusable, while a change that alters an output
 * propagates to all transitive dependents.
 */

import type {
  BatchResult,
  CacheStats,
  EvaluationError,
  EvaluatorOptions,
  ExpressionRegistry,
  Layer,
  LayerInputValue,
  LayerUpdate,
  MissingResult,
  RefHop,
  ResultProvenance,
  ResultValue,
} from './types.ts';
import type {
  Collector,
  Definition,
  DepEdge,
  EvalEnvironment,
  EvalResult,
  InternalError,
  NodeEntry,
  NodeProvenance,
} from './internal.ts';
import { newCollector } from './internal.ts';
import { LayerStack, REGISTRY_LAYER_ID, createStack } from './layers.ts';
import { evaluateExpression } from './expression.ts';
import { quantityFromValue } from './quantity.ts';
import { contextSignature, digest, stableStringify } from './signature.ts';
import {
  canonicalLiteral,
  lookupContext,
  normalizeContextValue,
  snapshotContext,
} from './values.ts';

const ROOT_BOUNDARY = '\u0000root';
const SEPARATOR = '\u0001';

interface MutableStats {
  evaluations: number;
  cacheHits: number;
  cacheMisses: number;
  hitsByPath: Map<string, number>;
  recomputationsByPath: Map<string, number>;
  expressionEvaluationsByPath: Map<string, number>;
  nodeHitsByPath: Map<string, number>;
  batches: number;
  revision: number;
}

function createStats(revision: number): MutableStats {
  return {
    evaluations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hitsByPath: new Map(),
    recomputationsByPath: new Map(),
    expressionEvaluationsByPath: new Map(),
    nodeHitsByPath: new Map(),
    batches: 0,
    revision,
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function cloneStats(stats: MutableStats): MutableStats {
  return {
    evaluations: stats.evaluations,
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    hitsByPath: new Map(stats.hitsByPath),
    recomputationsByPath: new Map(stats.recomputationsByPath),
    expressionEvaluationsByPath: new Map(stats.expressionEvaluationsByPath),
    nodeHitsByPath: new Map(stats.nodeHitsByPath),
    batches: stats.batches,
    revision: stats.revision,
  };
}

/** Thrown to abandon a freshness walk that cannot be proven safe. */
class ValidationAbort extends Error {}

interface ResolvedNode {
  entry: NodeEntry;
  /** True when it was proven fresh against a previously cached entry. */
  fromCache: boolean;
}

export interface BatchOptions {
  /** Overrides the evaluator context for this batch only. */
  context?: Readonly<Record<string, unknown>>;
  /** Overrides the reported revision (replay/testing aid). */
  revision?: number;
}

export interface EvaluateOneOutcome {
  ok: boolean;
  result?: ResultValue;
  missing?: MissingResult;
  error?: EvaluationError;
}

/**
 * One batch of evaluations sharing a pinned revision, layer stack and context.
 */
export class EvaluationBatch {
  readonly revision: number;
  readonly context: Readonly<Record<string, unknown>>;
  private readonly stack: LayerStack;
  private readonly cache: Map<string, NodeEntry>;
  private readonly stats: MutableStats;
  private readonly ctxSignatureCache = new Map<string, string>();
  private readonly resolved = new Map<string, NodeEntry>();
  /** Nodes in `resolved` that were proven fresh from the persistent cache. */
  private readonly servedFromCache = new Set<string>();
  private readonly freshness = new Map<string, boolean>();
  private readonly validatingKeys = new Set<string>();
  private readonly active = new Set<string>();
  private readonly activePaths: string[] = [];
  private validating = false;

  constructor(
    stack: LayerStack,
    context: Readonly<Record<string, unknown>>,
    revision: number,
    cache: Map<string, NodeEntry>,
    stats: MutableStats,
  ) {
    this.stack = stack;
    this.context = context;
    this.revision = revision;
    this.cache = cache;
    this.stats = stats;
  }

  evaluate(paths: readonly string[]): BatchResult {
    if (!Array.isArray(paths)) throw new TypeError('evaluate(paths): paths must be an array');
    this.stats.batches += 1;
    const values: Record<string, ResultValue> = {};
    const missing: string[] = [];
    const missingDetail: Record<string, MissingResult> = {};
    const errors: Record<string, EvaluationError> = {};
    const outcomes: BatchResult['outcomes'] = {};

    for (const rawPath of paths) {
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        throw new TypeError('evaluate(paths): every path must be a non-empty string');
      }
      const path = rawPath;
      const resolved = this.resolve(path, 0);
      const entry = resolved.entry;

      this.stats.evaluations += 1;
      // Only a node validated against the persistent cache counts as a root
      // cache hit; one merely memoized earlier in this same batch was still
      // computed under this revision.
      if (resolved.fromCache) {
        this.stats.cacheHits += 1;
        bump(this.stats.hitsByPath, path);
      } else {
        this.stats.cacheMisses += 1;
      }

      if (entry.status === 'value') {
        const result: ResultValue = {
          value: entry.value!,
          layer: entry.provenance!.layer,
          definition: projectProvenance(entry.provenance!, path, this.revision),
          revision: this.revision,
        };
        values[path] = result;
        outcomes[path] = { ok: true, result };
      } else if (entry.status === 'missing') {
        const detail: MissingResult = {
          missing: true,
          path,
          reason: entry.missing!.reason,
          definitionLayer: entry.missing!.definitionLayer,
          revision: this.revision,
          dependencies: entry.missing!.dependencies.slice(),
        };
        missing.push(path);
        missingDetail[path] = detail;
        outcomes[path] = { ok: false, missing: detail };
      } else {
        const error: EvaluationError = {
          code: entry.error!.code,
          source: entry.error!.source,
          sources: entry.error!.sources.slice(),
          message: entry.error!.message,
          refs: entry.error!.refs.map(copyHop),
          path,
          revision: this.revision,
        };
        errors[path] = error;
        outcomes[path] = { ok: false, error };
      }
    }

    return { revision: this.revision, values, missing, missingDetail, errors, outcomes };
  }

  evaluateOne(path: string): EvaluateOneOutcome {
    const batch = this.evaluate([path]);
    const outcome = batch.outcomes[path]!;
    if (outcome.ok) return { ok: true, result: outcome.result };
    if ('missing' in outcome) return { ok: false, missing: outcome.missing };
    return { ok: false, error: outcome.error };
  }

  // --------------------------------------------------------------- addressing

  /** Boundary id for a search start; stable across layer insertions by id. */
  private boundaryOf(from: number): string {
    if (from <= 0) return ROOT_BOUNDARY;
    return this.stack.layerIdAt(from - 1);
  }

  /** Search start position for a boundary id; null when it no longer exists. */
  private fromOfBoundary(boundary: string): number | null {
    if (boundary === ROOT_BOUNDARY) return 0;
    const position = this.stack.positionById.get(boundary);
    return position === undefined ? null : position + 1;
  }

  private static keyOf(boundary: string, path: string): string {
    return `${boundary}${SEPARATOR}${path}`;
  }

  /**
   * Cache key describing what actually defines `path`, taking into account that
   * a layer deletion suppresses a registered expression.
   */
  private effectiveDefinitionKey(path: string, from: number, definition: Definition): string {
    const base = this.stack.definitionKey(definition);
    if (definition.kind === 'expression' && definition.layerId === REGISTRY_LAYER_ID) {
      const chain = this.stack.define(path, Math.max(1, from + 1));
      if (chain.kind === 'deletion') return `${base}|suppressed:${chain.layerId}`;
    }
    return base;
  }

  // ---------------------------------------------------------------- resolving

  private resolve(path: string, from: number): ResolvedNode {
    const boundary = this.boundaryOf(from);
    const key = EvaluationBatch.keyOf(boundary, path);

    const memo = this.resolved.get(key);
    if (memo) {
      return { entry: memo, fromCache: this.servedFromCache.has(key) };
    }

    if (this.active.has(key)) {
      if (this.validating) throw new ValidationAbort();
      return { entry: this.cycleEntry(path, key), fromCache: false };
    }

    const cached = this.cache.get(key);
    if (cached && this.isFresh(cached, path, boundary, key)) {
      bump(this.stats.nodeHitsByPath, path);
      this.resolved.set(key, cached);
      this.servedFromCache.add(key);
      return { entry: cached, fromCache: true };
    }

    this.active.add(key);
    this.activePaths.push(path);
    let entry: NodeEntry;
    try {
      entry = this.compute(path, from, key);
    } finally {
      this.active.delete(key);
      this.activePaths.pop();
    }
    if (entry.cacheable) this.cache.set(key, entry);
    this.resolved.set(key, entry);
    this.servedFromCache.delete(key);
    return { entry, fromCache: false };
  }

  /**
   * True when a cached node's definition, context reads and dependency
   * signatures all still match. Dependency signatures are themselves validated
   * recursively, so a change anywhere downstream (including a path that was
   * previously missing or deleted) is noticed.
   */
  private isFresh(entry: NodeEntry, path: string, boundary: string, key: string): boolean {
    const memo = this.freshness.get(key);
    if (memo !== undefined) return memo;
    if (this.validatingKeys.has(key)) throw new ValidationAbort();

    this.validatingKeys.add(key);
    try {
      const fresh = this.proveFresh(entry, path, boundary);
      this.freshness.set(key, fresh);
      return fresh;
    } finally {
      this.validatingKeys.delete(key);
    }
  }

  private proveFresh(entry: NodeEntry, path: string, boundary: string): boolean {
    const from = this.fromOfBoundary(boundary);
    if (from === null) return false;

    const definition = this.stack.define(path, from);
    if (this.effectiveDefinitionKey(path, from, definition) !== entry.definitionKey) return false;

    for (const { key, signature } of entry.ctxSignatures) {
      if (this.contextSig(key) !== signature) return false;
    }

    const wasValidating = this.validating;
    this.validating = true;
    try {
      for (const dep of entry.depSignatures) {
        const depFrom = this.fromOfBoundary(dep.boundary);
        if (depFrom === null) return false;
        let depEntry: NodeEntry;
        try {
          depEntry = this.resolve(dep.path, depFrom).entry;
        } catch (error) {
          if (error instanceof ValidationAbort) return false;
          throw error;
        }
        if (depEntry.signature !== dep.signature) return false;
      }
    } finally {
      this.validating = wasValidating;
    }
    return true;
  }

  private cycleEntry(path: string, key: string): NodeEntry {
    const start = this.activePaths.lastIndexOf(path);
    const chain = [...this.activePaths.slice(start >= 0 ? start : 0), path];
    const error: InternalError = {
      code: 'cycle',
      source: path,
      sources: chain.slice(),
      message: `cycle detected: ${chain.join(' -> ')}`,
      refs: [],
    };
    return this.errorEntry(key, path, error, false, chain[0] ?? path);
  }

  private errorEntry(
    key: string,
    path: string,
    error: InternalError,
    cacheable: boolean,
    definitionKey = 'cycle',
  ): NodeEntry {
    return {
      key,
      path,
      fromPosition: 0,
      definitionKey,
      signature: `e|${error.code}|${error.source}|${error.message}`,
      status: 'error',
      layerId: null,
      kind: 'expression',
      error,
      ctxSignatures: [],
      depSignatures: [],
      transContextKeys: [],
      transReferencedPaths: [],
      transRefs: [],
      transBaseLookups: [],
      computedAtRevision: this.revision,
      cacheable,
    };
  }

  private compute(path: string, from: number, key: string): NodeEntry {
    bump(this.stats.recomputationsByPath, path);
    const definition = this.stack.define(path, from);
    const definitionKey = this.effectiveDefinitionKey(path, from, definition);

    const shell: NodeEntry = {
      key,
      path,
      fromPosition: from,
      definitionKey,
      signature: '',
      status: 'missing',
      layerId: null,
      kind: 'absent',
      ctxSignatures: [],
      depSignatures: [],
      transContextKeys: [],
      transReferencedPaths: [],
      transRefs: [],
      transBaseLookups: [],
      computedAtRevision: this.revision,
      cacheable: true,
    };

    if (definition.kind === 'absent') {
      shell.missing = { reason: 'absent', definitionLayer: null, dependencies: [] };
      shell.signature = 'm|absent';
      return shell;
    }

    if (definition.kind === 'deletion') {
      shell.kind = 'layer';
      shell.layerId = definition.layerId;
      shell.missing = {
        reason: 'deleted',
        definitionLayer: definition.layerId,
        dependencies: [`delete:${path}`],
      };
      shell.signature = `m|deleted|${definition.layerId}`;
      return shell;
    }

    if (definition.kind === 'literal') {
      shell.status = 'value';
      shell.kind = 'layer';
      shell.layerId = definition.layerId;
      shell.value = definition.literal;
      if (definition.literal.kind === 'number') {
        shell.exact = quantityFromValue(definition.literal);
      }
      shell.provenance = {
        path,
        layer: definition.layerId,
        layerIndex: definition.layerIndex,
        kind: 'layer',
        literal: definition.literal,
        dependencies: [`layer:${definition.layerId}`],
        refs: [],
        referencedPaths: [],
        contextKeys: [],
        baseLookups: [],
        evaluatedAtRevision: this.revision,
      };
      shell.signature = `v|${definitionKey}`;
      return shell;
    }

    // A registered expression computes a path, but it cannot resurrect one a
    // layer explicitly deleted: the deletion wins and the path is missing.
    if (definition.layerId === REGISTRY_LAYER_ID) {
      const layerDefinition = this.stack.define(path, 1);
      if (layerDefinition.kind === 'deletion') {
        shell.kind = 'layer';
        shell.layerId = layerDefinition.layerId;
        shell.missing = {
          reason: 'deleted',
          definitionLayer: layerDefinition.layerId,
          dependencies: [`delete:${path}`],
        };
        shell.signature = `m|deleted|${layerDefinition.layerId}`;
        return shell;
      }
    }

    return this.computeExpression(path, definition, shell);
  }

  private computeExpression(
    path: string,
    definition: Extract<Definition, { kind: 'expression' }>,
    shell: NodeEntry,
  ): NodeEntry {
    const collector = newCollector();
    const env: EvalEnvironment = {
      sitePath: path,
      position: definition.position,
      layerId: definition.layerId,
      readContext: (ctxKey, target) => this.readContext(ctxKey, target),
      ref: (targetPath, target) => this.hop(targetPath, 0, 'ref', target),
      base: (targetPath, target) => this.hop(targetPath, definition.position + 1, 'base', target),
    };

    const result = evaluateExpression(definition.expression, env, collector);
    bump(this.stats.expressionEvaluationsByPath, path);

    shell.kind = 'expression';
    shell.ctxSignatures = [...collector.ctxSignatures.entries()].map(([key, signature]) => ({
      key,
      signature,
    }));
    shell.depSignatures = [...collector.deps.values()].map((dep) => ({ ...dep }));
    shell.transContextKeys = [...collector.transContextKeys].sort();
    shell.transReferencedPaths = [...collector.transReferencedPaths].sort();
    shell.transRefs = dedupeHops(collector.transRefs);
    shell.transBaseLookups = collector.transBaseLookups.map((lookup) => ({ ...lookup }));
    if (collector.uncacheable) shell.cacheable = false;

    if (result.status === 'value') {
      shell.status = 'value';
      shell.layerId = definition.layerId;
      shell.value = result.value;
      shell.exact = result.exact;
      const provenance: ResultProvenance = {
        path,
        layer: definition.layerId,
        layerIndex: definition.layerIndex,
        kind: 'expression',
        expression: definition.expression,
        dependencies: collector.labels.slice(),
        refs: shell.transRefs.map(copyHop),
        referencedPaths: shell.transReferencedPaths.slice(),
        contextKeys: shell.transContextKeys.slice(),
        baseLookups: shell.transBaseLookups.map((lookup) => ({ ...lookup })),
        evaluatedAtRevision: this.revision,
      };
      shell.provenance = provenance;
      shell.signature = `v|${shell.definitionKey}|${canonicalLiteral(result.value)}|${this.dependencyFingerprint(
        shell,
      )}`;
      return shell;    }

    if (result.status === 'missing') {
      shell.status = 'missing';
      shell.layerId = definition.layerId;
      shell.missing = {
        reason: result.reason,
        definitionLayer: definition.layerId,
        dependencies: collector.labels.slice(),
      };
      shell.signature = `m|${result.reason}|${shell.definitionKey}|${result.sourcePath}|${this.dependencyFingerprint(
        shell,
      )}`;
      return shell;
    }

    shell.status = 'error';
    shell.layerId = definition.layerId;
    shell.error = result.error;
    if (result.error.code === 'cycle') shell.cacheable = false;
    shell.signature = `e|${result.error.code}|${result.error.source}|${result.error.message}|${this.dependencyFingerprint(
      shell,
    )}`;
    return shell;
  }

  /**
   * Fingerprint of the exact dependency chain a node observed (which paths,
   * from which boundaries, with which node signatures). Folding it into the
   * node signature means an outcome only compares equal when its provenance is
   * equivalent too, so a reused node never reports a stale chain.
   */
  private dependencyFingerprint(entry: NodeEntry): string {
    const parts: string[] = [];
    for (const dep of entry.depSignatures) parts.push(`${dep.boundary}:${dep.path}:${dep.signature}`);
    for (const ctx of entry.ctxSignatures) parts.push(`ctx:${ctx.key}:${ctx.signature}`);
    const baseParts = entry.transBaseLookups.map(
      (lookup) => `${lookup.path}|${lookup.layer ?? '-'}|${lookup.result}`,
    );
    return digest(stableStringify({ deps: parts, base: baseParts }));
  }

  // ------------------------------------------------------------- dependencies

  private contextSig(key: string): string {
    const cached = this.ctxSignatureCache.get(key);
    if (cached !== undefined) return cached;
    const lookup = lookupContext(this.context, key);
    const signature =
      lookup.found && lookup.value !== undefined ? contextSignature(lookup.value) : 'absent';
    this.ctxSignatureCache.set(key, signature);
    return signature;
  }

  private readContext(key: string, collector: Collector): EvalResult {
    const signature = this.contextSig(key);
    collector.ctxSignatures.set(key, signature);
    collector.labels.push(`ctx:${key}`);
    collector.transContextKeys.add(key);

    const lookup = lookupContext(this.context, key);
    if (!lookup.found || lookup.value === undefined) {
      collector.labels.push(`ctx:${key}=missing`);
      return {
        status: 'missing',
        reason: 'absent',
        layerId: null,
        labels: [],
        sourcePath: `context:${key}`,
      };
    }
    try {
      const literal = normalizeContextValue(lookup.value, `context.${key}`);
      return {
        status: 'value',
        value: literal,
        exact: literal.kind === 'number' ? quantityFromValue(literal) : undefined,
        origin: `context:${key}`,
      };
    } catch (error) {
      return {
        status: 'error',
        error: {
          code: 'type_mismatch',
          source: `context:${key}`,
          sources: [`context:${key}`],
          message: (error as Error).message,
          refs: [],
        },
      };
    }
  }

  private hop(
    targetPath: string,
    from: number,
    via: 'ref' | 'base',
    collector: Collector,
  ): EvalResult {
    const { entry } = this.resolve(targetPath, from);
    const hopRef: RefHop = { path: targetPath, layer: entry.layerId, via };

    collector.refs.push(hopRef);
    collector.transRefs.push(hopRef);
    collector.labels.push(`${via}:${targetPath}${entry.layerId ? `@${entry.layerId}` : ''}`);
    collector.transReferencedPaths.add(targetPath);
    for (const referenced of entry.transReferencedPaths) {
      collector.transReferencedPaths.add(referenced);
    }
    for (const contextKey of entry.transContextKeys) {
      collector.transContextKeys.add(contextKey);
    }
    for (const nested of entry.transRefs) collector.transRefs.push(nested);
    for (const lookup of entry.transBaseLookups) {
      collector.transBaseLookups.push({ ...lookup });
    }
    if (entry.status === 'error' && entry.error?.code === 'cycle') {
      collector.uncacheable = true;
    }

    if (via === 'base') {
      const outcome =
        entry.status === 'value'
          ? 'value'
          : entry.status === 'missing' && entry.missing?.reason === 'deleted'
            ? 'deleted'
            : 'absent';
      collector.transBaseLookups.push({
        path: targetPath,
        fromLayer: this.stack.layerIdAt(Math.max(0, from - 1)),
        layer: entry.layerId,
        result: outcome,
      });
    }

    const edge: DepEdge = {
      boundary: this.boundaryOf(from),
      path: targetPath,
      signature: entry.signature,
    };
    collector.deps.set(`${via}${SEPARATOR}${targetPath}`, edge);

    if (entry.status === 'value') {
      return {
        status: 'value',
        value: entry.value!,
        exact: entry.exact,
        origin: targetPath,
      };
    }
    if (entry.status === 'missing') {
      return {
        status: 'missing',
        reason: entry.missing!.reason,
        layerId: entry.layerId,
        labels: [],
        sourcePath: targetPath,
      };
    }
    return {
      status: 'error',
      error: { ...entry.error!, refs: [hopRef, ...entry.error!.refs] },
    };
  }
}

function copyHop(hop: RefHop): RefHop {
  return { path: hop.path, layer: hop.layer, via: hop.via };
}

/** Builds the public provenance record, marked with the batch revision. */
function projectProvenance(
  provenance: NodeProvenance,
  path: string,
  revision: number,
): ResultProvenance {
  return {
    path,
    layer: provenance.layer,
    layerIndex: provenance.layerIndex,
    kind: provenance.kind,
    ...(provenance.expression !== undefined ? { expression: provenance.expression } : {}),
    ...(provenance.literal !== undefined ? { literal: provenance.literal } : {}),
    dependencies: provenance.dependencies.slice(),
    refs: provenance.refs.map(copyHop),
    referencedPaths: provenance.referencedPaths.slice(),
    contextKeys: provenance.contextKeys.slice(),
    baseLookups: provenance.baseLookups.map((lookup) => ({ ...lookup })),
    evaluatedAtRevision: revision,
  };
}

function dedupeHops(hops: RefHop[]): RefHop[] {
  const out: RefHop[] = [];
  for (const hop of hops) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.path === hop.path &&
      previous.via === hop.via &&
      previous.layer === hop.layer
    ) {
      continue;
    }
    out.push(copyHop(hop));
  }
  return out;
}

export class ConfigEvaluator {
  private layers: Layer[];
  private expressions: ExpressionRegistry;
  private context: Record<string, unknown>;
  private revision: number;
  private stack: LayerStack;
  private readonly cache = new Map<string, NodeEntry>();
  private statsData: MutableStats;

  constructor(options: EvaluatorOptions) {
    if (!options || !Array.isArray(options.layers)) {
      throw new TypeError('createConfigEvaluator: options.layers must be an array');
    }
    this.layers = cloneLayers(options.layers);
    this.expressions = cloneExpressions(options.expressions ?? {});
    this.context = deepFreeze(snapshotContext(options.context));
    this.revision = options.revision ?? 1;
    this.stack = createStack(this.expressions, this.layers);
    this.statsData = createStats(this.revision);
  }

  get currentRevision(): number {
    return this.revision;
  }

  getContext(): Readonly<Record<string, unknown>> {
    return this.context;
  }

  getLayerIds(): string[] {
    return this.layers.map((layer) => layer.id);
  }

  /** Replaces the immutable request context; returns the new revision. */
  setContext(context: Readonly<Record<string, unknown>>): number {
    const next = deepFreeze(snapshotContext(context));
    this.context = next;
    this.revision += 1;
    this.statsData.revision = this.revision;
    return this.revision;
  }

  /**
   * Applies one layer/expression update atomically. Cached nodes are retained;
   * each is revalidated against the new stack, so only genuinely affected
   * results recompute. If the update is invalid the evaluator is unchanged.
   */
  update(update: LayerUpdate): number {
    if (!update || typeof update !== 'object') {
      throw new TypeError('update(update): update must be an object');
    }

    const nextLayers = cloneLayers(this.layers);
    let nextExpressions = this.expressions;

    switch (update.type) {
      case 'set': {
        const layer = findLayer(nextLayers, update.layer);
        layer.values[update.path] = cloneValue(update.value, `set ${update.layer}/${update.path}`);
        break;
      }
      case 'delete': {
        const layer = findLayer(nextLayers, update.layer);
        delete layer.values[update.path];
        break;
      }
      case 'addLayer': {
        if (!update.layer || typeof update.layer.id !== 'string' || !update.layer.id) {
          throw new TypeError('addLayer: layer requires a non-empty string id');
        }
        const at = update.at ?? 0;
        if (!Number.isInteger(at) || at < 0 || at > nextLayers.length) {
          throw new RangeError(`addLayer: index ${at} is out of range`);
        }
        nextLayers.splice(at, 0, {
          id: update.layer.id,
          values: cloneLayerValues(update.layer.values ?? {}),
        });
        break;
      }
      case 'removeLayer': {
        const index = nextLayers.findIndex((layer) => layer.id === update.layer);
        if (index < 0) throw new RangeError(`removeLayer: unknown layer "${update.layer}"`);
        nextLayers.splice(index, 1);
        break;
      }
      case 'setExpressions': {
        nextExpressions = cloneExpressions(update.expressions ?? {});
        break;
      }
      default: {
        throw new TypeError(
          `unknown update type ${String((update as { type?: unknown }).type)}`,
        );
      }
    }

    // Build first: a duplicate layer id or malformed value throws here and
    // leaves the evaluator exactly as it was.
    const nextStack = createStack(nextExpressions, nextLayers);

    this.layers = nextLayers;
    this.expressions = nextExpressions;
    this.stack = nextStack;
    this.revision += 1;
    this.statsData.revision = this.revision;
    return this.revision;
  }

  /** Convenience for `update({ type: 'delete', ... })`. */
  removeEntry(layerId: string, path: string): number {
    return this.update({ type: 'delete', layer: layerId, path });
  }

  /** Immutable variant: returns a new evaluator carrying a copy of the cache. */
  withLayerUpdate(update: LayerUpdate): ConfigEvaluator {
    const next = new ConfigEvaluator({
      layers: cloneLayers(this.layers),
      expressions: cloneExpressions(this.expressions),
      context: snapshotContext(this.context),
      revision: this.revision,
    });
    for (const [key, entry] of this.cache) next.cache.set(key, entry);
    next.statsData = cloneStats(this.statsData);
    next.update(update);
    return next;
  }

  beginBatch(options: BatchOptions = {}): EvaluationBatch {
    const source = options.context !== undefined ? snapshotContext(options.context) : this.context;
    const context = deepFreeze(deepClone(source));
    return new EvaluationBatch(
      this.stack,
      context,
      options.revision ?? this.revision,
      this.cache,
      this.statsData,
    );
  }

  /** Evaluates `paths` under one pinned revision. */
  evaluate(paths: readonly string[], context?: Readonly<Record<string, unknown>>): BatchResult {
    return this.beginBatch(context === undefined ? {} : { context }).evaluate(paths);
  }

  evaluateOne(path: string, context?: Readonly<Record<string, unknown>>): EvaluateOneOutcome {
    return this.beginBatch(context === undefined ? {} : { context }).evaluateOne(path);
  }

  getStats(): CacheStats {
    return {
      evaluations: this.statsData.evaluations,
      cacheHits: this.statsData.cacheHits,
      cacheMisses: this.statsData.cacheMisses,
      hitsByPath: toRecord(this.statsData.hitsByPath),
      recomputationsByPath: toRecord(this.statsData.recomputationsByPath),
      expressionEvaluationsByPath: toRecord(this.statsData.expressionEvaluationsByPath),
      nodeHitsByPath: toRecord(this.statsData.nodeHitsByPath),
      batches: this.statsData.batches,
      revision: this.revision,
    };
  }

  /** Recomputations of one path across all batches. */
  recomputations(path: string): number {
    return this.statsData.recomputationsByPath.get(path) ?? 0;
  }

  resetStats(): void {
    this.statsData = createStats(this.revision);
  }
}

// -------------------------------------------------------------------- cloning

function findLayer(layers: Layer[], id: string): Layer {
  const layer = layers.find((candidate) => candidate.id === id);
  if (!layer) throw new RangeError(`unknown layer "${id}"`);
  return layer;
}

function cloneValue(value: LayerInputValue, where: string): LayerInputValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) throw new TypeError(`${where}: layer values must not be arrays`);
  return deepClone(value) as LayerInputValue;
}

function cloneLayerValues(
  values: Record<string, LayerInputValue>,
): Record<string, LayerInputValue> {
  const out: Record<string, LayerInputValue> = {};
  for (const [path, value] of Object.entries(values)) {
    out[path] = cloneValue(value, `layer value "${path}"`);
  }
  return out;
}

function cloneLayers(layers: readonly Layer[]): Layer[] {
  return layers.map((layer, index) => {
    if (!layer || typeof layer.id !== 'string' || layer.id.length === 0) {
      throw new TypeError(`layers[${index}]: layer requires a non-empty string id`);
    }
    return { id: layer.id, values: cloneLayerValues(layer.values ?? {}) };
  });
}

function cloneExpressions(expressions: ExpressionRegistry): ExpressionRegistry {
  const out: ExpressionRegistry = {};
  for (const [path, expression] of Object.entries(expressions ?? {})) {
    out[path] = deepClone(expression) as ExpressionRegistry[string];
  }
  return out;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) out[key] = deepClone(source[key]);
  return out as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Factory matching the README's usage. */
export function createConfigEvaluator(options: EvaluatorOptions): ConfigEvaluator {
  return new ConfigEvaluator(options);
}
