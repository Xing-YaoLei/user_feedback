/**
 * Direct interpreter: the reference semantic implementation.
 *
 * It walks the expression tree per event and resolves every path, which is
 * exactly the naive baseline the indexed router is compared against. The
 * router must produce the same set of subscription ids for every event.
 */

import { lookupPresent, resolveScalar, scalarEquals, MISSING } from "./path.ts";
import type { Expr, JsonPrimitive, Predicate } from "./types.ts";

export const matchesExpr = (expr: Expr, event: unknown): boolean => {
  switch (expr.op) {
    case "const":
      return expr.value;
    case "exists":
      return lookupPresent(event, expr.path);
    case "eq":
    case "range":
    case "prefix":
      return matchesPredicate(expr, event);
    case "not":
      return !matchesExpr(expr.child, event);
    case "and": {
      for (const child of expr.children) {
        if (!matchesExpr(child, event)) return false;
      }
      return true;
    }
    case "or": {
      for (const child of expr.children) {
        if (matchesExpr(child, event)) return true;
      }
      return false;
    }
  }
};

export const matchesPredicate = (predicate: Predicate, event: unknown): boolean => {
  const resolved = resolveScalar(event, predicate.path);
  if (resolved === undefined) return false;
  const value: JsonPrimitive = resolved.value;
  switch (predicate.op) {
    case "exists":
      return true;
    case "eq":
      return scalarEquals(value, predicate.value);
    case "range":
      return (
        resolved.kind === "number" &&
        Number.isInteger(value as number) &&
        (predicate.min === null || (value as number) >= predicate.min) &&
        (predicate.max === null || (value as number) <= predicate.max)
      );
    case "prefix":
      return resolved.kind === "string" && (value as string).startsWith(predicate.prefix);
  }
};

export { MISSING };
