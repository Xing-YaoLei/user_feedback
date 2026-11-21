/**
 * 目标副本分配求解器。
 *
 * 求解目标：
 * 1. 每个分区达到 replicationFactor 个副本；
 * 2. 同一分区的副本分布在不同 Broker、不同故障域；
 * 3. 每个 Broker 的副本占用不超过容量；
 * 4. 在满足以上约束的方案中，最小化「目标方案内新落点」的复制成本
 *    （保留的既有副本不计费）；
 * 5. 成本相同的等价方案按 (分区 ID, Broker ID) 字典序给出确定结果。
 *
 * 实现方式：分区按固定顺序排列，每个分区枚举满足故障域约束的 Broker
 * 组合，配合分支限界剪枝做确定性 DFS。小规模输入下与穷举结果完全一致
 * （见 test/allocator.test.ts 中的 bruteForce 对照）。
 */

import type {
  AllocationResult,
  Assignment,
  BrokerSpec,
  InfeasibleReason,
  PartitionSpec,
  Topology,
} from './types.ts';

interface PlacementOption {
  /** 该分区占用的 Broker（已按 Broker ID 排序）。 */
  brokers: string[];
  /** 新落点部分的复制成本（保留的既有副本不计）。 */
  cost: number;
  /** 占用的故障域集合。 */
  domains: string[];
}

/** 字典序比较两个字符串数组（先按长度再逐元素比较）。 */
function lexicographicCompare(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const cmp = (a[i]! < b[i]! ? -1 : a[i]! > b[i]! ? 1 : 0);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** 枚举单个分区所有满足「不同 Broker、不同故障域」的 Broker 组合。 */
function enumeratePlacementOptions(
  partition: PartitionSpec,
  brokers: BrokerSpec[],
): PlacementOption[] {
  const rf = partition.replicationFactor;
  const current = new Set(partition.currentReplicas);
  const options: PlacementOption[] = [];

  const chosen: string[] = [];
  const usedDomains = new Set<string>();

  const backtrack = (start: number): void => {
    if (chosen.length === rf) {
      const brokersInOption = [...chosen].sort();
      let cost = 0;
      for (const b of brokersInOption) {
        if (!current.has(b)) {
          const c = partition.cost[b];
          // 成本矩阵缺失的落点视为不可用（无穷成本）。
          if (c === undefined || !Number.isFinite(c)) return;
          cost += c;
        }
      }
      options.push({
        brokers: brokersInOption,
        cost,
        domains: [...usedDomains].sort(),
      });
      return;
    }
    for (let i = start; i < brokers.length; i++) {
      const broker = brokers[i]!;
      if (usedDomains.has(broker.faultDomain)) continue;
      chosen.push(broker.id);
      usedDomains.add(broker.faultDomain);
      backtrack(i + 1);
      usedDomains.delete(broker.faultDomain);
      chosen.pop();
    }
  };

  backtrack(0);

  // 成本优先、等价时按 Broker 列表字典序，保证确定性。
  options.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    return lexicographicCompare(a.brokers, b.brokers);
  });
  return options;
}

class AllocationSolver {
  private readonly brokers: BrokerSpec[];
  private readonly partitions: PartitionSpec[];
  private readonly optionsPerPartition: PlacementOption[][];
  private readonly load: Map<string, number>;
  private readonly bestAssignment: Assignment;
  private bestCost: number;
  private readonly currentChoice: (string[] | undefined)[];
  /** 搜索失败时记录第一个走投无路的分区下标。 */
  private failIndex = -1;

