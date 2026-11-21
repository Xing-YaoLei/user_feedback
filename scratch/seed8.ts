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

const seed = 8;
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
console.log('brokers=', JSON.stringify(brokers));
console.log('partitions=', JSON.stringify(partitions));
const topo: Topology = { brokers, partitions };
const alloc = planAllocation(topo);
console.log('target=', JSON.stringify(alloc.feasible ? alloc.assignment : null));
const initial: Record<string, string[]> = {};
for (const p of partitions) initial[p.id] = p.currentReplicas;
const plan = buildMigrationPlan({
  brokers,
  partitionIds: partitions.map((p) => p.id),
  target: alloc.feasible ? alloc.assignment : {},
  initial,
});
console.log('status=', plan.status);
for (const f of plan.trajectory) {
  console.log(f.step, JSON.stringify(f.action), JSON.stringify(f.snapshots));
}
if (plan.blocked) console.log('BLOCKED', JSON.stringify(plan.blocked, null, 1));
