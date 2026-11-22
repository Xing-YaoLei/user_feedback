/**
 * Dinic 最大流实现，用于在分配不可行时给出可核对的
 * Hall 阻塞见证（容量瓶颈的分区集合与槽位缺口）。
 *
 * 节点用数字索引表示，边用邻接表存储；每条边带反向边。
 */

interface Edge {
  to: number;
  rev: number;
  cap: number;
}

export class Dinic {
  private readonly graph: Edge[][] = [];
  private readonly level: number[] = [];
  private readonly ptr: number[] = [];

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      this.graph.push([]);
      this.level.push(-1);
      this.ptr.push(0);
    }
  }

  addEdge(from: number, to: number, cap: number): void {
    this.graph[from].push({ to, rev: this.graph[to].length, cap });
    this.graph[to].push({ to: from, rev: this.graph[from].length - 1, cap: 0 });
  }

  private bfs(s: number, t: number): boolean {
    this.level.fill(-1);
    this.level[s] = 0;
    const queue = [s];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      for (const e of this.graph[v]) {
        if (e.cap > 0 && this.level[e.to] < 0) {
          this.level[e.to] = this.level[v] + 1;
          queue.push(e.to);
        }
      }
    }
    return this.level[t] >= 0;
  }

  private dfs(v: number, t: number, pushed: number): number {
    if (pushed === 0) return 0;
    if (v === t) return pushed;
    for (let i = this.ptr[v]; i < this.graph[v].length; i++) {
      this.ptr[v] = i;
      const e = this.graph[v][i];
      if (e.cap <= 0 || this.level[e.to] !== this.level[v] + 1) continue;
      const tr = this.dfs(e.to, t, Math.min(pushed, e.cap));
      if (tr <= 0) continue;
      e.cap -= tr;
      this.graph[e.to][e.rev].cap += tr;
      return tr;
    }
    return 0;
  }

  maxFlow(s: number, t: number): number {
    let flow = 0;
    while (this.bfs(s, t)) {
      this.ptr.fill(0);
      while (true) {
        const pushed = this.dfs(s, t, Number.POSITIVE_INFINITY);
        if (pushed <= 0) break;
        flow += pushed;
      }
    }
    return flow;
  }

  /** 最大流跑完后，从源点沿剩余容量 > 0 的边可达的节点集合。 */
  reachableFromSource(): Set<number> {
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length > 0) {
      const v = stack.pop() as number;
      for (const e of this.graph[v]) {
        if (e.cap > 0 && !seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    return seen;
  }
}
