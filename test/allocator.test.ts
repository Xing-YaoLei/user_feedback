/**
 * 分配器测试：
 * 1) 故障域约束改变最小成本方案；
 * 2) 确定性平局（等价输入 -> 同一方案）；
 * 3) 不可行时返回可核对的故障域/容量阻塞依据；
 * 4) 小规模输入与朴素穷举器逐案交叉核对最优成本与方案。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bruteForceAllocation, planAllocation } from '../src/allocator.ts';
import type { PlannerInput } from '../src/types.ts';

function baseInput(): PlannerInput {
  return {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
      { id: 'b3', domain: 'd3', capacity: 2 },
    ],
    partitions: [
      {
        id: 'p1',
        replicas: 2,
        // b1/b2 上已有副本（零新增成本），b3 昂贵
        costs: { b1: 1, b2: 1, b3: 100 },
      },
    ],
    current: { p1: ['b1', 'b2'] },
  };
}

test('无故障域约束时沿用现有落点，零新增成本', () => {
  // b1、b2 在不同域，现有位置本身合法
  const r = planAllocation(baseInput());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.assignment.p1, ['b1', 'b2']);
  assert.equal(r.cost, 0);
});

test('故障域约束改变最小成本方案：同域的便宜落点不可同时选用', () => {
  const input = baseInput();
  // 把 b1、b2 放进同一故障域：p1 需要 2 个不同域，必须选 b3
  input.brokers = [
    { id: 'b1', domain: 'd1', capacity: 2 },
    { id: 'b2', domain: 'd1', capacity: 2 },
    { id: 'b3', domain: 'd2', capacity: 2 },
  ];
  const r = planAllocation(input);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.assignment.p1, ['b1', 'b3']);
  // b3 是新落点，成本 100；b1 沿用基线零成本
  assert.equal(r.cost, 100);
});

test('故障域数量不足时返回可核对的阻塞依据', () => {
  const input = baseInput();
  input.brokers = [
    { id: 'b1', domain: 'd1', capacity: 5 },
    { id: 'b2', domain: 'd1', capacity: 5 },
  ];
  const r = planAllocation(input);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason.kind, 'not-enough-failure-domains');
  assert.equal(r.reason.partition, 'p1');
  assert.deepEqual(r.reason.domains, {
    required: 2,
    available: 1,
    availableDomains: ['d1'],
  });
});

test('容量不足时返回 Hall 阻塞见证，数字可核对', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 1 },
      { id: 'b2', domain: 'd2', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 1, b2: 1 } },
      { id: 'p2', replicas: 2, costs: { b1: 1, b2: 1 } },
    ],
    current: {},
  };
  const r = planAllocation(input);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason.kind, 'capacity');
  assert.ok(r.reason.witness);
  const w = r.reason.witness!;
  assert.equal(w.requiredSlots, 4);
  assert.equal(w.availableSlots, 2);
  assert.ok(w.requiredSlots > w.availableSlots);
  assert.deepEqual(w.availableBrokers, ['b1', 'b2']);
});

test('确定性平局：成本等价时按分区/Broker ID 给出固定方案', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 3 },
      { id: 'b2', domain: 'd2', capacity: 3 },
      { id: 'b3', domain: 'd3', capacity: 3 },
    ],
    partitions: [
      { id: 'p1', replicas: 1, costs: { b1: 5, b2: 5, b3: 5 } },
      { id: 'p2', replicas: 1, costs: { b1: 5, b2: 5, b3: 5 } },
    ],
    current: {},
  };
  const r1 = planAllocation(input);
  const r2 = planAllocation({
    ...input,
    partitions: [input.partitions[1], input.partitions[0]],
  });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  // 无论输入分区顺序如何，规范结果一致且取字典序最小 Broker
  assert.deepEqual(r1.assignment, { p1: ['b1'], p2: ['b1'] });
  assert.deepEqual(r2.assignment, { p1: ['b1'], p2: ['b1'] });
  assert.equal(r1.cost, r2.cost);
});

test('进行中副本的落点沿用时不重复计成本，且同样参与容量约束', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 1 },
      { id: 'b2', domain: 'd2', capacity: 1 },
      { id: 'b3', domain: 'd3', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 7, b2: 9, b3: 11 } },
      { id: 'p2', replicas: 1, costs: { b1: 1, b2: 1, b3: 1 } },
    ],
    current: { p1: ['b1'] },
    // p1 -> b2 的复制进行中：占用 b2 槽位，且目标沿用时零新增成本
    inflight: [{ partition: 'p1', broker: 'b2', requestId: 'req-1' }],
  };
  const r = planAllocation(input);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.assignment.p1, ['b1', 'b2']);
  // b1 沿用实际副本、b2 沿用进行中副本：p1 自身无新落点成本；
  // 唯一成本来自 p2 落到空闲的 b3（成本 1）
  assert.equal(r.cost, 1);
  // b1、b2 槽位已被 p1（实际 + inflight）占满，p2 只能去 b3
  assert.deepEqual(r.assignment.p2, ['b3']);

  // 三个 Broker 各容量 1，总共 3 个槽位；基线（实际+inflight）已占满，
  // 而两个分区目标合计需要 4 个副本 -> 容量不可行，Hall 见证应给出缺口。
  const tight: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 1 },
      { id: 'b2', domain: 'd2', capacity: 1 },
      { id: 'b3', domain: 'd3', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 7, b2: 9, b3: 11 } },
      { id: 'p2', replicas: 2, costs: { b1: 1, b2: 1, b3: 1 } },
    ],
    current: { p1: ['b1'] },
    inflight: [
      { partition: 'p1', broker: 'b2', requestId: 'req-1' },
      { partition: 'p1', broker: 'b3', requestId: 'req-2' },
    ],
  };
  const r2 = planAllocation(tight);
  assert.equal(r2.ok, false);
  if (r2.ok) return;
  assert.equal(r2.reason.kind, 'capacity');
  assert.ok(r2.reason.witness);
  assert.ok(r2.reason.witness!.requiredSlots > r2.reason.witness!.availableSlots);
});

// ---------------------------------------------------------------------------
// 与朴素穷举器交叉核对（多组随机小规模输入）
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInput(rand: () => number): PlannerInput {
  const domainCount = 1 + Math.floor(rand() * 3);
  const brokerCount = domainCount + Math.floor(rand() * 3);
  const brokers = [];
  for (let i = 0; i < brokerCount; i++) {
    brokers.push({
      id: `b${i}`,
      domain: `d${Math.floor(rand() * domainCount)}`,
      capacity: 1 + Math.floor(rand() * 3),
    });
  }
  const partitionCount = 1 + Math.floor(rand() * 3);
  const partitions = [];
  const current: PlannerInput['current'] = {};
  for (let i = 0; i < partitionCount; i++) {
    const pid = `p${i}`;
    const replicas = 1 + Math.floor(rand() * Math.min(3, brokerCount));
    const costs: Record<string, number> = {};
    for (const b of brokers) costs[b.id] = Math.floor(rand() * 20);
    partitions.push({ id: pid, replicas, costs });
    // 随机给一些当前副本
    const shuffled = [...brokers].sort(() => rand() - 0.5);
    const have = shuffled.slice(0, Math.floor(rand() * (replicas + 1))).map((b) => b.id);
    if (have.length > 0) current[pid] = have;
  }
  return { brokers, partitions, current };
}

test('50 组随机小规模输入：DFS 最优解与朴素穷举完全一致', () => {
  const rand = mulberry32(20261122);
  let checked = 0;
  for (let i = 0; i < 50; i++) {
    const input = randomInput(rand);
    const fast = planAllocation(input);
    const brute = bruteForceAllocation(input);
    assert.equal(fast.ok, brute.ok, `第 ${i} 组可行性不一致`);
    if (fast.ok && brute.ok) {
      assert.equal(fast.cost, brute.cost, `第 ${i} 组最优成本不一致`);
      assert.deepEqual(fast.assignment, brute.assignment, `第 ${i} 组最优方案不一致`);
      checked++;
    } else if (!fast.ok && !brute.ok) {
      assert.equal(fast.reason.kind, brute.reason.kind, `第 ${i} 组阻塞类型不一致`);
    }
  }
  assert.ok(checked >= 10, '随机用例中应至少有 10 组可行解被核对');
});
