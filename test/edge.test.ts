/**
 * 边界与报告完整性测试：
 * - rf=0 的分区目标为空、零成本；
 * - 输入校验拒绝非法容量/成本；
 * - blocked 报告的字段可机器核对（占用者、mustRelease、pending 对应关系）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planAllocation, validateInput } from '../src/allocator.ts';
import { MigrationPlanner } from '../src/planner.ts';
import type { PlannerInput } from '../src/types.ts';

test('rf=0 的分区分配为空列表且零成本，不占用任何槽位', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 1 },
      { id: 'b2', domain: 'd2', capacity: 1 },
    ],
    partitions: [
      { id: 'p0', replicas: 0, costs: { b1: 5, b2: 5 } },
      { id: 'p1', replicas: 1, costs: { b1: 1, b2: 2 } },
    ],
    current: {},
  };
  const r = planAllocation(input);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.assignment.p0, []);
  assert.equal(r.assignment.p1.length, 1);
  assert.equal(r.cost, 1);
});

test('输入校验：负容量、负成本、重复 Broker ID 均被拒绝', () => {
  assert.throws(
    () => validateInput({
      brokers: [{ id: 'b1', domain: 'd1', capacity: -1 }],
      partitions: [{ id: 'p1', replicas: 1, costs: { b1: 1 } }],
      current: {},
    }),
    /容量/,
  );
  assert.throws(
    () => validateInput({
      brokers: [{ id: 'b1', domain: 'd1', capacity: 1 }],
      partitions: [{ id: 'p1', replicas: 1, costs: { b1: -3 } }],
      current: {},
    }),
    /非负有限数字/,
  );
  assert.throws(
    () => validateInput({
      brokers: [
        { id: 'b1', domain: 'd1', capacity: 1 },
        { id: 'b1', domain: 'd2', capacity: 1 },
      ],
      partitions: [{ id: 'p1', replicas: 1, costs: { b1: 1 } }],
      current: {},
    }),
    /Broker ID 重复/,
  );
});

test('blocked 报告字段完整且内部自洽：pending 与 fullBrokers 可相互核对', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 1 },
      { id: 'b2', domain: 'd2', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 1, costs: { b1: 1, b2: 1 } },
      { id: 'p2', replicas: 1, costs: { b1: 1, b2: 1 } },
    ],
    // 两个 Broker 满载，目标整体对调 -> 无空闲槽位、无 inflight，成环 blocked
    current: { p1: ['b1'], p2: ['b2'] },
  };
  const target = { p1: ['b2'], p2: ['b1'] };
  const result = MigrationPlanner.computePlan(
    input.brokers,
    input.partitions,
    input.current,
    target,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  const { blocked } = result;
  assert.equal(blocked.reason, 'no-free-slot');
  assert.equal(blocked.fullBrokers.length, 2);
  for (const fb of blocked.fullBrokers) {
    assert.equal(fb.mustRelease, 1);
    assert.equal(fb.occupants.length, fb.capacity);
    // 每个满 Broker 都能在 pending 里找到指向它的受阻复制
    const related = blocked.pending.filter((p) => p.targetBroker === fb.broker);
    assert.ok(related.length >= 1);
    for (const p of related) {
      assert.ok(p.occupiedBy.some((o) => o.broker === fb.broker && !o.inflight));
    }
  }
  // 所有待迁移分区都出现在 pending 中
  const pendingPartitions = new Set(blocked.pending.map((p) => p.partition));
  assert.deepEqual([...pendingPartitions].sort(), ['p1', 'p2']);
});
