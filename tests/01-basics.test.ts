/**
 * 基础场景：选举、日志复制、日志一致性、节点重启后的持久化约束。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appliedStates,
  awaitLeader,
  clientPropose,
  createCluster,
  destroyCluster,
  restartNode,
  run,
  stopNode,
  type Cluster,
} from './helpers.ts';

async function withCluster(
  ids: string[],
  seed: number,
  fn: (cluster: Cluster) => Promise<void> | void,
): Promise<void> {
  const cluster = createCluster(ids, { seed });
  try {
    await fn(cluster);
  } finally {
    destroyCluster(cluster);
  }
}

test('选举：唯一领导者产生，且其余节点为跟随者', () => {
  withCluster(['n1', 'n2', 'n3'], 101, (cluster) => {
    const leader = awaitLeader(cluster);
    assert.ok(leader, '应当在选举超时后选出领导者');
    for (const node of cluster.nodes.values()) {
      if (node.id === leader!.id) assert.equal(node.status().role, 'leader');
      else assert.equal(node.status().role, 'follower');
      assert.equal(node.status().currentTerm, leader!.status().currentTerm);
    }
  });
});

test('日志复制：已确认提交的命令在所有节点同一日志位置是同一条命令', async () => {
  await withCluster(['n1', 'n2', 'n3'], 102, async (cluster) => {
    const leader = awaitLeader(cluster)!;
    const r1 = await clientPropose(cluster, { op: 'set', key: 'k1', value: 'v1' });
    const r2 = await clientPropose(cluster, { op: 'set', key: 'k2', value: 'v2' });
    assert.ok(r2.index > r1.index);

    run(cluster);
    const term = leader.status().currentTerm;
    for (const node of cluster.nodes.values()) {
      const status = node.status();
      assert.ok(status.lastApplied >= r2.index, `${node.id} 应已应用到 ${r2.index}`);
      // 同一下标、同一任期、同一条命令。
      const log = (node as unknown as { log: { index: number; term: number; entry: unknown }[] }).log;
      const e1 = log.find((e) => e.index === r1.index)!;
      const e2 = log.find((e) => e.index === r2.index)!;
      assert.equal(e1.term, term);
      assert.equal(e2.term, term);
      assert.deepEqual(e1.entry, { kind: 'command', command: { op: 'set', key: 'k1', value: 'v1' } });
      assert.deepEqual(e2.entry, { kind: 'command', command: { op: 'set', key: 'k2', value: 'v2' } });
    }

    const states = appliedStates(cluster);
    for (const state of Object.values(states)) {
      assert.deepEqual(state, { k1: 'v1', k2: 'v2' });
    }
  });
});

test('持久化重启：节点保留任期、投票与日志，重启后继续收敛', async () => {
  await withCluster(['n1', 'n2', 'n3', 'n4', 'n5'], 103, async (cluster) => {
    awaitLeader(cluster);
    const result = await clientPropose(cluster, { op: 'set', key: 'persisted', value: 'yes' });
    run(cluster);

    // 停掉一个多数派之外的跟随者并重启，硬状态与日志必须原样恢复。
    const followerId = [...cluster.nodes.keys()].find((id) => id !== findLeaderId(cluster))!;
    const before = cluster.nodes.get(followerId)!.status();
    stopNode(cluster, followerId);
    const restarted = restartNode(cluster, followerId);
    const after = restarted.status();

    assert.equal(after.currentTerm, before.currentTerm, '任期持久化');
    assert.ok(after.lastLogIndex >= result.index, '日志持久化');
    assert.equal(after.lastApplied, before.lastApplied, '应用位点持久化');

    // 重启后集群仍能处理新命令。
    const next = await clientPropose(cluster, { op: 'set', key: 'after-restart', value: 'ok' });
    run(cluster);
    assert.ok(next.index > result.index);
    assert.equal(
      (restarted as unknown as { state: Record<string, string> }).state['after-restart'],
      'ok',
      '重启节点重新追平并应用新命令',
    );
  });
});

test('崩溃恢复：领导者重启后已提交命令仍然成立，且不会重复应用', async () => {
  await withCluster(['n1', 'n2', 'n3'], 104, async (cluster) => {
    const leader = awaitLeader(cluster)!;
    const result = await clientPropose(cluster, { op: 'set', key: 'durable', value: '1' });
    run(cluster);

    stopNode(cluster, leader.id);
    const revived = restartNode(cluster, leader.id);
    run(cluster);
    await awaitLeader(cluster);

    // 已提交命令在重启后的（可能是新的）领导者及全部节点上继续成立。
    const more = await clientPropose(cluster, { op: 'set', key: 'more', value: '2' });
    run(cluster);
    assert.ok(more.index > result.index);
    for (const node of cluster.nodes.values()) {
      const state = (node as unknown as { state: Record<string, string> }).state;
      assert.equal(state.durable, '1');
      assert.equal(state.more, '2');
    }
    // lastApplied 单调且与日志长度方向一致，证明没有重复应用。
    assert.ok(revived.status().lastApplied >= more.index);
  });
});

test('少数派分区恢复：分区期间无法提交，恢复后集群继续处理命令', async () => {
  await withCluster(['n1', 'n2', 'n3', 'n4', 'n5'], 105, async (cluster) => {
    const leader = awaitLeader(cluster)!;
    await clientPropose(cluster, { op: 'set', key: 'before', value: '1' });
    run(cluster);

    // 隔离 2 个节点（少数派），剩余 3 节点仍构成多数派。
    const isolated = new Set([leader.id, [...cluster.nodes.keys()].find((id) => id !== leader.id)!]);
    cluster.transport.setPolicy({
      holdPolicy: (message) => {
        const to = (message as { __to?: string }).__to;
        const source =
          message.type === 'RequestVote' ? message.candidateId
            : message.type === 'AppendEntries' ? message.leaderId
              : message.type === 'RequestVoteResp' ? message.voterId
                : message.followerId;
        return isolated.has(to!) || isolated.has(source);
      },
    });

    // 多数派一侧继续可用。
    const r2 = await clientPropose(cluster, { op: 'set', key: 'majority-side', value: '2' });
    run(cluster);
    assert.ok(r2.index > 0);

    // 补投滞留消息，集群重新收敛。
    cluster.transport.setPolicy({});
    cluster.transport.releaseHeld();
    run(cluster);

    const r3 = await clientPropose(cluster, { op: 'set', key: 'after-heal', value: '3' });
    run(cluster);
    for (const node of cluster.nodes.values()) {
      const state = (node as unknown as { state: Record<string, string> }).state;
      assert.equal(state.before, '1');
      assert.equal(state['majority-side'], '2');
      assert.equal(state['after-heal'], '3');
    }
  });
});

function findLeaderId(cluster: Cluster): string {
  for (const [id, node] of cluster.nodes) if (node.status().role === 'leader') return id;
  throw new Error('no leader');
}
