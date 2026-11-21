/**
 * Trie index for string prefix predicates on one field path.
 *
 * A prefix atom is stored at the node spelling its prefix: only one entry per
 * distinct prefix string, regardless of how many subscriptions use it. A query
 * walks only the characters of the queried string and collects atoms at the
 * visited nodes, so it never scans unrelated prefixes. Sharing is therefore
 * structural (`"eu"` and `"eu-west"` share the same trie path) and deletion
 * unlinks a node only when its subtree is empty.
 */

interface TrieNode {
  children: Map<string, TrieNode>;
  atomIds: Set<number>;
}

const createNode = (): TrieNode => ({ children: new Map(), atomIds: new Set() });

export class PrefixIndex {
  private readonly root: TrieNode = createNode();
  private atomCount = 0;
  private nodeCount = 1;

  get size(): number {
    return this.atomCount;
  }

  get nodes(): number {
    return this.nodeCount;
  }

  add(atomId: number, prefix: string): void {
    let node = this.root;
    for (const char of prefix) {
      let next = node.children.get(char);
      if (next === undefined) {
        next = createNode();
        node.children.set(char, next);
        this.nodeCount += 1;
      }
      node = next;
    }
    if (!node.atomIds.has(atomId)) {
      node.atomIds.add(atomId);
      this.atomCount += 1;
    }
  }

  remove(atomId: number, prefix: string): void {
    const path: Array<{ node: TrieNode; char: string }> = [];
    let node: TrieNode | undefined = this.root;
    for (const char of prefix) {
      const next = node.children.get(char);
      if (next === undefined) return;
      path.push({ node, char });
      node = next;
    }
    if (!node.atomIds.delete(atomId)) return;
    this.atomCount -= 1;
    for (let i = path.length - 1; i >= 0; i--) {
      const { node: parent, char } = path[i]!;
      const child = parent.children.get(char)!;
      if (child.atomIds.size === 0 && child.children.size === 0) {
        parent.children.delete(char);
        this.nodeCount -= 1;
      } else {
        break;
      }
    }
  }

  /**
   * Collect atoms whose prefix is a prefix of `value`. Returns the number of
   * visited trie nodes (including root) for metrics.
   */
  query(value: string, out: Set<number>): number {
    let visits = 1;
    let node: TrieNode | undefined = this.root;
    for (const atomId of node.atomIds) {
      out.add(atomId);
      visits += 1;
    }
    for (const char of value) {
      node = node.children.get(char);
      if (node === undefined) break;
      visits += 1;
      for (const atomId of node.atomIds) {
        out.add(atomId);
        visits += 1;
      }
    }
    return visits;
  }

  clear(): void {
    this.root.children.clear();
    this.root.atomIds.clear();
    this.atomCount = 0;
    this.nodeCount = 1;
  }

  prefixes(): string[] {
    const out: string[] = [];
    const walk = (node: TrieNode, prefix: string): void => {
      if (node.atomIds.size > 0) out.push(prefix);
      for (const [char, child] of node.children) walk(child, prefix + char);
    };
    walk(this.root, "");
    return out;
  }
}
