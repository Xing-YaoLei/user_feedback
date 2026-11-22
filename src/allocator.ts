/**
 * 最优副本目标分配器。
 *
 * 约束：
 * 1. 每个分区最终恰好拥有 replicas 个副本；
 * 2. 同一分区的副本分布在不同 Broker 上，且分布在不同故障域上；
 * 3. 每个 Broker 上的目标副本总数不超过其槽位容量。
 *
 * 优化目标：最终目标中“新落点”的复制成本之和最小。
 * 新落点 = 目标里有、但当前基线（实际副本 + 进行中副本）里没有的
 * (分区, Broker) 组合；沿用基线落点的成本视为 0（复制已经在进行或
 * 已经完成，沉没成本不再重复计入）。
 *
 * 平局规则：所有最优方案中，取按分区 ID 升序、各分区内 Broker ID
 * 字典序排列后字典序最小的方案，保证等价输入得到确定结果。
 *
 * 不可行时返回可核对的阻塞依据（故障域不足 / 容量 Hall 见证）。
 */

import { Dinic } from './flow.ts';
import { buildClusterState, parseSlotKey, slotKey } from './state.ts';
import type {
  AllocationResult,
  Assignment,
  BrokerId,
  InfeasibleReason,
  PartitionId,
  PlannerInput,
} from './types.ts';

