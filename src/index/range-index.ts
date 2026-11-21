/**
 * Interval index for integer range predicates on one field path.
 *
 * This is a randomized treap ordered by the (inclusive) lower bound and
 * augmented with the maximum upper bound of each subtree. A stabbing query for
 * an integer visits only the nodes whose subtree can contain the value, so its
 * cost is O(log n + k) for k matching ranges instead of O(n).
 *
 * A treap node is shared by every atom with the same interval, which keeps
 * duplicate ranges created by many subscriptions from multiplying storage.
 */

const NEG_INFINITY = -Infinity;
const POS_INFINITY = Infinity;

export interface RangeAtom {
  id: number;
  min: number | null;
  max: number | null;
}

interface TreapNode {
  min: number;
  max: number;
  key: string;
  priority: number;
  atomIds: Set<number>;
  left: TreapNode | null;
  right: TreapNode | null;
  subtreeMax: number;
}

let nextPriority = 1;

/** Deterministic-ish priorities from a monotone sequence avoid Math.random. */
const priority = (): number => {
  nextPriority = (nextPriority * 1103515245 + 12345) & 0x7fffffff;
  return nextPriority;
};

const intervalKey = (min: number, max: number): string => `${min}\u0000${max}`;

const compare = (aMin: number, aMax: number, bMin: number, bMax: number): number => {
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aMax !== bMax) return aMax < bMax ? -1 : 1;
  return 0;
};

const update = (node: TreapNode): void => {
  node.subtreeMax = node.max;
  if (node.left !== null && node.left.subtreeMax > node.subtreeMax) node.subtreeMax = node.left.subtreeMax;
  if (node.right !== null && node.right.subtreeMax > node.subtreeMax) node.subtreeMax = node.right.subtreeMax;
};

const rotateRight = (node: TreapNode): TreapNode => {
  const next = node.left!;
  node.left = next.right;
  next.right = node;
  update(node);
  update(next);
  return next;
};

const rotateLeft = (node: TreapNode): TreapNode => {
  const next = node.right!;
  node.right = next.left;
  next.left = node;
  update(node);
  update(next);
  return next;
};

const insertNode = (root: TreapNode | null, node: TreapNode): TreapNode => {
  if (root === null) return node;
  if (compare(node.min, node.max, root.min, root.max) < 0) {
    root.left = insertNode(root.left, node);
    if (root.left.priority > root.priority) return rotateRight(root);
  } else {
    root.right = insertNode(root.right, node);
    if (root.right.priority > root.priority) return rotateLeft(root);
  }
  update(root);
  return root;
};

const merge = (left: TreapNode | null, right: TreapNode | null): TreapNode | null => {
  if (left === null) return right;
  if (right === null) return left;
  if (left.priority > right.priority) {
    left.right = merge(left.right, right);
    update(left);
    return left;
  }
  right.left = merge(left, right.left);
  update(right);
  return right;
};

const deleteNode = (root: TreapNode | null, min: number, max: number): TreapNode | null => {
  if (root === null) return null;
  const order = compare(min, max, root.min, root.max);
  if (order < 0) {
    root.left = deleteNode(root.left, min, max);
  } else if (order > 0) {
    root.right = deleteNode(root.right, min, max);
  } else {
    return merge(root.left, root.right);
  }
  update(root);
  return root;
};

export class RangeIndex {
  private root: TreapNode | null = null;
  private readonly byInterval = new Map<string, TreapNode>();
  private atomCount = 0;

  get size(): number {
    return this.atomCount;
  }

  get intervalCount(): number {
    return this.byInterval.size;
  }

  add(atom: RangeAtom): void {
    const min = atom.min === null ? NEG_INFINITY : atom.min;
    const max = atom.max === null ? POS_INFINITY : atom.max;
    const key = intervalKey(min, max);
    const existing = this.byInterval.get(key);
    if (existing !== undefined) {
      if (!existing.atomIds.has(atom.id)) {
        existing.atomIds.add(atom.id);
        this.atomCount += 1;
      }
      return;
    }
    const node: TreapNode = {
      min,
      max,
      key,
      priority: priority(),
      atomIds: new Set([atom.id]),
      left: null,
      right: null,
      subtreeMax: max,
    };
    this.byInterval.set(key, node);
    this.root = insertNode(this.root, node);
    this.atomCount += 1;
  }

  remove(atom: RangeAtom): void {
    const min = atom.min === null ? NEG_INFINITY : atom.min;
    const max = atom.max === null ? POS_INFINITY : atom.max;
    const key = intervalKey(min, max);
    const node = this.byInterval.get(key);
    if (node === undefined || !node.atomIds.delete(atom.id)) return;
    this.atomCount -= 1;
    if (node.atomIds.size === 0) {
      this.byInterval.delete(key);
      this.root = deleteNode(this.root, min, max);
    }
  }

  /**
   * Collect atoms whose inclusive interval contains `value`. Returns the
   * number of index entries (tree nodes and atoms) inspected, for metrics.
   */
  query(value: number, out: Set<number>): number {
    let visits = 0;
    const stack: TreapNode[] = this.root === null ? [] : [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      visits += 1;
      if (node.min <= value) {
        if (value <= node.max) {
          for (const atomId of node.atomIds) {
            out.add(atomId);
            visits += 1;
          }
        }
        if (node.right !== null && node.right.subtreeMax >= value) stack.push(node.right);
      }
      if (node.left !== null && node.left.subtreeMax >= value) stack.push(node.left);
    }
    return visits;
  }

  clear(): void {
    this.root = null;
    this.byInterval.clear();
    this.atomCount = 0;
  }

  /** Snapshot of intervals, for introspection and tests. */
  intervals(): Array<{ min: number | null; max: number | null; atoms: number }> {
    const out: Array<{ min: number | null; max: number | null; atoms: number }> = [];
    const walk = (node: TreapNode | null): void => {
      if (node === null) return;
      walk(node.left);
      out.push({
        min: node.min === NEG_INFINITY ? null : node.min,
        max: node.max === POS_INFINITY ? null : node.max,
        atoms: node.atomIds.size,
      });
      walk(node.right);
    };
    walk(this.root);
    return out;
  }
}
