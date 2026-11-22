/**
 * 迁移规划器测试：
 * 1) 目标可行但迁移成环：通过临时副本腾挪打破，最终收敛；
 * 2) 容量使迁移无法推进：返回受阻关系与需要释放槽位的 Broker；
 * 3) 动作轨迹逐步核对：每步后容量不超限、删除满足副本数/故障域下限、
 *    新副本追平后才删除旧副本；
 * 4) 与分配器联合：规划结果确实收敛到最优目标分配。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planAllocation } from '../src/allocator.ts';
import { MigrationPlanner } from '../src/planner.ts';
import { buildClusterState, parseSlotKey, slotKey, usageOf } from '../src/state.ts';
import type {
  BrokerSpec,
  MigrationAction,
  PartitionSpec,
  PlannerInput,
} from '../src/types.ts';

/** 独立轨迹模拟器：不用规划器内部状态，自己复播动作并逐条校验不变量。 */
class TrajectorySimulator {
  readonly actual = new Map<string, Set<string>>();
  readonly inflight = new Map<string, true>();
  readonly brokers: BrokerSpec[];
  readonly rf = new Map<string, number>();
  readonly deletedBeforeReplacementConfirmed: string[] = [];

  constructor(
    brokers: BrokerSpec[],
    partitions: PartitionSpec[],
    current: Record<string, string[]>,
  ) {
    this.brokers = brokers;
    for (const p of partitions) {
      this.rf.set(p.id, p.replicas);
      this.actual.set(p.id, new Set(current[p.id] ?? []));
    }
  }

  private domain(broker: string): string {
    return this.brokers.find((b) => b.id === broker)!.domain;
  }

  private usage(broker: string): number {
    let n = 0;
    for (const set of this.actual.values()) if (set.has(broker)) n++;
    for (const key of this.inflight.keys()) {
      if (parseSlotKey(key).broker === broker) n++;
    }
    return n;
  }

  private capacity(broker: string): number {
    return this.brokers.find((b) => b.id === broker)!.capacity;
  }

  apply(action: MigrationAction): void {
    if (action.type === 'replicate') {
      const key = slotKey(action.partition, action.target);
      assert.ok(!this.inflight.has(key), '重复发起同一复制');
      assert.ok(!this.actual.get(action.partition)!.has(action.target), '目标已有实际副本');
      // 复制中的副本也占槽位：发起后立刻不能超容量
      assert.ok(
        this.usage(action.target) + 1 <= this.capacity(action.target),
        `复制到 ${action.target} 会超出容量`,
      );
      this.inflight.set(key, true);
      assert.ok(this.usage(action.target) <= this.capacity(action.target));
    } else if (action.type === 'await') {
      const key = slotKey(action.partition, action.broker);
      assert.ok(this.inflight.has(key), 'await 的复制不存在');
      // 追平：inflight -> actual，占用槽位数不变
      this.inflight.delete(key);
      this.actual.get(action.partition)!.add(action.broker);
    } else {
      // delete：安全护栏逐条核对
      const set = this.actual.get(action.partition)!;
      assert.ok(set.has(action.broker), '删除的副本必须真实存在');
      const rf = this.rf.get(action.partition)!;
      const beforeCount = set.size;
      const beforeDomains = new Set([...set].map((b) => this.domain(b)));
      assert.equal(action.beforeReplicaCount, beforeCount);
      assert.equal(action.beforeDomainCount, beforeDomains.size);
      assert.equal(action.retainedFloor, Math.min(beforeCount, rf));
      assert.equal(action.retainedDomainFloor, Math.min(beforeDomains.size, rf));

      // 规则：新副本确认追平后才允许删除它所替代的旧副本。
      // 若删除后该分区仍至少有 rf 个实际副本，说明替代副本已就位；
      // 否则该删除只能发生在分区实际副本数高于 rf 时（收缩场景），
      // 此时同样要求 beforeCount - 1 >= min(beforeCount, rf)。
      const domainOfDeleted = this.domain(action.broker);
      const domainStillCovered = [...set].some(
        (b) => b !== action.broker && this.domain(b) === domainOfDeleted,
      );
      const afterCount = beforeCount - 1;
      const afterDomains = beforeDomains.size - (domainStillCovered ? 0 : 1);
      assert.ok(
        afterCount >= Math.min(beforeCount, rf),
        '删除后可用副本数低于安全下限',
      );
      assert.ok(
        afterDomains >= Math.min(beforeDomains.size, rf),
        '删除后覆盖故障域数低于安全下限',
      );
      set.delete(action.broker);
      this.deletedBeforeReplacementConfirmed.push(action.partition);
    }

    // 每一步之后全集群容量不变量
    for (const b of this.brokers) {
      assert.ok(
        this.usage(b.id) <= this.capacity(b.id),
        `动作 ${action.type} 后 Broker ${b.id} 超容量`,
      );
    }
  }
}

