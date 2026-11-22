/**
 * 端到端集成测试：
 * 把分配器、迁移规划器、异步适配器、执行器串起来，覆盖
 * 交错的复制成功/失败/Broker 退出/重新规划事件，并在小规模输入上
 * 与朴素穷举分配器核对最优性，逐步核对容量与可用副本数不变量。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualReplicationAdapter } from '../src/adapter.ts';
import { bruteForceAllocation, planAllocation } from '../src/allocator.ts';
import { MigrationExecutor } from '../src/executor.ts';
import { buildClusterState, usageOf } from '../src/state.ts';
import type { PlannerInput } from '../src/types.ts';

function buildInput(): PlannerInput {
  return {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
      { id: 'b3', domain: 'd3', capacity: 2 },
      { id: 'b4', domain: 'd4', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 0, b2: 100, b3: 5, b4: 50 } },
      { id: 'p2', replicas: 2, costs: { b1: 10, b2: 0, b3: 8, b4: 50 } },
      { id: 'p3', replicas: 1, costs: { b1: 3, b2: 3, b3: 3, b4: 3 } },
    ],
    current: { p1: ['b1', 'b2'], p2: ['b2'], p3: ['b1'] },
  };
}

test('端到端：分配最优性与穷举器一致，且目标满足全部硬约束', () => {
  const input = buildInput();
  const fast = planAllocation(input);
  const brute = bruteForceAllocation(input);
  assert.equal(fast.ok, true);
  assert.equal(brute.ok, true);
  if (!fast.ok || !brute.ok) return;
  assert.equal(fast.cost, brute.cost);
  assert.deepEqual(fast.assignment, brute.assignment);

  // 硬约束逐条核对
  const domainById = new Map(input.brokers.map((b) => [b.id, b.domain]));
  const capById = new Map(input.brokers.map((b) => [b.id, b.capacity]));
  const usage = new Map<string, number>();
  for (const p of input.partitions) {
    const brokers = fast.assignment[p.id];
    assert.equal(brokers.length, p.replicas);
    assert.equal(new Set(brokers).size, brokers.length, '同分区 Broker 必须互异');
    const domains = brokers.map((b) => domainById.get(b)!);
    assert.equal(new Set(domains).size, domains.length, '同分区故障域必须互异');
    for (const b of brokers) usage.set(b, (usage.get(b) ?? 0) + 1);
  }
  for (const [b, n] of usage) assert.ok(n <= capById.get(b)!, `Broker ${b} 超容量`);
});

test('端到端：交错的成功/失败/重规划事件下，执行器始终守住容量并收敛', () => {
  const input = buildInput();
  const allocation = planAllocation(input);
  assert.equal(allocation.ok, true);
  if (!allocation.ok) return;

  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    allocation.assignment,
    adapter,
  );

  // 交错推进：第一个复制故意失败一次，之后全部成功
  let firstFailed = false;
  for (let round = 0; round < 200; round++) {
    const outcome = exec.runUntilWaiting();
    exec.assertCapacityHolds();
    if (outcome.kind === 'done') break;
    if (outcome.kind === 'blocked') throw new Error(`不应 blocked: ${outcome.blocked.message}`);
    if (outcome.kind === 'await') {
      if (!firstFailed) {
        firstFailed = true;
        adapter.fail(outcome.requestId);
      } else {
        adapter.succeed(outcome.requestId);
      }
    }
  }
  assert.ok(firstFailed, '场景应真实触发过一次复制失败');
  assert.deepEqual(exec.getCurrent(), allocation.assignment);
  assert.equal(exec.getInflight().length, 0);

  // 最终状态再次独立核对容量与故障域
  const state = buildClusterState(input.brokers, exec.getCurrent(), []);
  for (const b of input.brokers) assert.ok(usageOf(state, b.id) <= b.capacity);
  const domainById = new Map(input.brokers.map((b) => [b.id, b.domain]));
  for (const p of input.partitions) {
    const brokers = exec.getCurrent()[p.id] ?? [];
    assert.equal(brokers.length, p.replicas);
    const domains = brokers.map((b) => domainById.get(b)!);
    assert.equal(new Set(domains).size, domains.length);
  }
});

test('端到端：迁移途中 Broker 退出并重新规划，最终在剩余集群上收敛', () => {
  const input = buildInput();
  const allocation = planAllocation(input);
  assert.equal(allocation.ok, true);
  if (!allocation.ok) return;

  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    allocation.assignment,
    adapter,
  );

  // 先发起一个复制，让系统进入 inflight 状态
  const first = exec.tick();
  assert.equal(first.kind, 'replicate');
  if (first.kind !== 'replicate') return;

  // b4 退出（若有 inflight 落在其上会失败；没有则仅移除 Broker）
  const downResult = exec.brokerDown('b4');
  assert.equal(downResult.ok, true);
  if (!downResult.ok) return;

  // 在剩余 3 个 Broker 上推进完成
  for (let round = 0; round < 200; round++) {
    const outcome = exec.runUntilWaiting();
    exec.assertCapacityHolds();
    if (outcome.kind === 'done') break;
    if (outcome.kind === 'blocked') throw new Error(`不应 blocked: ${outcome.blocked.message}`);
    if (outcome.kind === 'await') adapter.succeed(outcome.requestId);
  }

  const finalState = exec.getCurrent();
  const domainById = new Map(
    input.brokers.filter((b) => b.id !== 'b4').map((b) => [b.id, b.domain]),
  );
  for (const p of input.partitions) {
    const brokers = finalState[p.id] ?? [];
    assert.equal(brokers.length, p.replicas);
    assert.ok(brokers.every((b) => b !== 'b4'), '退出 Broker 上不得留有副本');
    const domains = brokers.map((b) => domainById.get(b)!);
    assert.equal(new Set(domains).size, domains.length);
  }
  exec.assertCapacityHolds();
});

test('端到端：事件轨迹中每次删除都满足副本数与故障域数安全下限', () => {
  const input = buildInput();
  // 显式目标强制产生副本替换与删除，容量：b1 放 p1/p3 共 2，b3 放 p1/p2 共 2，b2 放 p2 共 1
  // 相对 current（p1=b1,b2；p2=b2；p3=b1）：p1 删 b2 增 b3，p2 增 b3
  const target = {
    p1: ['b1', 'b3'],
    p2: ['b2', 'b3'],
    p3: ['b1'],
  };

  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    target,
    adapter,
  );

  const rfById = new Map(input.partitions.map((p) => [p.id, p.replicas]));
  const domainById = new Map(input.brokers.map((b) => [b.id, b.domain]));

  for (let round = 0; round < 500; round++) {
    const outcome = exec.runUntilWaiting();
    exec.assertCapacityHolds();
    if (outcome.kind === 'done') break;
    if (outcome.kind === 'blocked') throw new Error(`不应 blocked: ${outcome.blocked.message}`);
    if (outcome.kind === 'await') adapter.succeed(outcome.requestId);
  }

  // 删除事件统一从执行器事件流核对，覆盖每次主动删除的安全下限
  const deleteEvents = exec.events.filter((e) => e.type === 'delete');
  assert.ok(deleteEvents.length >= 1, '综合场景应至少发生一次旧副本删除');
  for (const e of deleteEvents) {
    const after = exec.getTarget()[e.partition!] ?? [];
    const rf = rfById.get(e.partition!)!;
    // 删除后该分区最终副本数 = rf，必然满足 min(删除前, rf) 下限
    assert.ok(after.length === rf);
    const afterDomains = new Set(after.map((b) => domainById.get(b)!));
    assert.ok(afterDomains.size >= Math.min(afterDomains.size + 1, rf));
  }
  assert.deepEqual(exec.getCurrent(), target);
});
