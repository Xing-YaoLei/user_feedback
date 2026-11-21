/**
 * Compiled node graph with reference-counted structural sharing.
 *
 * Compilation interns every distinct expression by structural key. A node is
 * created once and shared by all subscriptions and parents that use it. Each
 * node tracks how many root subscriptions reach it transitively (`rootRefs`)
 * and how many parents point at it (`parents`). Retiring a subscription walks
 * its graph once and decrements those counters; nodes that reach zero
 * references are released together with their index entries. A shared
 * subexpression that is still used elsewhere is therefore never evicted.
 */

import { FieldIndices } from "./field-indices.ts";
import { MISSING, lookup, resolveScalar } from "../path.ts";
import { atomKey, constKey, junctionKey, notKey, pathFromKey, pathKey } from "../keys.ts";
import type { Expr, JsonPrimitive, Predicate } from "../types.ts";

export const enum NodeKind {
  Const = 0,
  Atom = 1,
  Not = 2,
  And = 3,
  Or = 4,
}

export interface GraphNode {
  id: number;
  key: string;
  kind: NodeKind;
  /** For Const. */
  constant: boolean;
  /** For Atom: the predicate (authoritative semantics) and its atom id. */
  predicate?: Predicate;
  atomId: number;
  /** Field path key for atoms; empty for composites. */
  field: string;
  children: number[];
  /** Number of root subscriptions that reach this node. */
  rootRefs: number;
  /** Number of live parent references. */
  parents: number;
  /** Number of distinct subscriptions whose own root is this exact node. */
  ownRoots: number;
}

export class NodeGraph {
  readonly nodes: GraphNode[] = [];
  private readonly byKey = new Map<string, number>();
  readonly fields = new Map<string, FieldIndices>();
  private readonly freeIds: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  node(id: number): GraphNode {
    return this.nodes[id]!;
  }

  /** Intern a constant node. */
  constNode(value: boolean): number {
    const key = constKey(value);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.allocate();
    this.nodes[id] = {
      id,
      key,
      kind: NodeKind.Const,
      constant: value,
      atomId: -1,
      field: "",
      children: [],
      rootRefs: 0,
      parents: 0,
      ownRoots: 0,
    };
    this.byKey.set(key, id);
    return id;
  }

  /** Intern an atom node and register it in the field indices on creation. */
  atomNode(expr: Predicate): number {
    const key = atomKey(expr);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.allocate();
    const field = pathKey(expr.path);
    const node: GraphNode = {
      id,
      key,
      kind: NodeKind.Atom,
      constant: false,
      predicate: expr,
      atomId: id,
      field,
      children: [],
      rootRefs: 0,
      parents: 0,
      ownRoots: 0,
    };
    this.nodes[id] = node;
    this.byKey.set(key, id);
    const indices = this.fieldIndices(field);
    indices.add(id, toIndexedAtom(expr, field));
    return id;
  }

  /** Intern a NOT node. Child reference count is managed by the caller. */
  notNode(child: number): number {
    const key = notKey(this.nodes[child]!.key);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.allocate();
    this.nodes[id] = {
      id,
      key,
      kind: NodeKind.Not,
      constant: false,
      atomId: -1,
      field: "",
      children: [child],
      rootRefs: 0,
      parents: 0,
      ownRoots: 0,
    };
    this.byKey.set(key, id);
    return id;
  }

  junctionNode(op: "and" | "or", children: readonly number[]): number {
    const key = junctionKey(
      op,
      children.map((child) => this.nodes[child]!.key),
    );
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const id = this.allocate();
    this.nodes[id] = {
      id,
      key,
      kind: op === "and" ? NodeKind.And : NodeKind.Or,
      constant: false,
      atomId: -1,
      field: "",
      children: [...children],
      rootRefs: 0,
      parents: 0,
      ownRoots: 0,
    };
    this.byKey.set(key, id);
    return id;
  }

  fieldIndices(field: string): FieldIndices {
    let indices = this.fields.get(field);
    if (indices === undefined) {
      indices = new FieldIndices();
      this.fields.set(field, indices);
    }
    return indices;
  }

  /** Compile an external expression to a graph node, interning shared parts. */
  compile(expr: Expr): number {
    switch (expr.op) {
      case "const":
        return this.constNode(expr.value);
      case "exists":
      case "eq":
      case "range":
      case "prefix":
        return this.atomNode(expr);
      case "not": {
        const child = this.compile(expr.child);
        const id = this.notNode(child);
        return id;
      }
      case "and":
      case "or": {
        const children = expr.children.map((child) => this.compile(child));
        return this.junctionNode(expr.op, children);
      }
      default: {
        const unreachable: never = expr;
        throw new TypeError(`unknown expression ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /**
   * Attach a parent edge and propagate reference counts. `delta` is +1 when a
   * new subscription root or parent is added, -1 when removed; each node also
   * tracks root counts so eviction knows whether a shared node still has users.
   */
  link(refs: RefDelta, parent: number, child: number): void {
    const node = this.nodes[child]!;
    node.parents += refs === RefDelta.Add ? 1 : -1;
    if (node.parents < 0) throw new Error(`parent reference underflow on node ${child}`);
  }

  /** Release a node if nothing refers to it; cascades into children. */
  releaseIfUnused(id: number, released: number[]): void {
    const node = this.nodes[id]!;
    if (node.rootRefs !== 0 || node.parents !== 0) return;
    // Remove any parent references from this node to its children.
    for (const child of node.children) {
      const childNode = this.nodes[child]!;
      childNode.parents -= 1;
      if (childNode.parents < 0) throw new Error(`parent reference underflow on node ${child}`);
    }
    this.unindexNode(node);
    this.byKey.delete(node.key);
    released.push(id);
    for (const child of node.children) this.releaseIfUnused(child, released);
  }

  /** Remove all index registrations and interned-key bookkeeping for a node. */
  private unindexNode(node: GraphNode): void {
    if (node.kind !== NodeKind.Atom) return;
    const indices = this.fields.get(node.field);
    if (indices === undefined) return;
    indices.remove(node.atomId);
    if (indices.atomCount === 0) this.fields.delete(node.field);
  }

  /** Internal use by the router's snapshot validation. */
  keyOf(id: number): string {
    return this.nodes[id]!.key;
  }

  /** Atom ids currently registered for a field, for introspection/tests. */
  indexedAtomIds(field: string): number[] {
    const indices = this.fields.get(field);
    if (indices === undefined) return [];
    return indices.atomIds();
  }

  private allocate(): number {
    return this.nodes.length;
  }
}

export const enum RefDelta {
  Add = 1,
  Remove = -1,
}

const toIndexedAtom = (expr: Predicate, field: string): IndexedAtomShape => {
  switch (expr.op) {
    case "exists":
      return { op: "exists", pathKey: field };
    case "eq":
      return { op: "eq", value: expr.value };
    case "range":
      return { op: "range", min: expr.min, max: expr.max };
    case "prefix":
      return { op: "prefix", prefix: expr.prefix };
  }
};

type IndexedAtomShape =
  | { op: "exists"; pathKey: string }
  | { op: "eq"; value: JsonPrimitive }
  | { op: "range"; min: number | null; max: number | null }
  | { op: "prefix"; prefix: string };

/** Shared evaluation helpers (also used by the optimizer/evaluator). */
export const isMissing = (value: unknown): value is typeof MISSING => value === MISSING;
export { lookup, resolveScalar, pathFromKey };
