/**
 * Priority-ordered definition sources and the `$base` search.
 *
 * Ordering (highest priority first):
 *
 *   position 0        : the registered-expression source (a virtual layer)
 *   position 1 .. n   : the caller's layers, exactly as supplied
 *
 * A path registered in the expression registry is *computed*: the expression
 * produces the final value of the path, reading whatever it needs below.
 * Layers still override one another beneath it, so a service value can be
 * overridden per environment and tenant. A path with no registered expression
 * simply resolves to its winning layer value.
 *
 * `$base` means: "the nearest definition of this path strictly below the layer
 * hosting this expression". For a registered expression that is the winning
 * layer value — precisely the "keep computing on top of the configured value"
 * case. For an expression written inline in a layer, it is the nearest
 * definition in the lower layers, i.e. exactly the value the inline expression
 * overrides, so a tenant can adjust an environment value without hard-coding it.
 *
 * Deletions are definitions. A deletion marker terminates the search and hides
 * every lower definition; it also prevents a registered expression from
 * resurrecting the path, because removal is an explicit operator decision.
 */

import type { Expr, ExpressionRegistry, Layer, LiteralValue } from './types.ts';
import type { Definition, InternalValue } from './internal.ts';
import {
  canonicalLiteral,
  inlineExpressionOf,
  isDeletion,
  normalizeLayerLiteral,
} from './values.ts';
import { stableStringify } from './signature.ts';

/** Synthetic layer id used for registry-backed expressions. */
export const REGISTRY_LAYER_ID = '<expression>';

/** Structural fingerprint so equivalent expressions share a cache signature. */
export function expressionFingerprint(expression: Expr): string {
  return stableStringify(expression);
}

/** A normalized layer: values keyed by path, ready for probing. */
export interface NormalizedLayer {
  id: string;
  values: ReadonlyMap<string, InternalValue>;
}

export function normalizeEntry(raw: unknown, where: string): InternalValue {
  if (isDeletion(raw)) return { kind: 'deletion' };
  const inline = inlineExpressionOf(raw);
  if (inline) {
    return {
      kind: 'expression',
      expression: inline,
      fingerprint: expressionFingerprint(inline),
    };
  }
  const literal = normalizeLayerLiteral(raw, where);
  // `{ $delete: true }` normalizes into a deletion marker rather than a value.
  if (isDeletion(literal)) return { kind: 'deletion' };
  return { kind: 'literal', literal };
}

export function normalizeLayer(layer: Layer, where: string): NormalizedLayer {
  if (typeof layer.id !== 'string' || layer.id.trim().length === 0) {
    throw new TypeError(`${where}: layer requires a non-empty string id`);
  }
  if (layer.id === REGISTRY_LAYER_ID) {
    throw new TypeError(`${where}: "${REGISTRY_LAYER_ID}" is reserved for the expression registry`);
  }
  const values = new Map<string, InternalValue>();
  for (const [path, raw] of Object.entries(layer.values ?? {})) {
    values.set(path, normalizeEntry(raw, `${where}[${JSON.stringify(path)}]`));
  }
  return { id: layer.id, values };
}

export function normalizeRegistry(
  registry: ExpressionRegistry | undefined,
): Map<string, InternalValue> {
  const values = new Map<string, InternalValue>();
  if (!registry) return values;
  for (const [path, expression] of Object.entries(registry)) {
    if (typeof expression !== 'object' || expression === null || Array.isArray(expression)) {
      throw new TypeError(`expressions[${JSON.stringify(path)}]: expression must be an object`);
    }
    values.set(path, {
      kind: 'expression',
      expression,
      fingerprint: expressionFingerprint(expression),
    });
  }
  return values;
}

/**
 * Immutable ordered definition index over one revision of the configuration.
 *
 * A batch captures one stack for its entire lifetime, which is what makes
 * "one revision per batch" hold even if the evaluator is mutated meanwhile.
 */
