/**
 * ReadIndex 线性一致读测试。
 *
 * 关键约束：读取不能仅因本节点仍自认为领导者就成功——
 * 必须在当前任期确认有效领导权，并应用到该次读取所需的提交位置。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  awaitLeader,
  clientPropose,
  clientRead,
  createCluster,
  destroyCluster,
  isolatePolicy,
  run,
  settleOperation,
} from './helpers.ts';
import { NotLeaderError } from '../src/types.ts';

test('线性一致读：读到已提交数据，未提交数据不可见', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3'], { seed: 301 });
  try {
    const leader = awaitLeader(cluster)!;
    await clientPropose(cluster, { op: 'set', key: 'a', value: '1' });
    run(cluster);

    const r = await settleOperation(cluster, leader, leader.read((s) => s.a));
    assert.equal(r, '1');

    const missing = await settleOperation(cluster, leader, leader.read((s) => s.absent));
    assert.equal(missing, undefined);
  } finally {
    destroyCluster(cluster);
  }
});

test('隔离领导者：未获当前任期法定确认的读取被拒绝', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3'], { seed: 302 });
  try {
    const leader = awaitLeader(cluster)!;
    const leaderId = leader.id;
    await clientPropose(cluster, { op: 'set', key: 'x', value: 'committed' });
    run(cluster);

    // 隔离领导者全部双向流量（消息滞留，不丢弃）。
    cluster.transport.setPolicy(isolatePolicy(leaderId));

    // 立即在旧领导者上发起读取：此刻它仍自认为领导者，但心跳无法送达，
    // ReadIndex 永远拿不到法定人数确认。
    const stale = cluster.nodes.get(leaderId)!;
    const readAtStart = stale.status().role;
    assert.equal(readAtStart, 'leader');
    const readPromise = settleOperation(cluster, stale, stale.read((s) => s.x));
    await assert.rejects(
      readPromise,
      (error: unknown) => error instanceof NotLeaderError || error instanceof Error,
      '隔离领导者的读取必须失败，不能仅凭自认领导者返回数据',
    );

    // 其余两侧（多数派）选出新领导者并继续服务读取。
    const newLeader = awaitLeader(cluster, 100_000)!;
    assert.notEqual(newLeader.id, leaderId);
    const ok = await settleOperation(cluster, newLeader, newLeader.read((s) => s.x));
    assert.equal(ok, 'committed', '新领导者读到先前已提交数据');
  } finally {
    destroyCluster(cluster);
  }
});

test('读取所需提交位置：新领导者对旧任期数据的读取在应用后才返回', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3', 'n4', 'n5'], { seed: 303 });
  try {
    const leader1 = awaitLeader(cluster)!;
    await clientPropose(cluster, { op: 'set', key: 'old', value: 'data' });
    run(cluster);

    // 停掉旧领导者，剩余节点重新选举。
    cluster.transport.setPolicy(isolatePolicy(leader1.id));
    // 等待多数派侧产生任期更高的新领导者。
    let leader2 = awaitLeader(cluster, 100_000)!;
    for (let i = 0; i < 50 && leader2.id === leader1.id; i++) {
      run(cluster, 3_000);
      leader2 = awaitLeader(cluster, 100_000)!;
    }
    assert.notEqual(leader2.id, leader1.id, '新领导者来自多数派一侧');

    // 新领导者的 ReadIndex 必须等到 no-op 提交、旧条目可应用后才返回旧数据。
    const value = await settleOperation(cluster, leader2, leader2.read((s) => s.old));
    assert.equal(value, 'data');

    // 恢复旧领导者后，它最终也读到相同状态。
    cluster.transport.setPolicy({});
    cluster.transport.releaseHeld();
    run(cluster, 20_000);
    const healedValue = await clientRead(cluster, 'old');
    assert.equal(healedValue.value, 'data');
  } finally {
    destroyCluster(cluster);
  }
});
