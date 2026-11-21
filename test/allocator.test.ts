/**
 * 分配器测试：
 * 1. 故障域约束改变最小成本方案；
 * 2. 等价方案按 (分区, Broker) ID 确定性裁决；
 * 3. 各类不可行场景返回可核对的阻塞依据；
 * 4. 随机小规模输入与穷举实现逐一对照最优性与确定性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planAllocation, bruteForceAllocation } from '../src/index.ts';
import {
  assertAssignmentValid,
  broker,
  newReplicaCost,
  partition,
  pick,
  rng,
  topology,
} from './helpers.ts';

describe('planAllocation 最优目标分配', () => {
  it('故障域约束改变最小成本方案：便宜落点同域时必须选更贵的异域 Broker', () => {
    // b1,b2 同域(d1)且最便宜；RF=2 时第二个副本必须跨域到 d2。
    const topo = topology(
      [
        broker('b1', 3, 'd1'),
        broker('b2', 3, 'd1'),
        broker('b3', 3, 'd2'),
      ],
      [
        partition('p1', 2, { b1: 1, b2: 2, b3: 100 }, ['b1']),
      ],
    );

    const result = planAllocation(topo);
    assert.equal(result.feasible, true);
    if (!result.feasible) return;
    assertAssignmentValid(topo, result.assignment);
    assert.deepEqual(result.assignment.p1, ['b1', 'b3']);
    assert.equal(result.totalNewReplicaCost, 100);
    assert.deepEqual(result.newReplicas.p1, ['b3']);

    // 与穷举实现一致。
    const brute = bruteForceAllocation(topo);
    assert.equal(brute.feasible, true);
    if (brute.feasible) {
      assert.deepEqual(brute.assignment, result.assignment);
      assert.equal(brute.totalNewReplicaCost, result.totalNewReplicaCost);
    }
  });

  it('多分区争用容量：便宜 Broker 容量耗尽后，后续分区选择次优落点', () => {
    const topo = topology(
      [broker('b1', 1, 'd1'), broker('b2', 2, 'd2'), broker('b3', 2, 'd3')],
      [
        partition('p1', 1, { b1: 1, b2: 50, b3: 90 }, []),
        partition('p2', 1, { b1: 1, b2: 50, b3: 90 }, []),
      ],
    );
    const result = planAllocation(topo);
    assert.equal(result.feasible, true);
    if (!result.feasible) return;
    assertAssignmentValid(topo, result.assignment);
    assert.deepEqual(result.assignment.p1, ['b1']);
    assert.deepEqual(result.assignment.p2, ['b2']);
    assert.equal(result.totalNewReplicaCost, 51);
  });

  it('等价成本方案按 Broker ID 字典序给出确定结果', () => {
    const topo = topology(
      [broker('b1', 2, 'd1'), broker('b2', 2, 'd2')],
      [partition('p1', 2, { b1: 5, b2: 5 }, [])],
    );
    const r1 = planAllocation(topo);
    const r2 = planAllocation(topo);
    assert.equal(r1.feasible, true);
    assert.equal(r2.feasible, true);
    if (!r1.feasible || !r2.feasible) return;
    assert.deepEqual(r1.assignment, r2.assignment);
    assert.deepEqual(r1.assignment.p1, ['b1', 'b2']);
  });

  it('保留的既有副本不计复制成本，影响落点选择', () => {
    // p1 已在 b3（异域），保留 b3 只需新增一个最便宜的 b1。
    const topo = topology(
      [
        broker('b1', 3, 'd1'),
        broker('b2', 3, 'd2'),
        broker('b3', 3, 'd3'),
      ],
      [partition('p1', 2, { b1: 1, b2: 10, b3: 10 }, ['b3'])],
    );
    const result = planAllocation(topo);
    assert.equal(result.feasible, true);
    if (!result.feasible) return;
    assert.deepEqual(result.assignment.p1, ['b1', 'b3']);
    assert.equal(result.totalNewReplicaCost, 1);
  });

  it('不可行：故障域数量少于副本数，返回可核对依据', () => {
    const topo = topology(
      [broker('b1', 5, 'd1'), broker('b2', 5, 'd1')],
      [partition('p1', 2, { b1: 1, b2: 1 }, [])],
    );
    const result = planAllocation(topo);
    assert.equal(result.feasible, false);
    if (result.feasible) return;
    assert.equal(result.reason.kind, 'insufficient-fault-domains');
    if (result.reason.kind === 'insufficient-fault-domains') {
      assert.equal(result.reason.availableFaultDomains, 1);
      assert.equal(result.reason.replicationFactor, 2);
    }
  });

  it('不可行：总槽位不足，返回需求与可用槽位', () => {
    const topo = topology(
      [broker('b1', 1, 'd1'), broker('b2', 1, 'd2')],
      [
        partition('p1', 1, { b1: 1, b2: 1 }, []),
        partition('p2', 1, { b1: 1, b2: 1 }, []),
        partition('p3', 1, { b1: 1, b2: 1 }, []),
      ],
    );
    const result = planAllocation(topo);
    assert.equal(result.feasible, false);
    if (result.feasible) return;
    assert.equal(result.reason.kind, 'insufficient-total-capacity');
    if (result.reason.kind === 'insufficient-total-capacity') {
      assert.equal(result.reason.requiredSlots, 3);
      assert.equal(result.reason.availableSlots, 2);
    }
  });

  it('不可行：总量够但组合约束冲突，返回最小阻塞分区子集', () => {
    // 总容量 4 = 总需求 4，故障域数也够（4 个），但落点组合冲突：
    // p1 RF=2 只能落在 b1(d1,cap1)+b2(d2,cap1)（b3/b4 成本不可用）；
    // p2 RF=1 只允许落在 b1 或 b2，而 b1、b2 的唯一槽位已被 p1 占满。
    // p3 可落在 b3，与冲突无关；b4 保证总量预检通过，问题只能由搜索暴露。
    const topo = topology(
      [
        broker('b1', 1, 'd1'),
        broker('b2', 1, 'd2'),
        broker('b3', 1, 'd3'),
        broker('b4', 1, 'd4'),
      ],
      [
        partition('p1', 2, { b1: 1, b2: 1, b3: Number.POSITIVE_INFINITY, b4: Number.POSITIVE_INFINITY }, []),
        partition('p2', 1, { b1: 1, b2: 1, b3: Number.POSITIVE_INFINITY, b4: Number.POSITIVE_INFINITY }, []),
        partition('p3', 1, { b1: 1, b2: 1, b3: 1, b4: 1 }, []),
      ],
    );
    const result = planAllocation(topo);
    assert.equal(result.feasible, false);
    if (result.feasible) return;
    assert.equal(result.reason.kind, 'no-feasible-assignment');
    if (result.reason.kind === 'no-feasible-assignment') {
      // 最小阻塞子集为 p1+p2（p3 单独、与 p1 组合均可行）。
      assert.deepEqual(result.reason.blockingPartitions, ['p1', 'p2']);
      // 可核对：对该子集独立穷举同样无解，而去掉任一分区后有解。
      const subset = (ids: string[]) =>
        topology(
          topo.brokers,
          topo.partitions.filter((p) => ids.includes(p.id)),
        );
      assert.equal(bruteForceAllocation(subset(['p1', 'p2'])).feasible, false);
      assert.equal(bruteForceAllocation(subset(['p1'])).feasible, true);
      assert.equal(bruteForceAllocation(subset(['p2'])).feasible, true);
    }
  });

  it('随机小规模输入：求解器与穷举实现的方案和成本完全一致', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const domainCount = 2 + Math.floor(rand() * 2); // 2~3 个故障域
      const brokers = [];
      for (let d = 0; d < domainCount; d++) {
        const perDomain = 1 + Math.floor(rand() * 2);
        for (let i = 0; i < perDomain; i++) {
          brokers.push(broker(`b${d}_${i}`, 1 + Math.floor(rand() * 3), `d${d}`));
        }
      }
      const partitionCount = 1 + Math.floor(rand() * 3);
      const partitions = [];
      for (let i = 0; i < partitionCount; i++) {
        const rf = 1 + Math.floor(rand() * domainCount);
        const cost: Record<string, number> = {};
        for (const b of brokers) cost[b.id] = 1 + Math.floor(rand() * 20);
        const current: string[] = [];
        if (rand() < 0.5) {
          current.push(pick(rand, brokers).id);
        }
        partitions.push(partition(`p${i}`, rf, cost, current));
      }
      const topo = topology(brokers, partitions);

      const fast = planAllocation(topo);
      const brute = bruteForceAllocation(topo);
      assert.equal(fast.feasible, brute.feasible, `seed=${seed} 可行性判断不一致`);
      if (fast.feasible && brute.feasible) {
        assertAssignmentValid(topo, fast.assignment);
        assert.deepEqual(fast.assignment, brute.assignment, `seed=${seed} 方案不一致`);
        assert.equal(
          fast.totalNewReplicaCost,
          brute.totalNewReplicaCost,
          `seed=${seed} 成本不一致`,
        );
        assert.equal(
          fast.totalNewReplicaCost,
          newReplicaCost(topo, fast.assignment),
          `seed=${seed} 成本口径不一致`,
        );
        // 确定性：重复求解结果稳定。
        const again = planAllocation(topo);
        if (again.feasible) assert.deepEqual(again.assignment, fast.assignment);
      } else if (!fast.feasible && !brute.feasible) {
        assert.equal(fast.reason.kind, brute.reason.kind, `seed=${seed} 不可行依据类型不一致`);
      }
    }
  });
});
