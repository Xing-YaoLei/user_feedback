/**
 * 全图参考实现：Dijkstra 最短路径树。
 *
 * 决胜规则与路由域选路完全一致：
 *   总代价 -> 跳数 -> 域 ID 序列字典序。
 * 用于演示/测试中把收敛后的实际路由与「可达最优路径」逐一比对。
 */
export interface TopologyEdge {
  a: string;
  b: string;
  cost: number;
}

export interface ReferenceRoute {
  /** 来源域 -> ... -> 目标域 的完整路径 */
  path: string[];
  cost: number;
  hops: number;
}

export interface Topology {
  nodes: string[];
  edges: TopologyEdge[];
}

export function buildAdjacency(topo: Topology): Map<string, { to: string; cost: number }[]> {
  const adj = new Map<string, { to: string; cost: number }[]>();
  for (const n of topo.nodes) adj.set(n, []);
  for (const e of topo.edges) {
    if (!Number.isInteger(e.cost) || e.cost < 0) {
      throw new Error(`链路代价必须是非负整数: ${e.a}-${e.b} = ${String(e.cost)}`);
    }
    adj.get(e.a)!.push({ to: e.b, cost: e.cost });
    adj.get(e.b)!.push({ to: e.a, cost: e.cost });
  }
  return adj;
}

function lexCompare(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/** 与 RoutingDomain 完全相同的三元决胜：代价、跳数、域 ID 序列 */
function routeBetter(
  candCost: number,
  candPath: string[],
  curCost: number,
  curPath: string[],
): boolean {
  if (candCost !== curCost) return candCost < curCost;
  if (candPath.length !== curPath.length) return candPath.length < curPath.length;
  return lexCompare(candPath, curPath) < 0;
}

/**
 * 以 source 为根计算到所有可达节点的确定性最短路径。
 * 返回 destination -> 参考路由（path 为 source -> ... -> destination）。
 * 非负代价（含零代价边）下 Dijkstra 成立；字典序决胜保证唯一结果。
 */
export function referenceShortestPaths(
  topo: Topology,
  source: string,
): Map<string, ReferenceRoute> {
  const adj = buildAdjacency(topo);
  const bestCost = new Map<string, number>();
  const bestPath = new Map<string, string[]>();
  const done = new Set<string>();
  for (const n of topo.nodes) bestCost.set(n, Infinity);
  bestCost.set(source, 0);
  bestPath.set(source, [source]);

  while (done.size < topo.nodes.length) {
    // 在未完成节点中按（代价、跳数、字典序、节点 ID）取最优
    let u: string | null = null;
    for (const n of topo.nodes) {
      if (done.has(n) || bestCost.get(n) === Infinity) continue;
      if (u === null) {
        u = n;
        continue;
      }
      if (
        routeBetter(
          bestCost.get(n)!,
          bestPath.get(n)!,
          bestCost.get(u)!,
          bestPath.get(u)!,
        )
      ) {
        u = n;
      }
    }
    if (u === null) break;
    done.add(u);

    for (const { to: v, cost } of adj.get(u)!) {
      if (done.has(v)) continue;
      const candCost = bestCost.get(u)! + cost;
      const candPath = [...bestPath.get(u)!, v];
      if (
        bestCost.get(v) === Infinity ||
        routeBetter(candCost, candPath, bestCost.get(v)!, bestPath.get(v)!)
      ) {
        bestCost.set(v, candCost);
        bestPath.set(v, candPath);
      }
    }
  }

  const out = new Map<string, ReferenceRoute>();
  for (const n of topo.nodes) {
    if (bestCost.get(n) === Infinity) continue;
    const path = bestPath.get(n)!;
    out.set(n, { path, cost: bestCost.get(n)!, hops: path.length - 1 });
  }
  return out;
}
