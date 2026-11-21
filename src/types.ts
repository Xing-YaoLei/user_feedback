/**
 * Public value and expression types for the content-routing event bus.
 *
 * The module is dependency-free and runs directly on Node's built-in
 * TypeScript type stripping, so no compilation step is required.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Semantic kind of a scalar. `null` is its own kind, which is what keeps an
 * explicitly `null` field distinct from a missing one.
 */
export type ScalarKind = "null" | "boolean" | "number" | "string";

export type FieldPath = string[];

export type Predicate =
  /** True when the path exists, whatever the value (including `null`). */
  | { op: "exists"; path: FieldPath }
  /** True when the path holds a scalar of the same JSON type and value. */
  | { op: "eq"; path: FieldPath; value: JsonPrimitive }
  /** True when the path holds an integer inside the inclusive range. */
  | { op: "range"; path: FieldPath; min: number | null; max: number | null }
  /** True when the path holds a string starting with `prefix`. */
  | { op: "prefix"; path: FieldPath; prefix: string };

export type Expr =
  | Predicate
  | { op: "not"; child: Expr }
  | { op: "and"; children: Expr[] }
  | { op: "or"; children: Expr[] }
  | { op: "const"; value: boolean };

export type Subscription = {
  id: string;
  expr: Expr;
};

export const isPredicate = (expr: Expr): expr is Predicate =>
  expr.op === "exists" || expr.op === "eq" || expr.op === "range" || expr.op === "prefix";

/** Classify a JSON value if it is a scalar; objects and arrays return `undefined`. */
export const scalarKind = (value: unknown): ScalarKind | undefined => {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return undefined;
  }
};
