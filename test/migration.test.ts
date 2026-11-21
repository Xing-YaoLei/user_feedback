/**
 * 迁移规划测试：
 * 1. 直接可行的迁移：复制追平后才删除旧副本；
 * 2. 目标可行但迁移成环：临时副本腾挪解开环；
 * 3. 无腾挪空间时返回受阻关系与需要释放槽位的位置；
 * 4. 缩容与故障域不变量；
 * 5. 每条轨迹逐步核对容量与可用副本/故障域数。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationPlan, MigrationPlanner } from '../src/index.ts';
import type { PlannerInput } from '../src/index.ts';
import {
  assertTrajectoryInvariants,
  broker,
  partition,
  topology,
} from './helpers.ts';
import type { Assignment } from '../src/types.ts';

function plannerInput(
  brokers: PlannerInput['brokers'],
  target: Assignment,
  initial: Assignment,
): PlannerInput {
  return {
    brokers,
    partitionIds: Object.keys(target).sort(),
    target,
    initial,
  };
}

function actionTypes(result: { actions: Array<{ type: string; partitionId: string; brokerId: string }> }) {
  return result.actions.map((a) => `${a.type}:${a.partitionId}->${a.brokerId}`);
}

describe('buildMigrationPlan 迁移规划', () => {
  it('直接迁移：新副本追平后才允许删除被替代的旧副本', () => {
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
      broker('b3', 2, 'd3'),
    ];
    const target: Assignment = { p1: ['b1', 'b3'] };
    const initial: Assignment = { p1: ['b1', 'b2'] };
    const result = buildMigrationPlan(plannerInput(brokers, target, initial));

    assert.equal(result.status, 'complete');
    assertTrajectoryInvariants(
      topology(brokers, [partition('p1', 2, {}, ['b1', 'b2'])]),
      target,
      result,
    );

    const types = actionTypes(result).filter((t) => !t.startsWith('release:'));
    // 复制 b3 -> 追平 b3 -> 才能删除 b2（删除确认 release 不改变副本语义）。
    assert.deepEqual(types, [
      'replicate:p1->b3',
      'catchup:p1->b3',
      'delete:p1->b2',
    ]);
    // 每个 delete 后面都有对应的 release 确认。
    for (const a of result.actions.filter((x) => x.type === 'delete')) {
      assert.ok(
        result.actions.some(
          (x) =>
            x.type === 'release' &&
            x.partitionId === a.partitionId &&
            x.brokerId === a.brokerId,
        ),
        `删除 ${a.brokerId} 必须有 release 确认`,
      );
    }
    // 删除动作发生时，新副本 b3 必须已处于可用状态。
    const deleteFrame = result.trajectory.find((f) => f.action.type === 'delete')!;
    const snap = deleteFrame.snapshots.find((s) => s.partitionId === 'p1')!;
    assert.ok(snap.availableReplicas.includes('b3'));
  });

  it('迁移成环：两个分区互换 Broker，临时副本腾挪解环', () => {
    // b1,b2 各容量 1 且全满：p1 在 b1 要去 b2，p2 在 b2 要去 b1。
    // b4 是预留的备用故障域，承载临时副本；b3 为同域冗余 Broker。
    const brokers = [
      broker('b1', 1, 'd1'),
      broker('b2', 1, 'd2'),
      broker('b3', 1, 'd2'),
      broker('b4', 1, 'd4'),
    ];
    const target: Assignment = { p1: ['b2'], p2: ['b1'] };
    const initial: Assignment = { p1: ['b1'], p2: ['b2'] };
    const result = buildMigrationPlan(plannerInput(brokers, target, initial));

    assert.equal(result.status, 'complete');
    assertTrajectoryInvariants(
      topology(
        brokers,
        [
          partition('p1', 1, {}, ['b1']),
          partition('p2', 1, {}, ['b2']),
        ],
      ),
      target,
      result,
    );

    // 必须出现临时副本动作，且落在 p1 当前未覆盖的故障域（d2 或 d4）。
    const tempAction = result.actions.find((a) => a.temporary === true);
    assert.ok(tempAction, '应通过临时副本打破等待环');
    const tempBroker = brokers.find((b) => b.id === tempAction!.brokerId)!;
    assert.notEqual(tempBroker.faultDomain, 'd1', '临时副本必须落在未覆盖故障域');
    const tempBrokerId = tempBroker.id;

    // 临时副本必须先追平，才能删除它所替代的旧副本。
    const tempIndex = result.actions.indexOf(tempAction!);
    const deleteOfOld = result.actions.findIndex(
      (a, i) => a.type === 'delete' && i > tempIndex,
    );
    const catchupOfTemp = result.actions.findIndex(
      (a, i) =>
        a.type === 'catchup' &&
        a.partitionId === tempAction!.partitionId &&
        a.brokerId === tempBrokerId &&
        i > tempIndex,
    );
    assert.ok(catchupOfTemp > tempIndex);
    assert.ok(deleteOfOld > catchupOfTemp);

    // 临时副本在归位后被清理，最终状态收敛到目标。
    assert.ok(
      result.actions.some(
        (a) => a.type === 'delete' && a.partitionId === tempAction!.partitionId && a.brokerId === tempBrokerId,
      ),
      '临时副本归位后应被删除',
    );
    const last = result.trajectory.at(-1)!.snapshots;
    assert.deepEqual(last.find((s) => s.partitionId === 'p1')!.availableReplicas, ['b2']);
    assert.deepEqual(last.find((s) => s.partitionId === 'p2')!.availableReplicas, ['b1']);
  });

  it('成环且无腾挪空间：返回等待关系、环与需要释放槽位的位置', () => {
    // 只有 b1,b2 两个 Broker、各自容量 1，全满且互换目标，没有第三个域。
    const brokers = [broker('b1', 1, 'd1'), broker('b2', 1, 'd2')];
    const target: Assignment = { p1: ['b2'], p2: ['b1'] };
    const initial: Assignment = { p1: ['b1'], p2: ['b2'] };
    const result = buildMigrationPlan(plannerInput(brokers, target, initial));

    assert.equal(result.status, 'blocked');
    assert.ok(result.blocked);
    const report = result.blocked!;
    assert.ok(
      report.kind === 'cycle-no-room' || report.kind === 'no-temp-broker',
      '应报告环上无临时落点',
    );
    assert.deepEqual(report.cyclePartitions.sort(), ['p1', 'p2']);
    // releaseAt 列出两个满载 Broker 及其占用分区，可人工核对。
    const releaseBrokers = report.releaseAt.map((r) => r.brokerId).sort();
    assert.deepEqual(releaseBrokers, ['b1', 'b2']);
    const b1 = report.releaseAt.find((r) => r.brokerId === 'b1')!;
    assert.deepEqual(b1.occupiedBy, ['p1']);
  });

  it('缩容：删除后可用副本数与故障域数始终不低于 min(删除前, 目标值)', () => {
    // RF 从 3 缩到 1，三个故障域各一副本，目标保留 b1。
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
      broker('b3', 2, 'd3'),
    ];
    const target: Assignment = { p1: ['b1'] };
    const initial: Assignment = { p1: ['b1', 'b2', 'b3'] };
    const result = buildMigrationPlan(plannerInput(brokers, target, initial));

    assert.equal(result.status, 'complete');
    assertTrajectoryInvariants(
      topology(brokers, [partition('p1', 1, {}, ['b1', 'b2', 'b3'])]),
      target,
      result,
    );
    assert.deepEqual(
      actionTypes(result).filter((t) => !t.startsWith('release:')),
      ['delete:p1->b2', 'delete:p1->b3'],
    );
    const last = result.trajectory.at(-1)!.snapshots[0]!;
    assert.deepEqual(last.availableReplicas, ['b1']);
  });

  it('故障域保护：删除会丢失唯一异域覆盖时被阻止，先复制补齐再删除', () => {
    // p1 当前 b1(d1)、b2(d2)，目标 b1、b3(d3)。
    // 规划器必须先把 b3 复制追平，才允许删除 b2（否则故障域覆盖会下降）。
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
      broker('b3', 1, 'd3'),
    ];
    const target: Assignment = { p1: ['b1', 'b3'] };
    const initial: Assignment = { p1: ['b1', 'b2'] };
    const result = buildMigrationPlan(plannerInput(brokers, target, initial));
    assert.equal(result.status, 'complete');
    assertTrajectoryInvariants(
      topology(brokers, [partition('p1', 2, {}, ['b1', 'b2'])]),
      target,
      result,
    );
    const catchupIndex = result.actions.findIndex(
      (a) => a.type === 'catchup' && a.brokerId === 'b3',
    );
    const deleteIndex = result.actions.findIndex(
      (a) => a.type === 'delete' && a.brokerId === 'b2',
    );
    assert.ok(catchupIndex >= 0 && deleteIndex > catchupIndex);
  });

  it('复制中的副本占用槽位：容量校验覆盖 inflight 与 removing', () => {
    // b2 容量 2（终态承载 p1、p2 各一副本）：p1 复制到 b2 的 inflight
    // 期间已占一个槽位，任何额外复制都必须尊重剩余容量。
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
      broker('b3', 2, 'd3'),
    ];
    const target: Assignment = { p1: ['b1', 'b2'], p2: ['b2', 'b3'] };
    const initial: Assignment = { p1: ['b1', 'b3'], p2: ['b1', 'b3'] };
    const result = buildMigrationPlan(plannerInput(brokers, target, initial));
    assert.equal(result.status, 'complete');
    assertTrajectoryInvariants(
      topology(
        brokers,
        [
          partition('p1', 2, {}, ['b1', 'b3']),
          partition('p2', 2, {}, ['b1', 'b3']),
        ],
      ),
      target,
      result,
    );

    // 直接用规划器状态核对：inflight 期间 usage 包含该副本，
    // 任何一轮规划下发的复制都不会让 Broker 占用超过容量。
    const planner = new MigrationPlanner(plannerInput(brokers, target, initial));
    const first = planner.nextActions();
    const replicate = first.find((a) => a.type === 'replicate')!;
    planner.applyAction(replicate);
    const snap = planner.snapshot();
    const withInflight = snap.find((s) => s.partitionId === replicate.partitionId)!;
    assert.ok(withInflight.inflightReplicas.includes(replicate.brokerId));

    // 逐轮推进，任意时刻每个 Broker 的总占用（可用+inflight+removing）
    // 都不超过容量——这正是「复制中的副本也占槽位」的语义。
    const capacityById = new Map(brokers.map((b) => [b.id, b.capacity]));
    for (let guard = 0; guard < 50 && !planner.isConverged(); guard++) {
      const batch = planner.nextActions();
      for (const a of batch) {
        planner.applyAction(a);
        if (a.type === 'delete') planner.releaseRemoval(a.partitionId, a.brokerId);
        const usage = new Map<string, number>();
        for (const s of planner.snapshot()) {
          for (const b of [
            ...s.availableReplicas,
            ...s.inflightReplicas,
            ...s.removingReplicas,
          ]) {
            usage.set(b, (usage.get(b) ?? 0) + 1);
          }
        }
        for (const [b, n] of usage) {
          assert.ok(n <= capacityById.get(b)!, `Broker ${b} 占用 ${n} 超容量`);
        }
      }
    }
    assert.ok(planner.isConverged());
  });

  it('扩容：副本数从 1 增加到 3，全部约束与轨迹不变量成立', () => {
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
      broker('b3', 2, 'd3'),
    ];
    const target: Assignment = { p1: ['b1', 'b2', 'b3'] };
    const initial: Assignment = { p1: ['b1'] };
    const result = buildMigrationPlan(plannerInput(brokers, target, initial));
    assert.equal(result.status, 'complete');
    assertTrajectoryInvariants(
      topology(brokers, [partition('p1', 3, {}, ['b1'])]),
      target,
      result,
    );
    assert.deepEqual(
      result.actions.filter((a) => a.type === 'replicate').map((a) => a.brokerId).sort(),
      ['b2', 'b3'],
    );
    assert.equal(result.actions.filter((a) => a.type === 'delete').length, 0);
  });
});
