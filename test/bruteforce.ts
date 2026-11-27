/**
 * Exhaustive reference solver for tiny instances.
 *
 * It enumerates every integral flow vector allowed by the input, then picks the
 * optimum by the required objective order:
 *
 *   1. largest total served,
 *   2. smallest total cost,
 *   3. lexicographically smallest share vector in (source id, cluster id)
 *      order, including zero coordinates for allowed edges.
 *
 * Only used by tests; deliberately slow and simple so it shares no logic with
 * the solver under test.
 */

export interface RefInput {
  sources: { id: string; demand: bigint }[];
  clusters: { id: string; capacity: bigint }[];
  edges: { source: string; cluster: string; cost: bigint }[];
}

export interface RefSolution {
  served: bigint;
  cost: bigint;
  /** Flows aligned with `edges`, as given. */
  flows: bigint[];
  /** Canonical share vector in (source, cluster) order. */
  shareVector: { source: string; cluster: string; requests: bigint }[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function shareOrder(input: RefInput): number[] {
  return input.edges
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => {
      const bySource = compareIds(a.edge.source, b.edge.source);
      return bySource !== 0 ? bySource : compareIds(a.edge.cluster, b.edge.cluster);
    })
    .map((entry) => entry.index);
}

export function toVector(input: RefInput, flows: readonly bigint[]) {
  return shareOrder(input).map((index) => ({
    source: input.edges[index].source,
    cluster: input.edges[index].cluster,
    requests: flows[index],
  }));
}

function lexLess(
  a: { source: string; cluster: string; requests: bigint }[],
  b: { source: string; cluster: string; requests: bigint }[],
): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i].requests < b[i].requests) return true;
    if (a[i].requests > b[i].requests) return false;
  }
  return false;
}

/** Returns the optimum, or null if the input has no feasible flow at all. */
export function bruteForce(input: RefInput): RefSolution | null {
  const demand = new Map(input.sources.map((s) => [s.id, s.demand]));
  const capacity = new Map(input.clusters.map((c) => [c.id, c.capacity]));
  const remainingDemand = input.sources.map((s) => s.demand);
  const remainingCapacity = input.clusters.map((c) => c.capacity);
  const sourceIndexOf = new Map(input.sources.map((s, i) => [s.id, i]));
  const clusterIndexOf = new Map(input.clusters.map((c, i) => [c.id, i]));

  const flows: bigint[] = new Array(input.edges.length).fill(0n);
  let best: RefSolution | null = null;

  const consider = (): void => {
    let served = 0n;
    let cost = 0n;
    for (let i = 0; i < input.edges.length; i++) {
      served += flows[i];
      cost += flows[i] * input.edges[i].cost;
    }
    const vector = toVector(input, flows);
    if (
      best === null ||
      served > best.served ||
      (served === best.served && cost < best.cost) ||
      (served === best.served && cost === best.cost && lexLess(vector, best.shareVector))
    ) {
      best = { served, cost, flows: [...flows], shareVector: vector };
    }
  };

  const recurse = (edgeIndex: number): void => {
    if (edgeIndex === input.edges.length) {
      consider();
      return;
    }
    const edge = input.edges[edgeIndex];
    const si = sourceIndexOf.get(edge.source)!;
    const ci = clusterIndexOf.get(edge.cluster)!;
    const limit = remainingDemand[si] < remainingCapacity[ci]
      ? remainingDemand[si]
      : remainingCapacity[ci];
    for (let amount = 0n; amount <= limit; amount++) {
      flows[edgeIndex] = amount;
      remainingDemand[si] -= amount;
      remainingCapacity[ci] -= amount;
      recurse(edgeIndex + 1);
      remainingDemand[si] += amount;
      remainingCapacity[ci] += amount;
      flows[edgeIndex] = 0n;
    }
  };

  recurse(0);
  void demand;
  void capacity;
  return best;
}
