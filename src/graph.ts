/** 有向图工具：具体环提取（SCC + DFS）与确定性拓扑排序（按节点 ID 字典序决胜）。 */

export interface GraphEdge<T> {
  from: string;
  to: string;
  payload: T;
}

export interface Cycle<T> {
  /** 环上的节点序列，首尾相同，如 ['a', 'c', 'b', 'a']。 */
  elements: string[];
  /** 构成环的边（含来源负载），与 elements 顺序对应。 */
  edges: GraphEdge<T>[];
}

function stronglyConnectedComponents(nodes: string[], adj: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      result.push(scc);
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongconnect(v);
  }
  return result;
}

/**
 * 找出图中所有具体环。对每个含环的强连通分量，从字典序最小的节点出发
 * 提取一条具体回路，保证输出确定。
 */
export function findCycles<T>(nodes: Iterable<string>, edges: GraphEdge<T>[]): Cycle<T>[] {
  const adj = new Map<string, GraphEdge<T>[]>();
  const simpleAdj = new Map<string, string[]>();
  const nodeList = [...new Set(nodes)];
  for (const n of nodeList) {
    adj.set(n, []);
    simpleAdj.set(n, []);
  }
  for (const e of edges) {
    if (!adj.has(e.from)) {
      adj.set(e.from, []);
      simpleAdj.set(e.from, []);
    }
    adj.get(e.from)!.push(e);
    simpleAdj.get(e.from)!.push(e.to);
  }

  const sccs = stronglyConnectedComponents([...adj.keys()], simpleAdj);
  const cycles: Cycle<T>[] = [];

  for (const scc of sccs) {
    const set = new Set(scc);
    const hasSelfLoop = scc.length === 1 && edges.some((e) => e.from === scc[0] && e.to === scc[0]);
    if (scc.length === 1 && !hasSelfLoop) continue;

    const start = [...set].sort()[0];
    const inner = edges.filter((e) => set.has(e.from) && set.has(e.to));
    const innerAdj = new Map<string, GraphEdge<T>[]>();
    for (const e of inner) {
      if (!innerAdj.has(e.from)) innerAdj.set(e.from, []);
      innerAdj.get(e.from)!.push(e);
    }

    const stackNodes: string[] = [];
    const stackEdges: GraphEdge<T>[] = [];
    const inStack = new Set<string>();
    const visited = new Set<string>();
    let found: Cycle<T> | null = null;

    function dfs(u: string): boolean {
      visited.add(u);
      inStack.add(u);
      stackNodes.push(u);
      for (const e of innerAdj.get(u) ?? []) {
        if (inStack.has(e.to)) {
          const idx = stackNodes.indexOf(e.to);
          found = {
            elements: [...stackNodes.slice(idx), e.to],
            edges: [...stackEdges.slice(idx), e],
          };
          return true;
        }
        if (!visited.has(e.to)) {
          stackEdges.push(e);
          if (dfs(e.to)) return true;
          stackEdges.pop();
        }
      }
      inStack.delete(u);
      stackNodes.pop();
      return false;
    }

    dfs(start);
    if (found) cycles.push(found);
  }
  return cycles;
}

/**
 * Kahn 拓扑排序；每次在可放置节点中选 ID 字典序最小者，
 * 因此存在多种合法顺序时结果确定（按元素 ID 决胜）。
 */
export function topoSort(nodes: string[], edges: { from: string; to: string }[]): string[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indegree.set(n, 0);
    adj.set(n, []);
  }
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.from} ${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adj.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  const available = nodes.filter((n) => indegree.get(n) === 0).sort();
  const out: string[] = [];
  while (available.length > 0) {
    const n = available.shift()!;
    out.push(n);
    for (const m of adj.get(n)!) {
      indegree.set(m, indegree.get(m)! - 1);
      if (indegree.get(m) === 0) {
        let i = 0;
        while (i < available.length && available[i] < m) i++;
        available.splice(i, 0, m);
      }
    }
  }
  if (out.length !== nodes.length) {
    throw new Error('topoSort: graph contains a cycle');
  }
  return out;
}
