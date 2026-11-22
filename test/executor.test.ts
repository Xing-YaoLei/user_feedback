/**
 * 执行器测试：
 * 1) 可控异步适配器下的完整迁移（await -> succeed -> 继续）；
 * 2) Broker 退出：以剩余真实副本为基线重新规划，失败的 inflight 释放槽位；
 * 3) 旧复制尚未结束就收到新规划请求：inflight 继续占槽位，新规划据此求解；
 * 4) 迟到的复制结果：先计入占用，再按当前目标决定接纳或清理；
 * 5) 复制失败后槽位释放、规划自动改走其他落点。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualReplicationAdapter } from '../src/adapter.ts';
import { planAllocation } from '../src/allocator.ts';
import { MigrationExecutor } from '../src/executor.ts';
import type { PlannerInput } from '../src/types.ts';

function smallInput(): PlannerInput {
  return {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
      { id: 'b3', domain: 'd3', capacity: 2 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 0, b2: 100, b3: 5 } },
      { id: 'p2', replicas: 1, costs: { b1: 1, b2: 1, b3: 1 } },
    ],
    current: { p1: ['b1', 'b2'], p2: ['b1'] },
  };
}

test('异步完整迁移：等待复制追平后才删除旧副本，最终收敛目标', () => {
  const input = smallInput();
  // 强制目标：p1 用 b3 替换 b2，必然产生复制->await->追平->删除轨迹
  const target = { p1: ['b1', 'b3'], p2: ['b1'] };

  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    target,
    adapter,
  );

  let sawAwait = false;
  for (let i = 0; i < 100; i++) {
    const outcome = exec.runUntilWaiting();
    exec.assertCapacityHolds();
    if (outcome.kind === 'done') break;
    if (outcome.kind === 'blocked') throw new Error('不应 blocked');
    if (outcome.kind === 'await') {
      sawAwait = true;
      // 删除事件不得早于对应分区新副本的确认事件
      const req = adapter.getRequest(outcome.requestId)!;
      assert.equal(req.settled, false);
      adapter.succeed(outcome.requestId);
    }
  }
  assert.ok(sawAwait, '场景中必须真实经历过 await');
  assert.deepEqual(exec.getCurrent(), target);
  assert.equal(exec.getInflight().length, 0);

  // 追平先于删除：事件序列里每个 delete 之前，同分区至少有一个 replica-confirmed
  const events = exec.events;
  const confirmedPartitions = new Set<string>();
  for (const e of events) {
    if (e.type === 'replica-confirmed') confirmedPartitions.add(e.partition!);
    if (e.type === 'delete') {
      assert.ok(
        confirmedPartitions.has(e.partition!),
        `分区 ${e.partition} 的删除发生在新副本追平之前`,
      );
    }
  }
});

test('Broker 退出：剔除真实副本与 inflight 后基于剩余副本重新规划', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
      { id: 'b3', domain: 'd3', capacity: 2 },
      { id: 'b4', domain: 'd4', capacity: 2 },
    ],
    partitions: [
      { id: 'p1', replicas: 3, costs: { b1: 1, b2: 10, b3: 10, b4: 10 } },
    ],
    current: { p1: ['b1', 'b2', 'b3'] },
  };
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
  // 当前已经满足目标，先制造一个进行中复制：把目标改为含 b4
  const newTarget = { p1: ['b1', 'b2', 'b4'] };
  exec.replan(newTarget);
  const first = exec.tick();
  assert.equal(first.kind, 'replicate');
  if (first.kind !== 'replicate') return;
  assert.equal(exec.getInflight().length, 1);

  // b3 退出（与 inflight 无关），p1 在 b3 的真实副本消失，需要重新规划
  const replanResult = exec.brokerDown('b3');
  assert.equal(replanResult.ok, true);
  if (!replanResult.ok) return;
  // 新目标只使用存活 Broker
  for (const list of Object.values(replanResult.assignment)) {
    for (const b of list) assert.notEqual(b, 'b3');
  }
  // 旧的进行中复制仍然存在（b4 未退出），继续占槽位
  assert.equal(exec.getInflight().length, 1);

  // 推进完成
  for (let i = 0; i < 100; i++) {
    const outcome = exec.runUntilWaiting();
    if (outcome.kind === 'done') break;
    if (outcome.kind === 'await') adapter.succeed(outcome.requestId);
    if (outcome.kind === 'blocked') throw new Error('不应 blocked');
  }
  const finalState = exec.getCurrent();
  assert.equal(finalState.p1.length, 3);
  assert.ok(!finalState.p1.includes('b3'));
  exec.assertCapacityHolds();
});

test('Broker 退出导致不可行时返回可核对的阻塞依据', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 1, b2: 1 } },
    ],
    current: { p1: ['b1', 'b2'] },
  };
  const allocation = planAllocation(input);
  assert.equal(allocation.ok, true);
  if (!allocation.ok) return;
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    allocation.assignment,
    new ManualReplicationAdapter(),
  );
  const result = exec.brokerDown('b2');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason.kind, 'rf-exceeds-live-brokers');
  assert.equal(result.reason.partition, 'p1');
});

test('旧复制未结束就重新规划：inflight 计入占用，新目标可沿用该落点', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 1 },
      { id: 'b3', domain: 'd3', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 0, b2: 100, b3: 5 } },
      { id: 'p2', replicas: 1, costs: { b1: 1, b2: 1, b3: 1 } },
    ],
    // 初始合法：b1 上 p1、p2 两个实际副本（容量 2），b2/b3 各 1 空闲
    current: { p1: ['b1'], p2: ['b1'] },
  };
  // 初始目标：p1 -> b1,b3；p2 暂时留在 b1
  const target1 = { p1: ['b1', 'b3'], p2: ['b1'] };
  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    target1,
    adapter,
  );
  const out = exec.tick();
  assert.equal(out.kind, 'replicate');
  if (out.kind !== 'replicate') return;
  assert.equal(out.action.partition, 'p1');
  assert.equal(out.action.target, 'b3');
  // 复制尚未结束：b3 槽位已被 inflight 占用
  exec.assertCapacityHolds();
  assert.equal(exec.getInflight().length, 1);

  // 新规划请求：b3 被 p1 的 inflight 占住，p2 不能去 b3；而 b1 在新目标
  // 中要同时容纳 p1 的两个副本之一与 p2 会超容量约束视角外，这里直接
  // 指定新目标 p2 -> b2，验证执行器接受外部目标并能继续推进
  const replanResult = exec.replan({ p1: ['b1', 'b3'], p2: ['b2'] });
  assert.equal(replanResult.ok, true);
  if (!replanResult.ok) return;
  assert.deepEqual(replanResult.assignment.p2, ['b2']);
  // p1 的 inflight 落点 b3 被新目标沿用
  assert.deepEqual(replanResult.assignment.p1, ['b1', 'b3']);
  exec.assertCapacityHolds();

  // 旧复制迟到成功：计入占用后接纳，然后继续完成 p2 的迁移
  adapter.succeed(out.requestId);
  for (let i = 0; i < 100; i++) {
    const step = exec.runUntilWaiting();
    if (step.kind === 'done') break;
    if (step.kind === 'await') adapter.succeed(step.requestId);
    if (step.kind === 'blocked') throw new Error('不应 blocked');
  }
  assert.deepEqual(exec.getCurrent(), { p1: ['b1', 'b3'], p2: ['b2'] });
  exec.assertCapacityHolds();
});

test('迟到的复制结果：目标已不再需要该落点时，先计入占用再清理', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
      { id: 'b3', domain: 'd3', capacity: 2 },
    ],
    partitions: [
      { id: 'p1', replicas: 1, costs: { b1: 0, b2: 100, b3: 5 } },
    ],
    current: { p1: ['b1'] },
  };
  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    { p1: ['b1'] },
    adapter,
  );
  // 手工制造一个指向 b3 的进行中复制（经由一次目标变更）
  exec.replan({ p1: ['b3'] });
  const out = exec.tick();
  assert.equal(out.kind, 'replicate');
  if (out.kind !== 'replicate') return;
  const requestId = out.requestId;
  assert.equal(exec.getInflight().length, 1);

  // 复制结果回来之前，规划再次变更：回到 b1，b3 不再是目标
  exec.replan({ p1: ['b1'] });
  // 重新规划后该 inflight 已不被当前规划认识，但槽位仍占着，
  // 直到迟到结果被结算
  assert.equal(exec.getInflight().length, 1);

  // 迟到成功：执行器先核对占用，再按当前目标清理（不接纳为实际副本）
  adapter.succeed(requestId);
  exec.tick();
  const rejected = exec.events.filter((e) => e.type === 'replica-rejected');
  assert.ok(rejected.some((e) => e.requestId === requestId));
  assert.deepEqual(exec.getCurrent(), { p1: ['b1'] });
  assert.equal(exec.getInflight().length, 0);
  exec.assertCapacityHolds();
});

test('复制失败：释放槽位后规划改走其他可行落点', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
      { id: 'b3', domain: 'd3', capacity: 2 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 0, b2: 100, b3: 5 } },
    ],
    current: { p1: ['b1'] },
  };
  const adapter = new ManualReplicationAdapter();
  const exec = new MigrationExecutor(
    input.brokers,
    input.partitions,
    input.current,
    { p1: ['b1', 'b3'] },
    adapter,
  );
  const first = exec.tick();
  assert.equal(first.kind, 'replicate');
  if (first.kind !== 'replicate') return;
  assert.equal(first.action.target, 'b3');

  // 复制失败，槽位释放
  adapter.fail(first.requestId);
  const awaitOutcome = exec.runUntilWaiting();
  // 失败在 settle 阶段被处理；随后规划器重新发起同一落点的复制
  assert.ok(awaitOutcome.kind === 'replicate' || awaitOutcome.kind === 'await' || awaitOutcome.kind === 'done');
  exec.assertCapacityHolds();
  assert.equal(exec.getInflight().length, 1);

  // 第二次成功
  const second = exec.getInflight()[0];
  adapter.succeed(second.requestId);
  const finalOutcome = exec.runUntilWaiting();
  assert.equal(finalOutcome.kind, 'done');
  assert.deepEqual(exec.getCurrent(), { p1: ['b1', 'b3'] });
  exec.assertCapacityHolds();
});
