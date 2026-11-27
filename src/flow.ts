/**
 * Exact bigint min-cost max-flow and residual-graph helpers.
 *
 * The planner models each route as an edge whose capacity is measured in
 * requests. Because costs are integral per unit and capacities are integers,
 * one augmenting path carries a whole bulk of requests at once; the number of
 * augmentations depends on the graph, never on how many requests a demand
 * represents. All arithmetic is `bigint`, so nothing is lost past 2^53.
 */

export interface FlowEdge {
  /** Target node index. */
  to: number;
  /** Residual capacity: forward remaining capacity, or reverse flow so far. */
  cap: bigint;
  /** Cost per unit when traversed in the forward direction. */
  cost: bigint;
  /** Index of the paired reverse edge inside `adj[to]`. */
  rev: number;
}

export interface FlowNetwork {
  readonly nodeCount: number;
  readonly adj: FlowEdge[][];
}

export function createNetwork(nodeCount: number): FlowNetwork {
  const adj: FlowEdge[][] = Array.from({ length: nodeCount }, () => []);
  return { nodeCount, adj };
}

/**
 * Adds a directed edge `from -> to` carrying up to `cap` units at `cost` per
 * unit, together with its zero-capacity residual reverse edge.
 */
export function addEdge(
  network: FlowNetwork,
  from: number,
  to: number,
  cap: bigint,
  cost: bigint,
): FlowEdge {
  const forward: FlowEdge = { to, cap, cost, rev: network.adj[to].length };
  const backward: FlowEdge = { to: from, cap: 0n, cost: -cost, rev: network.adj[from].length };
  network.adj[from].push(forward);
  network.adj[to].push(backward);
  return forward;
}

/** Flow currently carried by a forward edge (read from its reverse edge). */
export function flowOn(network: FlowNetwork, forward: FlowEdge): bigint {
  return network.adj[forward.to][forward.rev].cap;
}

interface HeapItem {
  key: bigint;
  node: number;
}

/** Binary min-heap of (bigint key, node). */
class MinHeap {
  private keys: bigint[] = [];
  private nodes: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: bigint, node: number): void {
    this.keys.push(key);
    this.nodes.push(node);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): HeapItem | undefined {
    const n = this.keys.length;
    if (n === 0) return undefined;
    const key = this.keys[0]!;
    const node = this.nodes[0]!;
    if (n === 1) {
      this.keys.pop();
      this.nodes.pop();
      return { key, node };
    }
    this.keys[0] = this.keys.pop()!;
    this.nodes[0] = this.nodes.pop()!;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let best = i;
      if (left < this.keys.length && this.keys[left]! < this.keys[best]!) best = left;
      if (right < this.keys.length && this.keys[right]! < this.keys[best]!) best = right;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
    return { key, node };
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
    const nd = this.nodes[a]!;
    this.nodes[a] = this.nodes[b]!;
    this.nodes[b] = nd;
  }
}

/**
 * Computes feasible node potentials for the current residual graph: every
 * residual arc `u -> v` with positive capacity satisfies
 *
 *     cost(u -> v) + potential[u] - potential[v] >= 0.
 *
 * A residual arc then has reduced cost 0 exactly when it can take part in a
 * zero-cost circulation, which is what the lexicographic tie-break relies on.
 *
 * The computation is a Bellman-Ford / SPFA pass from a virtual source joined
 * to every node by a zero-cost arc (implemented by seeding every potential to
 * 0 and queueing every node). This makes every node reachable, so the result
 * is feasible everywhere, including at nodes unreachable from the real
 * source. It terminates because a minimum-cost flow's residual graph has no
 * negative-cost cycle.
 */
export function computePotentials(network: FlowNetwork): bigint[] {
  const n = network.nodeCount;
  const potential: bigint[] = new Array(n).fill(0n);
  const inQueue: boolean[] = new Array(n).fill(true);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) queue.push(i);

  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    inQueue[u] = false;
    const pu = potential[u]!;
    for (const e of network.adj[u]!) {
      if (e.cap <= 0n) continue;
      const candidate = pu + e.cost;
      if (candidate < potential[e.to]!) {
        potential[e.to] = candidate;
        if (!inQueue[e.to]) {
          inQueue[e.to] = true;
          queue.push(e.to);
        }
      }
    }
  }
  return potential;
}