function cycleInput(): PlannerInput {
  // 3 个 Broker，每个容量 1；3 个分区各 1 副本。
  // 当前：p1->b1, p2->b2, p3->b3。外部给定的目标是整体轮换
  // p1->b2, p2->b3, p3->b1（例如扩容重排后的指定分配）。
  // 所有 Broker 满载，直接复制全部被卡住，构成迁移成环，
  // 必须借助临时副本腾挪才能推进。
  return {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 1 },
      { id: 'b2', domain: 'd2', capacity: 1 },
      { id: 'b3', domain: 'd3', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 1, costs: { b1: 100, b2: 1, b3: 100 } },
      { id: 'p2', replicas: 1, costs: { b1: 100, b2: 100, b3: 1 } },
      { id: 'p3', replicas: 1, costs: { b1: 1, b2: 100, b3: 100 } },
    ],
    current: { p1: ['b1'], p2: ['b2'], p3: ['b3'] },
  };
}

/** 成环场景的外部指定轮换目标。 */
function rotatedTarget(): Record<string, string[]> {
  return { p1: ['b2'], p2: ['b3'], p3: ['b1'] };
}

test('迁移成环：静态规划无空闲槽位时返回 blocked，并给出释放位置', () => {
  const input = cycleInput();
  const target = rotatedTarget();

  const result = MigrationPlanner.computePlan(
    input.brokers,
    input.partitions,
    input.current,
    target,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.blocked.reason, 'no-free-slot');
  assert.ok(result.blocked.fullBrokers.length >= 1);
  for (const fb of result.blocked.fullBrokers) {
    assert.equal(fb.mustRelease >= 1, true);
    assert.equal(fb.occupants.length, fb.capacity);
  }
  // pending 中每个受阻复制都能指出目标 Broker 上的占用者
  assert.ok(result.blocked.pending.length >= 1);
  for (const p of result.blocked.pending) {
    assert.ok(p.occupiedBy.length >= 1);
  }
});