function assertFiniteNonNegative(n: number, what: string): void {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${what} 必须是非负有限数字，实际为 ${String(n)}`);
  }
}

export function validateInput(input: PlannerInput): void {
  if (!Array.isArray(input.brokers) || input.brokers.length === 0) {
    throw new Error('至少需要一个 Broker');
  }
  const brokerIds = new Set<BrokerId>();
  const domains = new Set<string>();
  for (const b of input.brokers) {
    if (brokerIds.has(b.id)) throw new Error(`Broker ID 重复: ${b.id}`);
    if (!Number.isInteger(b.capacity) || b.capacity < 0) {
      throw new Error(`Broker ${b.id} 的容量必须是非负整数`);
    }
    brokerIds.add(b.id);
    domains.add(b.domain);
  }
  const pids = new Set<PartitionId>();
  for (const p of input.partitions) {
    if (pids.has(p.id)) throw new Error(`分区 ID 重复: ${p.id}`);
    pids.add(p.id);
    if (!Number.isInteger(p.replicas) || p.replicas < 0) {
      throw new Error(`分区 ${p.id} 的副本数必须是非负整数`);
    }
    for (const b of input.brokers) {
      const c = p.costs[b.id];
      if (c === undefined) {
        throw new Error(`分区 ${p.id} 缺少 Broker ${b.id} 的复制成本`);
      }
      assertFiniteNonNegative(c, `分区 ${p.id} -> Broker ${b.id} 的复制成本`);
    }
  }
  for (const [pid, list] of Object.entries(input.current)) {
    if (!pids.has(pid)) throw new Error(`current 引用了未知分区: ${pid}`);
    if (new Set(list).size !== list.length) {
      throw new Error(`分区 ${pid} 的 current 中存在重复 Broker`);
    }
    for (const b of list) if (!brokerIds.has(b)) throw new Error(`current 引用了未知 Broker: ${b}`);
  }
}

/** 仅做故障域/数量级的前置可行性检查，返回第一个阻塞依据。 */
function precheck(input: PlannerInput): InfeasibleReason | null {
  const liveBrokers = input.brokers;
  const allDomains = [...new Set(liveBrokers.map((b) => b.domain))].sort();
  for (const p of [...input.partitions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (p.replicas === 0) continue;
    if (p.replicas > liveBrokers.length) {
      return {
        kind: 'rf-exceeds-live-brokers',
        partition: p.id,
        message: `分区 ${p.id} 需要 ${p.replicas} 个副本，但存活 Broker 只有 ${liveBrokers.length} 个`,
      };
    }
    if (p.replicas > allDomains.length) {
      return {
        kind: 'not-enough-failure-domains',
        partition: p.id,
        message:
          `分区 ${p.id} 需要 ${p.replicas} 个不同故障域，集群只有 ${allDomains.length} 个：${allDomains.join(', ')}`,
        domains: { required: p.replicas, available: allDomains.length, availableDomains: allDomains },
      };
    }
  }
  return null;
}

interface DfsContext {
  brokerOrder: BrokerId[];
  brokerDomain: Map<BrokerId, string>;
  capacity: Map<BrokerId, number>;
  costOf: (partition: PartitionId, broker: BrokerId) => number;
  /** 基线落点（实际 + 进行中）：沿用零成本，且已预留槽位。 */
  baselineFree: Set<string>;
  rf: Map<PartitionId, number>;
  partitionOrder: PartitionId[];
  bestCost: number;
  bestKey: string | null;
  bestAssignment: Assignment | null;
}

/** 方案的规范字典序键：分区 ID 升序，各分区内 Broker ID 升序后拼接。 */
function canonicalKey(partitionOrder: PartitionId[], assignment: Assignment): string {
  const parts: string[] = [];
  for (const pid of partitionOrder) parts.push(`${pid}=${(assignment[pid] ?? []).join('|')}`);
  return parts.join(';');
}

/**
 * 深度优先穷举：分区按 ID 升序固定，候选 Broker 按 ID 字典序固定，
 * 完整方案按规范字典序生成。所有方案枚举完毕后，在成本最小的方案中
 * 取规范字典序最小者，保证等价输入得到确定结果。
 *
 * 容量口径：进行中副本的槽位已被物理占用，初始 usage 即预留；
 * 目标沿用基线（实际/inflight）落点不产生新占用，其余落点 +1。
 */
function dfs(
  ctx: DfsContext,
  depth: number,
  usage: Map<BrokerId, number>,
  chosen: BrokerId[],
  accumulated: number,
): void {
  if (accumulated > ctx.bestCost) return;
  if (depth === ctx.partitionOrder.length) {
    const assignment: Assignment = {};
    let cursor = 0;
    for (const pid of ctx.partitionOrder) {
      const rf = ctx.rf.get(pid)!;
      assignment[pid] = chosen.slice(cursor, cursor + rf).sort((a, b) => a.localeCompare(b));
      cursor += rf;
    }
    const key = canonicalKey(ctx.partitionOrder, assignment);
    if (
      accumulated < ctx.bestCost
      || (accumulated === ctx.bestCost && (ctx.bestKey === null || key < ctx.bestKey))
    ) {
      ctx.bestCost = accumulated;
      ctx.bestKey = key;
      ctx.bestAssignment = assignment;
    }
    return;
  }
  const pid = ctx.partitionOrder[depth];
  const rf = ctx.rf.get(pid)!;
  if (rf === 0) {
    dfs(ctx, depth + 1, usage, chosen, accumulated);
    return;
  }

  const walk = (picked: number, acc2: number, domains: Set<string>): void => {
    if (picked === rf) {
      dfs(ctx, depth + 1, usage, chosen, acc2);
      return;
    }
    const startBroker = picked === 0 ? null : chosen[chosen.length - 1];
    for (const broker of ctx.brokerOrder) {
      if (startBroker !== null && broker.localeCompare(startBroker) <= 0) continue;
      const domain = ctx.brokerDomain.get(broker)!;
      if (domains.has(domain)) continue;
      const key = slotKey(pid, broker);
      const inBaseline = ctx.baselineFree.has(key);
      if (!inBaseline && (usage.get(broker) ?? 0) >= (ctx.capacity.get(broker) ?? 0)) continue;
      const addCost = inBaseline ? 0 : ctx.costOf(pid, broker);
      if (acc2 + addCost > ctx.bestCost) continue;
      if (!inBaseline) usage.set(broker, (usage.get(broker) ?? 0) + 1);
      chosen.push(broker);
      domains.add(domain);
      walk(picked + 1, acc2 + addCost, domains);
      domains.delete(domain);
      chosen.pop();
      if (!inBaseline) usage.set(broker, (usage.get(broker) ?? 0) - 1);
    }
  };

  walk(0, accumulated, new Set<string>());
}

/**
 * 不可行时的容量阻塞见证：
 * 把故障域收缩为带容量的一侧（域容量 = 域内各 Broker 容量之和，
 * 单副本任务总能在域内按 Broker 容量装箱），构造
 * source -> 分区(rf) -> 故障域(1) -> sink(域容量) 的二部 b-匹配流，
 * 取残量网络中源点可达的分区集合 S，按 Hall 条件必有
 * sum(rf(S)) > 域邻居总容量。
 */
function capacityWitness(input: PlannerInput): InfeasibleReason {
  const partitions = [...input.partitions].sort((a, b) => a.id.localeCompare(b.id));
  const domains = [...new Set(input.brokers.map((b) => b.domain))].sort();
  const domainIdx = new Map(domains.map((d, i) => [d, i]));
  const domainCapacity = new Map<string, number>();
  const domainBrokers = new Map<string, BrokerId[]>();
  for (const b of input.brokers) {
    domainCapacity.set(b.domain, (domainCapacity.get(b.domain) ?? 0) + b.capacity);
    const list = domainBrokers.get(b.domain) ?? [];
    list.push(b.id);
    domainBrokers.set(b.domain, list);
  }

  const P = partitions.length;
  const D = domains.length;
  const source = 0;
  const pBase = 1;
  const dBase = pBase + P;
  const sink = dBase + D;
  const dinic = new Dinic(sink + 1);

  let totalDemand = 0;
  for (let i = 0; i < P; i++) {
    dinic.addEdge(source, pBase + i, partitions[i].replicas);
    totalDemand += partitions[i].replicas;
    for (let j = 0; j < D; j++) {
      dinic.addEdge(pBase + i, dBase + j, 1);
    }
  }
  for (let j = 0; j < D; j++) {
    dinic.addEdge(dBase + j, sink, domainCapacity.get(domains[j]) ?? 0);
  }

  const flow = dinic.maxFlow(source, sink);
  if (flow >= totalDemand) {
    // 域级流可行但 DFS 失败（理论上不应发生），退回全局容量口径。
    const totalCap = input.brokers.reduce((s, b) => s + b.capacity, 0);
    return {
      kind: 'capacity',
      partition: null,
      message: `不存在满足 Broker/故障域互斥约束的分配：总需求 ${totalDemand}，总槽位 ${totalCap}`,
      witness: {
        partitions: partitions.map((p) => p.id),
        requiredSlots: totalDemand,
        availableBrokers: [...input.brokers].map((b) => b.id).sort(),
        availableSlots: totalCap,
      },
    };
  }

  const reachable = dinic.reachableFromSource();
  const witnessPartitions = partitions
    .filter((_, i) => reachable.has(pBase + i))
    .map((p) => p.id);
  const neighborDomains = new Set<string>();
  for (const pid of witnessPartitions) {
    for (const d of domains) neighborDomains.add(d);
  }
  // Hall 集合的邻居 = 这些分区在图中实际相连的域（此处所有分区与所有存活域相连）
  const availableBrokers: BrokerId[] = [];
  let availableSlots = 0;
  for (const d of [...neighborDomains].sort()) {
    availableSlots += domainCapacity.get(d) ?? 0;
    availableBrokers.push(...(domainBrokers.get(d) ?? []));
  }
  availableBrokers.sort((a, b) => a.localeCompare(b));
  const requiredSlots = witnessPartitions.reduce(
    (s, pid) => s + (input.partitions.find((p) => p.id === pid)?.replicas ?? 0),
    0,
  );

  return {
    kind: 'capacity',
    partition: null,
    message:
      `容量阻塞：分区集合 [${witnessPartitions.join(', ')}] 共需 ${requiredSlots} 个槽位，`
      + `但其可达故障域 [${[...neighborDomains].sort().join(', ')}] 的 Broker 总槽位仅 ${availableSlots} 个`,
    witness: { partitions: witnessPartitions, requiredSlots, availableBrokers, availableSlots },
  };
}

/** 计算最优目标分配；不可行时返回带阻塞依据的结果。 */
export function planAllocation(input: PlannerInput): AllocationResult {
  validateInput(input);
  const pre = precheck(input);
  if (pre) return { ok: false, reason: pre };

  const state = buildClusterState(input.brokers, input.current, input.inflight ?? []);
  const brokerOrder = input.brokers.map((b) => b.id).sort((a, b) => a.localeCompare(b));
  const partitionOrder = input.partitions.map((p) => p.id).sort((a, b) => a.localeCompare(b));
  const baselineFree = new Set<string>();
  for (const [pid, brokers] of state.actual) for (const b of brokers) baselineFree.add(slotKey(pid, b));
  const inflightKeys = new Set<string>(state.inflight.keys());
  for (const key of inflightKeys) baselineFree.add(key);

  // 基线（实际 + 进行中）副本已物理占用槽位：作为初始预留 usage，
  // 目标沿用这些落点时不新增占用；只有全新落点才 +1 并受容量约束。
  const initialUsage = new Map<BrokerId, number>();
  for (const [pid, brokers] of state.actual) {
    for (const b of brokers) initialUsage.set(b, (initialUsage.get(b) ?? 0) + 1);
  }
  for (const key of inflightKeys) {
    const broker = parseSlotKey(key).broker;
    initialUsage.set(broker, (initialUsage.get(broker) ?? 0) + 1);
  }

  const ctx: DfsContext = {
    brokerOrder,
    brokerDomain: new Map(input.brokers.map((b) => [b.id, b.domain])),
    capacity: new Map(input.brokers.map((b) => [b.id, b.capacity])),
    costOf: (pid, broker) => {
      const p = input.partitions.find((x) => x.id === pid)!;
      return p.costs[broker];
    },
    baselineFree,
    rf: new Map(input.partitions.map((p) => [p.id, p.replicas])),
    partitionOrder,
    bestCost: Number.POSITIVE_INFINITY,
    bestKey: null,
    bestAssignment: null,
  };
  dfs(ctx, 0, initialUsage, [], 0);

  if (ctx.bestAssignment) {
    return { ok: true, assignment: ctx.bestAssignment, cost: ctx.bestCost };
  }
  return { ok: false, reason: capacityWitness(input) };
}

/**
 * 独立的朴素穷举器：枚举每个分区所有满足“不同 Broker、不同故障域”
 * 的 Broker 组合，再做全局容量校验与成本比较。
 * 仅用于测试中与 planAllocation 的结果交叉核对（小规模输入）。
 */
export function bruteForceAllocation(input: PlannerInput): AllocationResult {
  validateInput(input);
  const pre = precheck(input);
  if (pre) return { ok: false, reason: pre };

  const state = buildClusterState(input.brokers, input.current, input.inflight ?? []);
  const baselineFree = new Set<string>();
  for (const [pid, brokers] of state.actual) for (const b of brokers) baselineFree.add(slotKey(pid, b));
  const inflightKeys = new Set<string>(state.inflight.keys());
  for (const key of inflightKeys) baselineFree.add(key);

  const brokerDomain = new Map(input.brokers.map((b) => [b.id, b.domain]));
  const cap = new Map(input.brokers.map((b) => [b.id, b.capacity]));
  const partitions = [...input.partitions].sort((a, b) => a.id.localeCompare(b.id));
  const allBrokers = input.brokers.map((b) => b.id).sort((a, b) => a.localeCompare(b));
  const initialUsage = new Map<BrokerId, number>();
  for (const [, brokers] of state.actual) {
    for (const b of brokers) initialUsage.set(b, (initialUsage.get(b) ?? 0) + 1);
  }
  for (const key of inflightKeys) {
    const broker = parseSlotKey(key).broker;
    initialUsage.set(broker, (initialUsage.get(broker) ?? 0) + 1);
  }

  function combinations(picked: BrokerId[], start: number, rf: number): BrokerId[][] {
    if (picked.length === rf) return [picked.slice()];
    const out: BrokerId[][] = [];
    for (let i = start; i < allBrokers.length; i++) {
      const b = allBrokers[i];
      const domain = brokerDomain.get(b)!;
      if (picked.some((x) => brokerDomain.get(x) === domain)) continue;
      picked.push(b);
      out.push(...combinations(picked, i + 1, rf));
      picked.pop();
    }
    return out;
  }

  let bestCost = Number.POSITIVE_INFINITY;
  let bestKey: string | null = null;
  let best: Assignment | null = null;

  function evaluate(idx: number, assignment: Assignment, usage: Map<BrokerId, number>, cost: number): void {
    if (cost > bestCost) return;
    if (idx === partitions.length) {
      const key = canonicalKey(
        partitions.map((p) => p.id),
        assignment,
      );
      if (cost < bestCost || (cost === bestCost && (bestKey === null || key < bestKey))) {
        bestCost = cost;
        bestKey = key;
        best = { ...assignment };
      }
      return;
    }
    const p = partitions[idx];
    if (p.replicas === 0) {
      assignment[p.id] = [];
      evaluate(idx + 1, assignment, usage, cost);
      return;
    }
    for (const combo of combinations([], 0, p.replicas)) {
      let fits = true;
      let add = 0;
      const touched: BrokerId[] = [];
      for (const b of combo) {
        const inBaseline = baselineFree.has(slotKey(p.id, b));
        if (!inBaseline) {
          if ((usage.get(b) ?? 0) + 1 > (cap.get(b) ?? 0)) {
            fits = false;
            break;
          }
          usage.set(b, (usage.get(b) ?? 0) + 1);
          touched.push(b);
          add += p.costs[b];
        }
      }
      if (!fits || cost + add > bestCost) {
        for (const b of touched) usage.set(b, (usage.get(b) ?? 0) - 1);
        continue;
      }
      assignment[p.id] = combo.slice();
      evaluate(idx + 1, assignment, usage, cost + add);
      for (const b of touched) usage.set(b, (usage.get(b) ?? 0) - 1);
    }
  }

  evaluate(0, {}, new Map(initialUsage), 0);
  if (best) return { ok: true, assignment: best, cost: bestCost };
  return { ok: false, reason: capacityWitness(input) };
}