export class LayerStack {
  /** Source ids by position; position 0 is the expression registry. */
  readonly sourceIds: readonly string[];
  /** Layer id -> source position (registry included). */
  readonly positionById: ReadonlyMap<string, number>;
  /** Caller layer array index per source position; -1 for the registry. */
  readonly callerIndices: readonly number[];
  private readonly sources: readonly ReadonlyMap<string, InternalValue>[];

  constructor(
    registry: ReadonlyMap<string, InternalValue>,
    layers: readonly NormalizedLayer[],
  ) {
    const ids: string[] = [REGISTRY_LAYER_ID];
    const callerIndices: number[] = [-1];
    const maps: ReadonlyMap<string, InternalValue>[] = [registry];
    const positionById = new Map<string, number>([[REGISTRY_LAYER_ID, 0]]);

    layers.forEach((layer, index) => {
      if (positionById.has(layer.id)) {
        throw new TypeError(`duplicate layer id "${layer.id}"`);
      }
      positionById.set(layer.id, ids.length);
      ids.push(layer.id);
      callerIndices.push(index);
      maps.push(layer.values);
    });

    this.sourceIds = ids;
    this.callerIndices = callerIndices;
    this.sources = maps;
    this.positionById = positionById;
  }

  /** Number of sources, including the registry. */
  get size(): number {
    return this.sources.length;
  }

  /** Position of the registered-expression source (always first). */
  get registryPosition(): number {
    return 0;
  }

  /** Caller-array index of the layer at `position`; -1 for the registry. */
  callerIndexOf(position: number): number {
    return this.callerIndices[position] ?? -1;
  }

  layerIdAt(position: number): string {
    return this.sourceIds[position] ?? REGISTRY_LAYER_ID;
  }

  /**
   * Highest-priority definition of `path` at or below `fromPosition`.
   *
   * Deletions are definitions: a deletion marker terminates the search and
   * reports the path as removed, hiding every lower definition.
   */
  define(path: string, fromPosition = 0): Definition {
    const start = Math.max(0, fromPosition);
    for (let position = start; position < this.sources.length; position += 1) {
      const entry = this.sources[position]!.get(path);
      if (!entry) continue;
      const layerIndex = this.callerIndices[position]!;
      const layerId = this.sourceIds[position]!;
      if (entry.kind === 'deletion') {
        return { kind: 'deletion', position, layerIndex, layerId };
      }
      if (entry.kind === 'literal') {
        return { kind: 'literal', position, layerIndex, layerId, literal: entry.literal };
      }
      return {
        kind: 'expression',
        position,
        layerIndex,
        layerId,
        expression: entry.expression,
        fingerprint: entry.fingerprint,
      };
    }
    return { kind: 'absent' };
  }

  /**
   * Nearest definition strictly below `position`. A deletion found here stops
   * the search and reports `deleted` — an explicit removal is not a hole to
   * look past.
   */
  base(path: string, position: number): Definition {
    return this.define(path, position + 1);
  }

  /**
   * Signature of a definition, used for cache invalidation. It captures which
   * layer supplies the definition and the content it supplies, so any change
   * that could alter the resulting value or its provenance changes the key.
   */
  definitionKey(definition: Definition): string {
    switch (definition.kind) {
      case 'absent':
        return 'absent';
      case 'deletion':
        return `del@${definition.layerId}`;
      case 'literal':
        return `lit@${definition.layerId}:${canonicalLiteral(definition.literal)}`;
      case 'expression':
        return `expr@${definition.layerId}:${definition.fingerprint}`;
    }
  }
}

/** Convenience: build a stack from raw inputs. */
export function createStack(
  registry: ExpressionRegistry | undefined,
  layers: readonly Layer[],
): LayerStack {
  const registryMap = normalizeRegistry(registry);
  const normalized = layers.map((layer, index) => normalizeLayer(layer, `layers[${index}]`));
  return new LayerStack(registryMap, normalized);
}

export type { LiteralValue };
