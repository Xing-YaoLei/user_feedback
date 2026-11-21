/**
 * 测试共享工具：构造输入、校验每一步的容量与可用副本不变量。
 */

import assert from 'node:assert/strict';
import type {
  Assignment,
  BrokerSpec,
  PartitionSpec,
  Topology,
} from '../src/types.ts';
import type { MigrationPlanResult, MigrationSnapshot } from '../src/migration.ts';

export function broker(id: string, capacity: number, faultDomain: string): BrokerSpec {
  return { id, capacity, faultDomain };
}

export function partition(
  id: string,
  replicationFactor: number,
  cost: Record<string, number>,
  currentReplicas: string[] = [],
): PartitionSpec {
  return { id, replicationFactor, cost, currentReplicas };
}

export function topology(brokers: BrokerSpec[], partitions: PartitionSpec[]): Topology {
  return { brokers, partitions };
}

/** 校验目标分配满足全部硬约束。 */
export function assertAssignmentValid(
  topo: Topology,
  assignment: Assignment,
): void {
  const brokerById = new Map(topo.brokers.map((b) => [b.id, b]));
  const load = new Map<string, number>();
  for (const p of topo.partitions) {
    const placed = assignment[p.id]!;
    assert.equal(
      placed.length,
      p.replicationFactor,
      `分区 ${p.id} 副本数应为 ${p.replicationFactor}`,
    );
    assert.deepEqual(placed, [...placed].sort(), `分区 ${p.id} 的 Broker 列表应有序`);
    assert.equal(new Set(placed).size, placed.length, `分区 ${p.id} 的 Broker 不得重复`);
    const domains = placed.map((b) => brokerById.get(b)!.faultDomain);
    assert.equal(
      new Set(domains).size,
      domains.length,
      `分区 ${p.id} 的副本必须分布在不同故障域`,
    );
    for (const b of placed) load.set(b, (load.get(b) ?? 0) + 1);
  }
  for (const b of topo.brokers) {
    assert.ok(
      (load.get(b.id) ?? 0) <= b.capacity,
      `Broker ${b.id} 占用 ${load.get(b.id) ?? 0} 超过容量 ${b.capacity}`,
    );
  }
}

/** 计算方案的新落点复制成本（与求解器口径一致）。 */
export function newReplicaCost(topo: Topology, assignment: Assignment): number {
  let total = 0;
  for (const p of topo.partitions) {
    const current = new Set(p.currentReplicas);
    for (const b of assignment[p.id]!) {
      if (!current.has(b)) total += p.cost[b]!;
    }
  }
  return total;
}

/**
 * 逐步核对迁移轨迹：
 * - 任意时刻每个 Broker 的总占用（可用+复制中+待删除）不超过容量；
 * - 每次删除后可用副本数 >= min(删除前, 目标副本数)；
 * - 每次删除后覆盖故障域数 >= min(删除前覆盖数, 目标副本数)。
 */
export function assertTrajectoryInvariants(
  topo: Topology,
  target: Assignment,
  result: MigrationPlanResult,
): void {
  const brokerById = new Map(topo.brokers.map((b) => [b.id, b]));

  for (const frame of result.trajectory) {
    // 容量核对。
    const usage = new Map<string, number>();
    for (const snap of frame.snapshots) {
      for (const b of [
        ...snap.availableReplicas,
        ...snap.inflightReplicas,
        ...snap.removingReplicas,
      ]) {
        usage.set(b, (usage.get(b) ?? 0) + 1);
      }
    }
    for (const [b, n] of usage) {
      assert.ok(
        n <= brokerById.get(b)!.capacity,
        `步骤 ${frame.step} 后 Broker ${b} 占用 ${n} 超过容量`,
      );
    }

    // 删除动作的安全不变量（与前一帧对比）。
    if (frame.action.type === 'delete') {
      const pid = frame.action.partitionId;
      const after = frame.snapshots.find((s) => s.partitionId === pid)!;
      const before = findBeforeSnapshot(result, frame.step, pid);
      const rf = target[pid]!.length;
      assert.ok(
        after.availableReplicas.length >= Math.min(before.availableReplicas.length, rf),
        `步骤 ${frame.step} 删除后可用副本数 ${after.availableReplicas.length} 违反下限`,
      );
      assert.ok(
        after.coveredFaultDomains >= Math.min(before.coveredFaultDomains, rf),
        `步骤 ${frame.step} 删除后故障域数 ${after.coveredFaultDomains} 违反下限`,
      );
    }
  }
}

function findBeforeSnapshot(
  result: MigrationPlanResult,
  step: number,
  pid: string,
): MigrationSnapshot {
  if (step === 0) {
    // 第一步就是删除：用初始状态（available 比 after 多一个）。
    const after = result.trajectory[0]!.snapshots.find((s) => s.partitionId === pid)!;
    return {
      partitionId: pid,
      availableReplicas: [...after.availableReplicas, frame0Deleted(result, pid)].sort(),
      inflightReplicas: [],
      removingReplicas: [],
      coveredFaultDomains: after.coveredFaultDomains + 1,
    };
  }
  return result.trajectory[step - 1]!.snapshots.find((s) => s.partitionId === pid)!;
}

function frame0Deleted(result: MigrationPlanResult, pid: string): string {
  const action = result.trajectory[0]!.action;
  assert.equal(action.partitionId, pid);
  return action.brokerId;
}

/** 确定性伪随机数（mulberry32），保证随机测试可复现。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, values: T[]): T {
  return values[Math.floor(rand() * values.length)]!;
}
