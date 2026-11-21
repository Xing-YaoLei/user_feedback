/**
 * 随机压力验证（手工运行：node scratch/stress.ts）：
 * 随机生成可行拓扑，静态规划必须收敛，且每一步满足容量与删除不变量。
 */
import { planAllocation, buildMigrationPlan } from '../src/index.ts';
import type { Topology } from '../src/index.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let feasible = 0;
let converged = 0;
for (let seed = 1; seed <= 200; seed++) {
  const rand = rng(seed);
  const domainCount = 2 + Math.floor(rand() * 3);
  const brokers = [];
  for (let d = 0; d < domainCount; d++) {
    const n = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      brokers.push({ id: `b${d}_${i}`, capacity: 1 + Math.floor(rand() * 3), faultDomain: `d${d}` });
    }
  }
  const partitions = [];
  for (let i = 0; i < 1 + Math.floor(rand() * 3); i++) {
    const rf = 1 + Math.floor(rand() * domainCount);
    const cost: Record<string, number> = {};
    for (const b of brokers) cost[b.id] = 1 + Math.floor(rand() * 15);
    const cur: string[] = [];
    if (rand() < 0.6) {
      const b = brokers[Math.floor(rand() * brokers.length)]!;
      cur.push(b.id);
    }
    partitions.push({ id: `p${i}`, replicationFactor: rf, cost, currentReplicas: cur });
  }
  const topo: Topology = { brokers, partitions };

  // 跳过初始布局本身就超容量的输入（规划器只负责迁移，不纠正既成超载）。
  const initialUsage = new Map<string, number>();
  for (const p of partitions) for (const b of p.currentReplicas) {
    initialUsage.set(b, (initialUsage.get(b) ?? 0) + 1);
  }
  let initialOverCapacity = false;
  for (const [b, n] of initialUsage) {
    if (n > brokers.find((x) => x.id === b)!.capacity) initialOverCapacity = true;
  }
  if (initialOverCapacity) continue;

  const alloc = planAllocation(topo);
  if (!alloc.feasible) continue;
  feasible++;
  const initial: Record<string, string[]> = {};
  for (const p of partitions) initial[p.id] = p.currentReplicas;
  let plan;
  try {
    plan = buildMigrationPlan({
      brokers,
      partitionIds: partitions.map((p) => p.id),
      target: alloc.assignment,
      initial,
    });
  } catch (e) {
    console.error('LOOP seed=', seed, 'brokers=', JSON.stringify(brokers),
      'partitions=', JSON.stringify(partitions), 'target=', JSON.stringify(alloc.assignment));
    throw e;
  }
  if (plan.status === 'complete') converged++;

  // 逐帧校验容量（任何时刻可用+inflight+removing 都不得超容量）。
  const byId = new Map(brokers.map((b) => [b.id, b]));
  for (const frame of plan.trajectory) {
    const usage = new Map<string, number>();
    for (const s of frame.snapshots) {
      for (const b of [...s.availableReplicas, ...s.inflightReplicas, ...s.removingReplicas]) {
        usage.set(b, (usage.get(b) ?? 0) + 1);
      }
    }
    for (const [b, n] of usage) {
      if (n > byId.get(b)!.capacity) {
        throw new Error(`seed=${seed} 步骤${frame.step} Broker ${b} 占用 ${n} 超容量`);
      }
    }
  }
  if (plan.status === 'blocked' && !plan.blocked) {
    throw new Error(`seed=${seed} 受阻但缺少报告`);
  }
}
console.log(`feasible=${feasible} converged=${converged} (容量受阻=${feasible - converged})`);
