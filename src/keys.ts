/**
 * Structural keys used for interning.
 *
 * Atom keys are unique per predicate. Composite keys use interned child ids
 * rather than recursively expanded strings, so the total size of the graph's
 * keys stays linear in the number of graph nodes and edges; alternating deep
 * AND/OR nesting therefore cannot cause exponential key growth.
 */

import type { Expr, FieldPath } from "./types.ts";

export const pathKey = (path: FieldPath): string => JSON.stringify(path);

export const atomKey = (expr: Expr): string => {
  switch (expr.op) {
    case "exists":
      return JSON.stringify(["exists", expr.path]);
    case "eq":
      return JSON.stringify(["eq", expr.path, expr.value]);
    case "range":
      return JSON.stringify(["range", expr.path, expr.min, expr.max]);
    case "prefix":
      return JSON.stringify(["prefix", expr.path, expr.prefix]);
    default:
      throw new TypeError(`not an atomic condition: ${(expr as Expr).op}`);
  }
};

export const constKey = (value: boolean): string => (value ? "\u0002const:true" : "\u0002const:false");

export const notKey = (childId: number): string => `not#${childId}`;

export const junctionKey = (op: "and" | "or", childIds: readonly number[]): string =>
  `${op}#${childIds.join(",")}`;
