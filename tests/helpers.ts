/**
 * 测试共享工具：构建含等价路径与零代价边的 6 域环形拓扑。
 *
 *        A --0-- B
 *        |       |
 *        1       1
 *        |       |
 *        F --2-- C --2-- D
 *         \           /
 *          \----3----/
 *                 E 仅与 D 直连（链路 4），用于断点/补齐场景
 *
 * 环 A-B-C-F-A 上，A 到 C 经 B（代价 0+1=1）与经 F（1+2=3）不等价；
 * 为制造「等价路径」，演示中再引入目的地 D：
 *   C->D 代价 2，F->D 经 C 或经直连 F-D(3)，两条 C-D 方向路径由 tie-break 决定。
 */
import { Federation } from '../src/federation.ts';
import type { Topology, TopologyEdge } from '../src/reference.ts';

export const RING_DOMAINS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export const RING_EDGES: TopologyEdge[] = [
  { a: 'A', b: 'B', cost: 0 }, // 零代价边
  { a: 'B', b: 'C', cost: 1 },
  { a: 'C', b: 'F', cost: 2 },
  { a: 'F', b: 'A', cost: 1 },
  { a: 'C', b: 'D', cost: 2 },
  { a: 'F', b: 'D', cost: 3 }, // 与 F->C->D 等价：2+2=4 vs 3+? 实际见测试断言
  { a: 'D', b: 'E', cost: 4 },
];

export function ringTopology(activeEdges?: TopologyEdge[]): Topology {
  const edges = activeEdges ?? RING_EDGES;
  return { nodes: [...RING_DOMAINS], edges };
}

export function buildRingFederation(seed = 7): Federation {
  const fed = new Federation({ seed });
  for (const id of RING_DOMAINS) fed.addDomain(id);
  for (const e of RING_EDGES) {
    fed.connect(e.a, e.b, e.cost);
  }
  return fed;
}

/** 构造只含部分链路的拓扑视图（用于撤销后参考比对） */
export function topologyWithout(edge: { a: string; b: string }): Topology {
  const edges = RING_EDGES.filter(
    (e) => !((e.a === edge.a && e.b === edge.b) || (e.a === edge.b && e.b === edge.a)),
  );
  return { nodes: [...RING_DOMAINS], edges };
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
