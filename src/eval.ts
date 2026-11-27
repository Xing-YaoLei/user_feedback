/**
 * Boolean expression evaluation over feature assignments.
 *
 * An assignment is a bit mask with one bit per feature in the canonical
 * universe. `evaluate` is concrete (two-valued). `evaluatePartial` is Kleene
 * three-valued: any feature whose bit is in `undecided` and not in `mask` is
 * UNKNOWN, which lets branch-and-bound prune partial assignments early while
 * remaining sound.
 */

import type { Expr, FeatureId } from './types.ts';

export type Truth = 0 | 1 | 2;
export const FALSE = 0;
export const TRUE = 1;
export const UNKNOWN = 2;

function bitOf(bits: ReadonlyMap<FeatureId, bigint>, feature: FeatureId): bigint | null {
  return bits.get(feature) ?? null;
}

/** Concrete evaluation: every feature not present in `mask` is false. */
export function evaluate(
  expr: Expr,
  mask: bigint,
  bits: ReadonlyMap<FeatureId, bigint>,
): boolean {
  return evaluatePartial(expr, mask, 0n, bits) === TRUE;
}

export function evaluatePartial(
  expr: Expr,
  mask: bigint,
  undecided: bigint,
  bits: ReadonlyMap<FeatureId, bigint>,
): Truth {
  switch (expr.op) {
    case 'feature': {
      const bit = bitOf(bits, expr.feature);
      if (bit === null) return FALSE;
      if ((mask & bit) !== 0n) return TRUE;
      return (undecided & bit) !== 0n ? UNKNOWN : FALSE;
    }
    case 'not': {
      const inner = evaluatePartial(expr.arg, mask, undecided, bits);
      return inner === UNKNOWN ? UNKNOWN : inner === TRUE ? FALSE : TRUE;
    }
    case 'and': {
      let unknown = false;
      for (const arg of expr.args) {
        const value = evaluatePartial(arg, mask, undecided, bits);
        if (value === FALSE) return FALSE;
        if (value === UNKNOWN) unknown = true;
      }
      return unknown ? UNKNOWN : TRUE;
    }
    case 'or': {
      let unknown = false;
      for (const arg of expr.args) {
        const value = evaluatePartial(arg, mask, undecided, bits);
        if (value === TRUE) return TRUE;
        if (value === UNKNOWN) unknown = true;
      }
      return unknown ? UNKNOWN : FALSE;
    }
    case 'atMost':
    case 'atLeast':
    case 'exactly': {
      let on = 0;
      let possible = 0;
      for (const feature of expr.features) {
        const bit = bitOf(bits, feature);
        if (bit === null) continue;
        if ((mask & bit) !== 0n) on += 1;
        else if ((undecided & bit) !== 0n) possible += 1;
      }
      switch (expr.op) {
        case 'atMost':
          if (on > expr.count) return FALSE;
          if (on + possible <= expr.count) return TRUE;
          return UNKNOWN;
        case 'atLeast':
          if (on >= expr.count) return TRUE;
          if (on + possible < expr.count) return FALSE;
          return UNKNOWN;
        case 'exactly':
          if (on > expr.count) return FALSE;
          if (on + possible < expr.count) return FALSE;
          if (possible === 0) return on === expr.count ? TRUE : FALSE;
          return UNKNOWN;
      }
    }
  }
}

/** Collect every feature id mentioned by an expression. */
export function featuresOf(expr: Expr, out: Set<FeatureId> = new Set()): Set<FeatureId> {
  switch (expr.op) {
    case 'feature':
      out.add(expr.feature);
      return out;
    case 'not':
      return featuresOf(expr.arg, out);
    case 'and':
    case 'or':
      for (const arg of expr.args) featuresOf(arg, out);
      return out;
    case 'atMost':
    case 'atLeast':
    case 'exactly':
      for (const feature of expr.features) out.add(feature);
      return out;
  }
}

/** Human-readable rendering used in diagnostics and certificates. */
export function formatExpr(expr: Expr): string {
  switch (expr.op) {
    case 'feature':
      return expr.feature;
    case 'not':
      return `NOT ${formatExpr(expr.arg)}`;
    case 'and':
      return `(${expr.args.map(formatExpr).join(' AND ')})`;
    case 'or':
      return `(${expr.args.map(formatExpr).join(' OR ')})`;
    case 'atMost':
      return `at most ${expr.count} of {${expr.features.join(', ')}}`;
    case 'atLeast':
      return `at least ${expr.count} of {${expr.features.join(', ')}}`;
    case 'exactly':
      return `exactly ${expr.count} of {${expr.features.join(', ')}}`;
  }
}