export interface MinCostFlowResult {
  /** Total flow value pushed from `s` to `t`. */
  flow: bigint;
  /** Total cost of that flow. */
  cost: bigint;
}

/**
 * Minimum-cost maximum flow from `s` to `t` by successive shortest paths with
 * Johnson potentials. Stops when `t` is unreachable (maximum flow) or when
 * `flowLimit` units have been sent.
 *
 * Every augmentation pushes the bottleneck of its path, so the iteration count
 * is governed by the graph's structure, not by the magnitude of capacities:
 * requests are never expanded into per-request nodes.
 */
export function minCostMaxFlow(
  network: FlowNetwork,
  s: number,
  t: number,
  flowLimit?: bigint,
): MinCostFlowResult {
  const n = network.nodeCount;
  const potential = computePotentials(network);
  const dist: (bigint | null)[] = new Array(n).fill(null);
  const prevNode: number[] = new Array(n).fill(-1);
  const prevEdge: number[] = new Array(n).fill(-1);

  let totalFlow = 0n;
  let totalCost = 0n;
  const limit = flowLimit === undefined ? null : flowLimit;

  for (;;) {
    if (limit !== null && totalFlow >= limit) break;

    dist.fill(null);
    prevNode.fill(-1);
    prevEdge.fill(-1);
    dist[s] = 0n;
    const heap = new MinHeap();
    heap.push(0n, s);

    while (heap.size > 0) {
      const item = heap.pop()!;
      const u = item.node;
      const best = dist[u];
      if (best === null || item.key > best) continue;
      const adj = network.adj[u]!;
      const pu = potential[u]!;
      for (let ei = 0; ei < adj.length; ei++) {
        const e = adj[ei]!;
        if (e.cap <= 0n) continue;
        const reduced = e.cost + pu - potential[e.to]!;
        if (reduced < 0n) {
          throw new Error(`internal: negative reduced cost ${reduced}`);
        }
        const candidate = best + reduced;
        const known = dist[e.to];
        if (known === null || candidate < known) {
          dist[e.to] = candidate;
          prevNode[e.to] = u;
          prevEdge[e.to] = ei;
          heap.push(candidate, e.to);
        }
      }
    }

    if (dist[t] === null) break;

    let bottleneck: bigint | null = null;
    for (let v = t; v !== s; v = prevNode[v]!) {
      const u = prevNode[v]!;
      if (u < 0) throw new Error('internal: broken augmenting path');
      const e = network.adj[u]![prevEdge[v]!]!;
      if (bottleneck === null || e.cap < bottleneck) bottleneck = e.cap;
    }
    if (bottleneck === null || bottleneck <= 0n) {
      throw new Error('internal: non-positive augmenting bottleneck');
    }
    if (limit !== null && totalFlow + bottleneck > limit) {
      bottleneck = limit - totalFlow;
    }

    let pathCost = 0n;
    for (let v = t; v !== s; v = prevNode[v]!) {
      const u = prevNode[v]!;
      const e = network.adj[u]![prevEdge[v]!]!;
      pathCost += e.cost;
    }

    for (let v = t; v !== s; v = prevNode[v]!) {
      const u = prevNode[v]!;
      const e = network.adj[u]![prevEdge[v]!]!;
      e.cap -= bottleneck;
      network.adj[v]![e.rev]!.cap += bottleneck;
    }

    totalFlow += bottleneck;
    totalCost += bottleneck * pathCost;

    // Potentials stay feasible for all arcs out of reachable nodes; nodes that
    // are unreachable here can never become reachable through later
    // augmentations, so leaving their potentials untouched is safe.
    for (let i = 0; i < n; i++) {
      const d = dist[i];
      if (d !== null) potential[i]! += d;
    }
  }

  return { flow: totalFlow, cost: totalCost };
}

/** Predicate deciding which residual edges may be traversed. */
export type EdgeFilter = (from: number, edge: FlowEdge) => boolean;

/**
 * Dinic max flow from `s` to `t` over the subset of residual edges accepted by
 * `filter`, sending at most `limit` units. Mutates residual capacities.
 *
 * The blocking-flow search is iterative, so graph depth cannot overflow the
 * call stack. All capacities are bigint, so a single augmentation may carry
 * an arbitrarily large bulk of requests.
 */
