/**
 * 执行器测试（异步交错场景）：
 * 1. 正常驱动到收敛，动作事件与最终状态核对；
 * 2. 复制中途 Broker 退出：以真实副本为基线重新推进；
 * 3. 旧复制未结束就重新规划：迟到结果先计入占用再决定接纳/清理；
 * 4. 复制失败后自动重试；
 * 5. 任意事件后槽位占用（含 inflight）不超容量。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ManualReplicationAdapter,
  MigrationExecutor,
  type ExecutorEvent,
} from '../src/index.ts';
import { broker } from './helpers.ts';
import type { Assignment, BrokerSpec } from '../src/types.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * 从执行器创建起收集全部事件，并提供「等待未来事件」的能力，
 * 避免监听器注册晚于事件发出而丢事件。
 */
class EventCollector {
  private readonly events: ExecutorEvent[] = [];
  private readonly waiters: Array<{
    predicate: (e: ExecutorEvent) => boolean;
    resolve: (e: ExecutorEvent) => void;
  }> = [];

  constructor(executor: MigrationExecutor) {
    executor.onEvent((e) => this.push(e));
  }

  private push(e: ExecutorEvent): void {
    this.events.push(e);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.predicate(e)) {
        this.waiters.splice(i, 1);
        w.resolve(e);
      }
    }
  }

  /** 等待匹配事件：已收集的历史事件优先，否则等待未来事件。 */
  wait(predicate: (e: ExecutorEvent) => boolean, timeoutMs = 2000): Promise<ExecutorEvent> {
    const past = this.events.find(predicate);
    if (past) return Promise.resolve(past);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(
          new Error(
            `等待事件超时，已收集: ${JSON.stringify(this.events.map((e) => e.type))}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  all(): ExecutorEvent[] {
    return [...this.events];
  }
}

function assertCapacityHeld(brokers: BrokerSpec[], executor: MigrationExecutor): void {
  const usage = new Map<string, number>();
  for (const snap of executor.snapshot()) {
    for (const b of [
      ...snap.availableReplicas,
      ...snap.inflightReplicas,
      ...snap.removingReplicas,
    ]) {
      usage.set(b, (usage.get(b) ?? 0) + 1);
    }
  }
  for (const b of brokers) {
    assert.ok(
      (usage.get(b.id) ?? 0) <= b.capacity,
      `Broker ${b.id} 占用 ${usage.get(b.id) ?? 0} 超过容量 ${b.capacity}`,
    );
  }
}

const isReplicate = (brokerId?: string) => (e: ExecutorEvent) =>
  e.type === 'action' && e.action.type === 'replicate' &&
  (brokerId === undefined || e.action.brokerId === brokerId);

describe('MigrationExecutor 异步执行', () => {
  it('正常路径：复制 -> 追平 -> 删除，最终收敛到目标', async () => {
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
      broker('b3', 2, 'd3'),
    ];
    const adapter = new ManualReplicationAdapter();
    const executor = new MigrationExecutor({
      brokers,
      partitionIds: ['p1'],
      target: { p1: ['b1', 'b3'] },
      initial: { p1: ['b1', 'b2'] },
      adapter,
    });
    const collector = new EventCollector(executor);
    executor.kick();

    const rep = await collector.wait(isReplicate('b3'));
    assert.equal(rep.type === 'action' && rep.action.brokerId, 'b3');
    // 复制中：b3 已计入槽位占用。
    assert.ok(executor.snapshot()[0]!.inflightReplicas.includes('b3'));
    assertCapacityHeld(brokers, executor);

    adapter.succeed('p1', 'b3');
    await collector.wait((e) => e.type === 'converged');

    assert.deepEqual(executor.snapshot()[0]!.availableReplicas, ['b1', 'b3']);
    assert.deepEqual(adapter.deletedReplicas(), [
      { partitionId: 'p1', brokerId: 'b2' },
    ]);
    // 追平事件先于删除事件。
    const events = collector.all();
    const catchupIdx = events.findIndex((e) => e.type === 'catchup');
    const deleteIdx = events.findIndex(
      (e) => e.type === 'action' && e.action.type === 'delete',
    );
    assert.ok(catchupIdx >= 0 && deleteIdx > catchupIdx);
    assertCapacityHeld(brokers, executor);
  });

  it('复制中途 Broker 退出：以真实存在的副本为基线继续推进', async () => {
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
      broker('b3', 2, 'd3'),
      broker('b4', 2, 'd4'),
    ];
    const adapter = new ManualReplicationAdapter();
    const executor = new MigrationExecutor({
      brokers,
      partitionIds: ['p1'],
      target: { p1: ['b1', 'b3'] },
      initial: { p1: ['b1', 'b2'] },
      adapter,
    });
    const collector = new EventCollector(executor);
    executor.kick();

    await collector.wait(isReplicate('b3'));
    assert.ok(adapter.hasPending('p1', 'b3'));

    // b3 在复制完成前退出：规划基线回到真实副本 b1,b2，目标 Broker 失效。
    executor.handleBrokerExit('b3');
    const exitEvent = await collector.wait((e) => e.type === 'broker-exit');
    assert.equal(exitEvent.type, 'broker-exit');
    assert.equal(executor.currentEpoch(), 1);
    const blocked = await collector.wait((e) => e.type === 'blocked');
    assert.equal(blocked.type, 'blocked');
    if (blocked.type === 'blocked') {
      assert.equal(blocked.report.kind, 'target-broker-unavailable');
    }

    // 用存活 Broker 重新规划到 b4，应能收敛。
    executor.replan({ p1: ['b1', 'b4'] }, brokers.filter((b) => b.id !== 'b3'));
    await collector.wait(
      (e) => e.type === 'action' && e.action.type === 'replicate' && e.action.brokerId === 'b4',
    );
    adapter.succeed('p1', 'b4');
    await collector.wait((e) => e.type === 'converged');
    assert.deepEqual(executor.snapshot()[0]!.availableReplicas, ['b1', 'b4']);
    assertCapacityHeld(brokers.filter((b) => b.id !== 'b3'), executor);
  });

  it('旧复制尚未结束就重新规划：迟到的成功结果先计占用再清理', async () => {
    const brokers = [
      broker('b1', 3, 'd1'),
      broker('b2', 3, 'd2'),
      broker('b3', 3, 'd3'),
    ];
    const adapter = new ManualReplicationAdapter();
    const executor = new MigrationExecutor({
      brokers,
      partitionIds: ['p1'],
      target: { p1: ['b1', 'b2'] },
      initial: { p1: ['b1'] },
      adapter,
    });
    const collector = new EventCollector(executor);
    executor.kick();

    // 第一次规划：复制 p1 -> b2。
    await collector.wait(isReplicate('b2'));
    assert.ok(adapter.hasPending('p1', 'b2'));

    // 复制尚未结束，新规划改为 b1+b3（基线只有真实副本 b1），
    // 旧的 b2 复制不取消，允许其迟到结果到达。
    const epochBefore = executor.currentEpoch();
    executor.replan({ p1: ['b1', 'b3'] });
    assert.equal(executor.currentEpoch(), epochBefore + 1);
    await collector.wait(
      (e) =>
        e.type === 'action' &&
        e.action.type === 'replicate' &&
        e.action.brokerId === 'b3' &&
        e.epoch === executor.currentEpoch(),
    );

    // 旧的 b2 复制迟到成功：b2 已不在新目标，先计入占用再清理，不被接纳。
    adapter.succeed('p1', 'b2');
    const settled = await collector.wait(
      (e) => e.type === 'replication-settled' && e.brokerId === 'b2',
    );
    assert.equal(settled.type, 'replication-settled');
    if (settled.type === 'replication-settled') {
      assert.equal(settled.ok, true);
      assert.equal(settled.accepted, false);
    }
    assert.ok(!executor.snapshot()[0]!.availableReplicas.includes('b2'));
    assertCapacityHeld(brokers, executor);

    // 新复制完成后收敛。
    adapter.succeed('p1', 'b3');
    await collector.wait((e) => e.type === 'converged');
    assert.deepEqual(executor.snapshot()[0]!.availableReplicas, ['b1', 'b3']);
    assertCapacityHeld(brokers, executor);
    // 迟到副本被实际删除清理。
    assert.ok(
      adapter.deletedReplicas().some((d) => d.partitionId === 'p1' && d.brokerId === 'b2'),
    );
  });

  it('复制失败：释放占用并由下一轮调度重试，直到成功收敛', async () => {
    const brokers = [
      broker('b1', 2, 'd1'),
      broker('b2', 2, 'd2'),
    ];
    const adapter = new ManualReplicationAdapter();
    const executor = new MigrationExecutor({
      brokers,
      partitionIds: ['p1'],
      target: { p1: ['b1', 'b2'] },
      initial: { p1: ['b1'] },
      adapter,
    });
    const collector = new EventCollector(executor);
    executor.kick();

    await collector.wait(isReplicate());
    // 第一次复制失败。
    adapter.fail('p1', 'b2');
    const failed = await collector.wait(
      (e) => e.type === 'replication-settled' && e.ok === false,
    );
    assert.equal(failed.type, 'replication-settled');
    // 失败后 b2 不再占用槽位。
    assert.deepEqual(executor.snapshot()[0]!.inflightReplicas, []);
    assertCapacityHeld(brokers, executor);

    // 调度器自动重试（取第二次 replicate 事件）。
    await collector.wait(
      (e) =>
        e.type === 'action' &&
        e.action.type === 'replicate' &&
        e.action.brokerId === 'b2',
    );
    adapter.succeed('p1', 'b2');
    await collector.wait((e) => e.type === 'converged');
    assert.deepEqual(executor.snapshot()[0]!.availableReplicas, ['b1', 'b2']);
  });

  it('重新规划后迟到的失败结果不会破坏新规划状态', async () => {
    const brokers = [
      broker('b1', 3, 'd1'),
      broker('b2', 3, 'd2'),
      broker('b3', 3, 'd3'),
    ];
    const adapter = new ManualReplicationAdapter();
    const executor = new MigrationExecutor({
      brokers,
      partitionIds: ['p1'],
      target: { p1: ['b1', 'b2'] },
      initial: { p1: ['b1'] },
      adapter,
    });
    const collector = new EventCollector(executor);
    executor.kick();
    await collector.wait(isReplicate());

    // 重新规划到 b3，旧 b2 复制仍挂起。
    executor.replan({ p1: ['b1', 'b3'] });
    await collector.wait(isReplicate('b3'));

    // 旧复制迟到失败：安全忽略，新规划的 b3 复制不受影响。
    adapter.fail('p1', 'b2');
    await collector.wait(
      (e) => e.type === 'replication-settled' && e.brokerId === 'b2' && e.ok === false,
    );
    assert.ok(adapter.hasPending('p1', 'b3'));
    // 旧副本未在新规划状态中留下任何痕迹。
    assert.deepEqual(executor.snapshot()[0]!.inflightReplicas, ['b3']);

    adapter.succeed('p1', 'b3');
    await collector.wait((e) => e.type === 'converged');
    assert.deepEqual(executor.snapshot()[0]!.availableReplicas, ['b1', 'b3']);
    assertCapacityHeld(brokers, executor);
  });
});
