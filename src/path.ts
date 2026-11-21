/**
 * Field-path resolution.
 *
 * Semantics fixed here, and shared by the indexed router and the reference
 * interpreter:
 *
 *  - a missing field and an explicitly `null` field are different; `lookup`
 *    reports presence separately from the value;
 *  - paths descend through JSON objects only. Arrays are not traversed, so a
 *    numeric path segment never indexes an array position;
 *  - every atomic condition except `exists` is false when the path is missing
 *    or holds a non-scalar / wrongly typed value.
 */

import { scalarKind } from "./types.ts";
import type { FieldPath, JsonPrimitive, ScalarKind } from "./types.ts";

export const MISSING: unique symbol = Symbol("missing");

/** Raw lookup result: a value or the MISSING marker. */
export const lookup = (root: unknown, path: FieldPath): unknown | typeof MISSING => {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const lookupPresent = (root: unknown, path: FieldPath): boolean =>
  lookup(root, path) !== MISSING;

export type ResolvedScalar = {
  kind: ScalarKind;
  value: JsonPrimitive;
};

/**
 * Scalar gate applied by `eq`, `range` and `prefix`. `undefined` means "this
 * atomic condition must be false".
 */
export const resolveScalar = (root: unknown, path: FieldPath): ResolvedScalar | undefined => {
  const value = lookup(root, path);
  if (value === MISSING) return undefined;
  const kind = scalarKind(value);
  if (kind === undefined) return undefined;
  return { kind, value: value as JsonPrimitive };
};

/** JSON scalar equality: `1`, `"1"` and `true` are all different. */
export const scalarEquals = (actual: JsonPrimitive, expected: JsonPrimitive): boolean =>
  scalarKind(actual) === scalarKind(expected) && actual === expected;