export function filteredMaxFlow(
  network: FlowNetwork,
  s: number,
  t: number,
  limit: bigint,
  filter: EdgeFilter,
): bigint {
  if (limit <= 0n || s === t) return 0n;
  const n = network.nodeCount;
  const level: number[] = new Array(n).fill(-1);
  const cursor: number[] = new Array(n).fill(0);

  const bfs = (): boolean => {
    level.fill(-1);
    level[s] = 0;
    const queue: number[] = [s];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi]!;
      const adj = network.adj[u]!;
      for (let i = 0; i < adj.length; i++) {
        const e = adj[i]!;
        if (e.cap <= 0n || !filter(u, e)) continue;
        if (level[e.to] === -1) {
          level[e.to] = level[u]! + 1;
          queue.push(e.to);
        }
      }
    }
    return level[t] !== -1;
  };

  const stackNodes: number[] = [];
  const stackEdges: number[] = [];

  /** Pushes a blocking flow worth at most `budget`; returns the amount sent. */
  const blockingFlow = (budget: bigint): bigint => {
    let total = 0n;
    stackNodes.length = 0;
    stackEdges.length = 0;
    stackNodes.push(s);

    while (stackNodes.length > 0 && total < budget) {
      const u = stackNodes[stackNodes.length - 1]!;

      if (u === t) {
        // Recompute the bottleneck from live residual capacities. Caching it
        // across retreats would go stale once a shared prefix edge is partly
        // consumed, allowing a later augmentation to overdraw it.
        let amount = budget - total;
        for (let k = 0; k < stackEdges.length; k++) {
          const from = stackNodes[k]!;
          const e = network.adj[from]![stackEdges[k]!]!;
          if (e.cap < amount) amount = e.cap;
        }
        if (amount <= 0n) throw new Error('internal: non-positive blocking-flow amount');
        total += amount;

        let firstSaturated = -1;
        for (let k = 0; k < stackEdges.length; k++) {
          const from = stackNodes[k]!;
          const e = network.adj[from]![stackEdges[k]!]!;
          e.cap -= amount;
          network.adj[e.to]![e.rev]!.cap += amount;
          if (e.cap === 0n && firstSaturated === -1) firstSaturated = k;
        }
        if (firstSaturated === -1) {
          // The whole remaining budget was pushed through still-open edges.
          break;
        }
        // Retreat to the tail of the first saturated edge, skip that edge.
        stackNodes.length = firstSaturated + 1;
        stackEdges.length = firstSaturated;
        cursor[stackNodes[stackNodes.length - 1]!]!++;
        continue;
      }

      const adj = network.adj[u]!;
      let advanced = false;
      while (cursor[u]! < adj.length) {
        const ei = cursor[u]!;
        const e = adj[ei]!;
        if (e.cap > 0n && level[e.to] === level[u]! + 1 && filter(u, e)) {
          stackNodes.push(e.to);
          stackEdges.push(ei);
          advanced = true;
          break;
        }
        cursor[u]!++;
      }
      if (!advanced) {
        level[u] = -1; // prune dead end from this level graph
        stackNodes.pop();
        if (stackEdges.length > 0) {
          const parent = stackNodes[stackNodes.length - 1]!;
          stackEdges.pop();
          cursor[parent]!++;
        }
      }
    }
    // Any edges left on the stack belong to a path that ended on a node whose
    // outgoing edges were all exhausted; nothing more can be sent here.
    return total;
  };

  let total = 0n;
  while (total < limit && bfs()) {
    cursor.fill(0);
    const pushed = blockingFlow(limit - total);
    total += pushed;
    if (pushed === 0n) break;
  }
  return total;
}

/** Nodes reachable from `s` through residual edges with positive capacity. */
export function residualReachable(network: FlowNetwork, s: number): boolean[] {
  const seen: boolean[] = new Array(network.nodeCount).fill(false);
  seen[s] = true;
  const queue: number[] = [s];
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi]!;
    for (const e of network.adj[u]!) {
      if (e.cap > 0n && !seen[e.to]) {
        seen[e.to] = true;
        queue.push(e.to);
      }
    }
  }
  return seen;
}