  constructor(topology: Topology) {
    this.brokers = [...topology.brokers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.partitions = [...topology.partitions].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    this.optionsPerPartition = this.partitions.map((p) =>
      enumeratePlacementOptions(p, this.brokers),
    );
    this.load = new Map(this.brokers.map((b) => [b.id, 0]));
    this.bestAssignment = {};
    this.bestCost = Number.POSITIVE_INFINITY;
    this.currentChoice = new Array(this.partitions.length);
  }

  private fits(option: PlacementOption): boolean {
    for (const b of option.brokers) {
      const broker = this.brokers.find((x) => x.id === b)!;
      if ((this.load.get(b) ?? 0) + 1 > broker.capacity) return false;
    }
    return true;
  }

  private apply(option: PlacementOption, delta: 1 | -1): void {
    for (const b of option.brokers) {
      this.load.set(b, (this.load.get(b) ?? 0) + delta);
    }
  }

  solve(): AllocationResult {
    // 结构性预检：副本数超过故障域数 / Broker 数。
    const allDomains = new Set(this.brokers.map((b) => b.faultDomain));
    for (const p of this.partitions) {
      if (p.replicationFactor > allDomains.size) {
        return infeasible({
          kind: 'insufficient-fault-domains',
          partitionId: p.id,
          replicationFactor: p.replicationFactor,
          availableFaultDomains: allDomains.size,
          detail:
            `分区 ${p.id} 需要 ${p.replicationFactor} 个不同故障域，` +
            `集群仅有 ${allDomains.size} 个故障域`,
        });
      }
      if (p.replicationFactor > this.brokers.length) {
        return infeasible({
          kind: 'insufficient-brokers',
          partitionId: p.id,
          replicationFactor: p.replicationFactor,
          availableBrokers: this.brokers.length,
          detail:
            `分区 ${p.id} 需要 ${p.replicationFactor} 个不同 Broker，` +
            `集群仅有 ${this.brokers.length} 个 Broker`,
        });
      }
    }

    // 结构性预检：总槽位不足。
    const requiredSlots = this.partitions.reduce((s, p) => s + p.replicationFactor, 0);
    const availableSlots = this.brokers.reduce((s, b) => s + b.capacity, 0);
    if (requiredSlots > availableSlots) {
      return infeasible({
        kind: 'insufficient-total-capacity',
        requiredSlots,
        availableSlots,
        detail: `全部副本需要 ${requiredSlots} 个槽位，集群总容量仅 ${availableSlots}`,
      });
    }

    // 组合预检：任一分区没有满足故障域约束的落点组合。
    for (let i = 0; i < this.partitions.length; i++) {
      if (this.optionsPerPartition[i]!.length === 0) {
        const p = this.partitions[i]!;
        return infeasible({
          kind: 'no-feasible-assignment',
          blockingPartitions: [p.id],
          requiredSlots: p.replicationFactor,
          availableSlots,
          detail:
            `分区 ${p.id} 不存在满足故障域互斥的 ${p.replicationFactor} 副本组合` +
            `（成本缺失的 Broker 不可用）`,
        });
      }
    }

    this.dfs(0, 0);

    if (this.bestCost === Number.POSITIVE_INFINITY) {
      // 提取可复现阻塞的最小分区子集：从失败点开始逐个减少前缀，
      // 保留仍不可行的最小集合。
      const blocking = this.findMinimalBlockingPrefix();
      const required = blocking.reduce(
        (s, id) => s + this.partitions.find((p) => p.id === id)!.replicationFactor,
        0,
      );
      return infeasible({
        kind: 'no-feasible-assignment',
        blockingPartitions: blocking,
        requiredSlots: required,
        availableSlots,
        detail:
          `分区子集 [${blocking.join(', ')}] 在容量与故障域约束下无法共同放置：` +
          `需要 ${required} 个槽位（含每分区故障域互斥），可通过对该子集穷举复核`,
      });
    }

    const newReplicas: Assignment = {};
    for (const p of this.partitions) {
      const target = this.bestAssignment[p.id]!;
      const current = new Set(p.currentReplicas);
      newReplicas[p.id] = target.filter((b) => !current.has(b));
    }
    return {
      feasible: true,
      assignment: this.bestAssignment,
      totalNewReplicaCost: this.bestCost,
      newReplicas,
    };
  }

  private dfs(index: number, accumulatedCost: number): void {
    if (index === this.partitions.length) {
      // 叶子：成本更优，或成本相同但分配字典序更小（等价方案确定性裁决）。
      if (
        accumulatedCost < this.bestCost ||
        (accumulatedCost === this.bestCost && this.currentIsLexicographicallySmaller())
      ) {
        this.bestCost = accumulatedCost;
        for (let i = 0; i < this.partitions.length; i++) {
          this.bestAssignment[this.partitions[i]!.id] = [...this.currentChoice[i]!];
        }
      }
      return;
    }

    const options = this.optionsPerPartition[index]!;
    let progressed = false;
    for (const option of options) {
      // 分支限界：成本不可能更优时剪枝（等成本仍需继续，以裁决字典序）。
      if (accumulatedCost + option.cost > this.bestCost) continue;
      if (!this.fits(option)) continue;
      progressed = true;
      this.apply(option, 1);
      this.currentChoice[index] = option.brokers;
      this.dfs(index + 1, accumulatedCost + option.cost);
      this.currentChoice[index] = undefined;
      this.apply(option, -1);
    }

    if (!progressed && this.failIndex === -1) {
      this.failIndex = index;
    }
  }

  private currentIsLexicographicallySmaller(): boolean {
    if (Object.keys(this.bestAssignment).length === 0) return true;
    for (const p of this.partitions) {
      const candidate = this.currentChoice[this.partitions.indexOf(p)]!;
      const incumbent = this.bestAssignment[p.id]!;
      const cmp = lexicographicCompare(candidate, incumbent);
      if (cmp !== 0) return cmp < 0;
    }
    return false;
  }

  /**
   * 找到仍不可行的最小分区前缀（按固定分区顺序）。
   * 调用方可用该子集独立穷举，核对阻塞结论。
   */
  private findMinimalBlockingPrefix(): string[] {
    const upper = this.failIndex >= 0 ? this.failIndex + 1 : this.partitions.length;
    for (let size = 1; size <= upper; size++) {
      const sub = this.partitions.slice(0, size);
      if (!this.subProblemFeasible(sub)) {
        return sortedUnique(sub.map((p) => p.id));
      }
    }
    return sortedUnique(this.partitions.slice(0, upper).map((p) => p.id));
  }

  private subProblemFeasible(sub: PartitionSpec[]): boolean {
    const load = new Map(this.brokers.map((b) => [b.id, 0]));
    const optionsById = new Map(
      this.partitions.map((p, i) => [p.id, this.optionsPerPartition[i]!]),
    );

    const go = (idx: number): boolean => {
      if (idx === sub.length) return true;
      const partition = sub[idx]!;
      for (const option of optionsById.get(partition.id)!) {
        let ok = true;
        for (const b of option.brokers) {
          const broker = this.brokers.find((x) => x.id === b)!;
          if ((load.get(b) ?? 0) + 1 > broker.capacity) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        for (const b of option.brokers) load.set(b, (load.get(b) ?? 0) + 1);
        if (go(idx + 1)) return true;
        for (const b of option.brokers) load.set(b, (load.get(b) ?? 0) - 1);
      }
      return false;
    };

    return go(0);
  }
}

function infeasible(reason: InfeasibleReason): AllocationResult {
  return { feasible: false, reason };
}

/** 求解最优目标分配；不可行时返回可核对的阻塞依据。 */
export function planAllocation(topology: Topology): AllocationResult {
  if (topology.brokers.some((b) => b.capacity < 0)) {
    throw new Error('Broker 容量不能为负数');
  }
  if (topology.partitions.some((p) => p.replicationFactor <= 0)) {
    throw new Error('副本数必须为正整数');
  }
  const brokerIds = new Set(topology.brokers.map((b) => b.id));
  for (const p of topology.partitions) {
    const dup = sortedUnique(p.currentReplicas);
    if (dup.length !== p.currentReplicas.length) {
      throw new Error(`分区 ${p.id} 的当前副本位置存在重复 Broker`);
    }
    for (const b of p.currentReplicas) {
      if (!brokerIds.has(b)) throw new Error(`分区 ${p.id} 的当前副本位于未知 Broker ${b}`);
    }
  }
  return new AllocationSolver(topology).solve();
}

/**
 * 穷举参照实现：枚举所有可行分配，按相同目标函数与字典序规则选优。
 * 仅用于测试对照，输入规模必须很小。
 */
export function bruteForceAllocation(topology: Topology): AllocationResult {
  const brokers = [...topology.brokers].sort((a, b) => (a.id < b.id ? -1 : 1));
  const partitions = [...topology.partitions].sort((a, b) => (a.id < b.id ? -1 : 1));
  const load = new Map(brokers.map((b) => [b.id, 0]));
  let best: { assignment: Assignment; cost: number } | undefined;

  const go = (idx: number, costSoFar: number, acc: Assignment): void => {
    if (idx === partitions.length) {
      if (!best || costSoFar < best.cost || (costSoFar === best.cost && lexLess(acc, best.assignment, partitions))) {
        const copy: Assignment = {};
        for (const p of partitions) copy[p.id] = [...acc[p.id]!];
        best = { assignment: copy, cost: costSoFar };
      }
      return;
    }
    const p = partitions[idx]!;
    const current = new Set(p.currentReplicas);
    const options = enumeratePlacementOptions(p, brokers);
    for (const option of options) {
      let ok = true;
      for (const b of option.brokers) {
        const broker = brokers.find((x) => x.id === b)!;
        if ((load.get(b) ?? 0) + 1 > broker.capacity) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const b of option.brokers) load.set(b, (load.get(b) ?? 0) + 1);
      acc[p.id] = option.brokers;
      go(idx + 1, costSoFar + option.cost, acc);
      delete acc[p.id];
      for (const b of option.brokers) load.set(b, (load.get(b) ?? 0) - 1);
    }
  };

  go(0, 0, {});
  if (!best) {
    return planAllocation(topology); // 复用不可行依据的结构化输出
  }
  const newReplicas: Assignment = {};
  for (const p of partitions) {
    const current = new Set(p.currentReplicas);
    newReplicas[p.id] = best.assignment[p.id]!.filter((b) => !current.has(b));
  }
  return {
    feasible: true,
    assignment: best.assignment,
    totalNewReplicaCost: best.cost,
    newReplicas,
  };
}

function lexLess(a: Assignment, b: Assignment, partitions: PartitionSpec[]): boolean {
  for (const p of partitions) {
    const cmp = lexicographicCompare(a[p.id]!, b[p.id]!);
    if (cmp !== 0) return cmp < 0;
  }
  return false;
}