test('迁移成环：存在一个临时槽位时，临时副本腾挪打破环并收敛到目标', () => {
  const input = cycleInput();
  // b4 提供唯一一个空闲槽位作为腾挪空间
  input.brokers.push({ id: 'b4', domain: 'd4', capacity: 1 });
  for (const p of input.partitions) p.costs.b4 = 50;
  const target = rotatedTarget();

  const result = MigrationPlanner.computePlan(
    input.brokers,
    input.partitions,
    input.current,
    target,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // 轨迹独立复播，逐步核对容量与删除护栏
  const sim = new TrajectorySimulator(input.brokers, input.partitions, input.current);
  const temporaryReplicates = result.actions.filter(
    (a) => a.type === 'replicate' && a.temporary,
  );
  assert.ok(temporaryReplicates.length >= 1, '必须出现临时副本腾挪动作');
  for (const action of result.actions) sim.apply(action);

  // 最终状态恰好等于目标分配
  const finalState: Record<string, string[]> = {};
  for (const [pid, set] of sim.actual) finalState[pid] = [...set].sort();
  assert.deepEqual(finalState, target);
  assert.equal(sim.inflight.size, 0);

  // 临时副本最后必须被删除（不能残留在最终分配里）
  const tempTargets = new Set(temporaryReplicates.map((a) => `${a.partition}:${a.target}`));
  for (const t of tempTargets) {
    const [pid, broker] = t.split(':');
    assert.ok(!sim.actual.get(pid)!.has(broker), '临时副本必须在收尾时删除');
  }
});

test('动作轨迹：普通迁移全程满足容量与“追平后才删除”约束', () => {
  const input: PlannerInput = {
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
  // 指定 p1 用 b3 替换 b2：必然产生“复制到 b3 -> 追平 -> 删除 b2”轨迹
  const target = { p1: ['b1', 'b3'], p2: ['b1'] };
  const result = MigrationPlanner.computePlan(
    input.brokers,
    input.partitions,
    input.current,
    target,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const sim = new TrajectorySimulator(input.brokers, input.partitions, input.current);
  let deletes = 0;
  for (const action of result.actions) {
    sim.apply(action);
    if (action.type === 'delete') deletes++;
  }
  assert.ok(deletes >= 1, '该场景应包含旧副本删除');
  const finalState: Record<string, string[]> = {};
  for (const [pid, set] of sim.actual) finalState[pid] = [...set].sort();
  assert.deepEqual(finalState, target);
});

test('故障域安全下限：删除不能让分区覆盖故障域数跌破 min(删除前, rf)', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 3 },
      { id: 'b2', domain: 'd2', capacity: 3 },
      { id: 'b3', domain: 'd3', capacity: 3 },
    ],
    // p1 当前 3 副本（3 个域），目标 2 副本：收缩删除必须保住 2 个域
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 1, b2: 1, b3: 100 } },
    ],
    current: { p1: ['b1', 'b2', 'b3'] },
  };
  const allocation = planAllocation(input);
  assert.equal(allocation.ok, true);
  if (!allocation.ok) return;
  const result = MigrationPlanner.computePlan(
    input.brokers,
    input.partitions,
    input.current,
    allocation.assignment,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const sim = new TrajectorySimulator(input.brokers, input.partitions, input.current);
  for (const action of result.actions) sim.apply(action);
  // 昂贵的 b3 被删除，且删除动作的域下限字段等于 min(3, 2) = 2
  const del = result.actions.find((a) => a.type === 'delete');
  assert.ok(del && del.type === 'delete');
  assert.equal(del.broker, 'b3');
  assert.equal(del.retainedDomainFloor, 2);
  assert.deepEqual([...sim.actual.get('p1')!].sort(), ['b1', 'b2']);
});

test('规划器内部状态始终满足：inflight 与 actual 合计不超过 Broker 容量', () => {
  const input: PlannerInput = {
    brokers: [
      { id: 'b1', domain: 'd1', capacity: 2 },
      { id: 'b2', domain: 'd2', capacity: 2 },
      { id: 'b3', domain: 'd3', capacity: 1 },
    ],
    partitions: [
      { id: 'p1', replicas: 2, costs: { b1: 1, b2: 10, b3: 10 } },
      { id: 'p2', replicas: 2, costs: { b1: 10, b2: 1, b3: 10 } },
    ],
    current: { p1: ['b1'], p2: ['b2'] },
  };
  const allocation = planAllocation(input);
  assert.equal(allocation.ok, true);
  if (!allocation.ok) return;

  const planner = new MigrationPlanner(
    input.brokers,
    input.partitions,
    input.current,
    allocation.assignment,
  );
  for (let i = 0; i < 100; i++) {
    const step = planner.nextStep();
    if (step.type === 'done') break;
    if (step.type === 'blocked') throw new Error('不应 blocked');
    if (step.type === 'replicate') {
      const rid = planner.state.inflight.get(slotKey(step.partition, step.target))!;
      planner.confirmReplica(step.partition, step.target, rid);
    }
    const state = planner.state;
    for (const b of input.brokers) {
      assert.ok(usageOf(state, b.id) <= b.capacity);
    }
  }
  assert.ok(planner.isDone());
  // 构建一次集群状态确保工具函数可用
  assert.ok(buildClusterState(input.brokers, input.current));
});
