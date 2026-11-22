/**
 * Literal normalization, canonicalization and request-context lookup.
 *
 * Callers may write layer values ergonomically (raw numbers, `"250ms"`,
 * `null`, deletion markers, inline expressions). This module normalizes them
 * into the typed `LiteralValue` union so unit handling and type checks stay
 * uniform everywhere else.
 */

import {
  makeQuantity,
  parseQuantityText,
  quantityFromValue,
  quantityToValue,
  ratToString,
} from './quantity.ts';
import type { DeletionMarker, Expr, LiteralValue, QuantityValue } from './types.ts';

/** Tags a layer value as an inline expression rather than a literal. */
export function expr(node: Expr): { $expr: Expr } {
  return { $expr: node };
}

export function deletePath(path = ''): DeletionMarker {
  return Object.freeze({ kind: 'delete' as const, path });
}

export const DELETE: DeletionMarker = deletePath('');

export function isDeletion(value: unknown): value is DeletionMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'delete'
  );
}

/** Extracts an inline expression from a layer value, if it is one. */
export function inlineExpressionOf(value: unknown): Expr | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '$expr')) {
    const inner = record.$expr;
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return null;
    return inner as Expr;
  }
  // `{ $delete: true }` is a deletion convenience, not an expression.
  if (record.$delete === true) return null;
  const keys = Object.keys(record).filter((key) => key.startsWith('$'));
  if (keys.length === 1) return record as unknown as Expr;
  return null;
}

function quantityFromTagged(input: unknown, where: string): QuantityValue {
  const raw = input as { kind?: unknown; value?: unknown; unit?: unknown };
  if (raw.kind !== 'number' || typeof raw.unit !== 'string') {
    throw new TypeError(`${where}: malformed quantity literal`);
  }
  const decimal =
    typeof raw.value === 'number'
      ? String(raw.value)
      : typeof raw.value === 'string'
        ? raw.value
        : null;
  if (decimal === null) {
    throw new TypeError(`${where}: quantity "value" must be a string or number`);
  }
  try {
    return quantityToValue(makeQuantity(decimal, raw.unit));
  } catch (error) {
    throw new TypeError(`${where}: ${(error as Error).message}`);
  }
}

/**
 * Normalizes a layer input into a literal or deletion marker. Throws for
 * unsupported shapes so mistakes surface at construction time.
 */
export function normalizeLayerLiteral(input: unknown, where: string): LiteralValue | DeletionMarker {
  if (isDeletion(input)) return deletePath();
  if (input === null) return { kind: 'null' };
  if (input === undefined) throw new TypeError(`${where}: undefined is not a valid value`);
  if (typeof input === 'boolean') return { kind: 'boolean', value: input };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError(`${where}: non-finite number`);
    return quantityToValue(makeQuantity(String(input), 'count'));
  }
  if (typeof input === 'string') {
    const parsed = parseQuantityText(input);
    if (parsed) return quantityToValue(parsed);
    return { kind: 'string', value: input };
  }
  if (typeof input === 'object') {
    const tagged = input as { kind?: unknown };
    if (tagged.kind === 'number') return quantityFromTagged(input, where);
    if (tagged.kind === 'string') {
      const value = (input as { value?: unknown }).value;
      if (typeof value !== 'string') throw new TypeError(`${where}: malformed string literal`);
      return { kind: 'string', value };
    }
    if (tagged.kind === 'boolean') {
      const value = (input as { value?: unknown }).value;
      if (typeof value !== 'boolean') throw new TypeError(`${where}: malformed boolean literal`);
      return { kind: 'boolean', value };
    }
    if (tagged.kind === 'null') return { kind: 'null' };
    if ((input as Record<string, unknown>).$delete === true) return deletePath();
    throw new TypeError(`${where}: unsupported object value; use a tagged literal`);
  }
  throw new TypeError(`${where}: unsupported value type ${typeof input}`);
}

/** Normalizes a value read from the request context. */
export function normalizeContextValue(input: unknown, where: string): LiteralValue {
  if (input === undefined) {
    throw new TypeError(`${where}: undefined is not a value; treat the field as unset`);
  }
  if (Array.isArray(input)) throw new TypeError(`${where}: arrays are not scalar values`);
  if (typeof input === 'object' && input !== null) {
    const tagged = input as { kind?: unknown };
    const allowed = ['number', 'string', 'boolean', 'null'];
    if (typeof tagged.kind !== 'string' || !allowed.includes(tagged.kind)) {
      throw new TypeError(`${where}: context values must be scalars`);
    }
  }
  const normalized = normalizeLayerLiteral(input, where);
  if (isDeletion(normalized)) {
    throw new TypeError(`${where}: context values cannot be deletion markers`);
  }
  return normalized;
}

/** Stable canonical text used for signatures and equality checks. */
export function canonicalLiteral(value: LiteralValue): string {
  switch (value.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return `b|${value.value ? '1' : '0'}`;
    case 'string':
      return `s|${JSON.stringify(value.value)}`;
    case 'number': {
      const q = quantityFromValue(value);
      return `n|${q.unit}|${ratToString(q.r)}`;
    }
  }
}

export function literalTypeName(value: LiteralValue | null): string {
  if (value === null) return 'missing';
  return value.kind === 'number' ? 'quantity' : value.kind;
}

/** Deep snapshot of the request context; rejects cycles and functions. */
export function snapshotContext(
  input: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const source = input ?? {};
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError('context must be a plain object');
  }
  const clone = (value: unknown, seen: Set<unknown>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new TypeError('context cannot contain cycles');
    seen.add(value);
    if (Array.isArray(value)) {
      const out = value.map((item) => clone(item, seen));
      seen.delete(value);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = clone((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return out;
  };
  return clone(source, new Set()) as Record<string, unknown>;
}

export interface ContextLookup {
  found: boolean;
  value: unknown;
}

/**
 * Resolves `a.b.c` against the context. An exact top-level key wins, so dotted
 * keys are supported alongside nested objects.
 */
export function lookupContext(
  context: Readonly<Record<string, unknown>>,
  accessPath: string,
): ContextLookup {
  if (Object.hasOwn(context, accessPath)) {
    return { found: true, value: context[accessPath] };
  }
  const segments = accessPath.split('.').filter((part) => part.length > 0);
  if (segments.length === 0) return { found: false, value: undefined };
  let current: unknown = context;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return { found: false, value: undefined };
    }
    if (!Object.hasOwn(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}
