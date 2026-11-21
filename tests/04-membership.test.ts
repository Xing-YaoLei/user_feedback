/**
 * 在线成员变更测试（联合共识）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addNode,
  awaitLeader,
  clientPropose,
  createCluster,
  destroyCluster,
  run,
  settleOperation,
} from './helpers.ts';
import {
  ConfigChangeRejectedError,
  type ActiveConfig,
  type ConfigEntry,
  type KvCommand,
  type LogEntry,
  type NodeId,
} from '../src/types.ts';
import type { RaftNode } from '../src/raft.ts';

type KvNode = RaftNode<Record<string, string>, KvCommand>;

function configOf(node: KvNode): ActiveConfig {
  return node.status().config;
}

function configEntries(node: KvNode): LogEntry<KvCommand>[] {
  const log = (node as unknown as { log: LogEntry<KvCommand>[] }).log;
  return log.filter((e) => e.entry.kind === 'config');
}

test('成员替换：新成员先追平，再经联合配置过渡到目标配置', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3'], { seed: 401 });
  try {
    const leader = awaitLeader(cluster)!;
    for (let i = 0; i < 3; i++) {
      await clientPropose(cluster, { op: 'set', key: `base${i}`, value: `${i}` });
    }
    run(cluster);

    // 目标：n3,n4,n5 —— n4/n5 是全新节点，先实例化为学习者，n1/n2 将被移出。
    addNode(cluster, 'n4');
    addNode(cluster, 'n5');
    const target: NodeId[] = ['n3', 'n4', 'n5'];
    const change = leader.beginConfigChange(target);
    const committedIndex = await settleOperation(cluster, leader, change);
    assert.ok(committedIndex > 0);

    for (const id of target) {
      const node = cluster.nodes.get(id);
      assert.ok(node, `目标成员 ${id} 应当已在集群中`);
      const config = configOf(node!);
      assert.deepEqual([...config.newVoters].sort(), [...target].sort());
      assert.equal(config.joint, false, 'final 配置已生效');
    }

    // 日志中必须先 joint 后 final，且 joint 条目同时携带新旧两套投票集。
    const entries = configEntries(leader);
    const joint = entries.find((e) => (e.entry as ConfigEntry).phase === 'joint')!;
    const final = entries.find((e) => (e.entry as ConfigEntry).phase === 'final')!;
    assert.ok(joint.index < final.index);
    const jointCfg = joint.entry as ConfigEntry;
    assert.deepEqual([...jointCfg.oldVoters!].sort(), ['n1', 'n2', 'n3']);
    assert.deepEqual([...jointCfg.voters].sort(), ['n3', 'n4', 'n5']);

    // 新成员是先追平历史再入配置：它们拥有全部基础命令。
    for (const id of ['n4', 'n5']) {
      const state = (cluster.nodes.get(id)! as unknown as { state: Record<string, string> }).state;
      assert.equal(state.base0, '0');
      assert.equal(state.base1, '1');
      assert.equal(state.base2, '2');
    }
  } finally {
    destroyCluster(cluster);
  }
});

test('联合阶段按新旧配置各自多数派裁决提交', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3'], { seed: 402 });
  try {
    const leader = awaitLeader(cluster)!;
    await clientPropose(cluster, { op: 'set', key: 'warmup', value: '1' });
    run(cluster);

    // 手动卡在联合阶段：发起变更后只推进到 joint 提交、final 尚未复制。
    addNode(cluster, 'n4');
    const target: NodeId[] = ['n2', 'n3', 'n4'];
    const change = leader.beginConfigChange(target);

    // 推进到领导者日志出现 joint 条目并完成联合提交。
    let jointIndex = 0;
    for (let i = 0; i < 100; i++) {
      run(cluster, 500);
      const entries = configEntries(leader);
      const joint = entries.find((e) => (e.entry as ConfigEntry).phase === 'joint');
      if (joint && leader.status().commitIndex >= joint.index) {
        jointIndex = joint.index;
        break;
      }
    }
    assert.ok(jointIndex > 0, '联合配置条目应已提交');
    assert.equal(configOf(leader).joint, true);

    // 联合阶段一条新写入的提交必须同时拿到：
    //   旧配置 {n1,n2,n3} 多数派（>=2）与新配置 {n2,n3,n4} 多数派（>=2）
    const result = await clientPropose(cluster, { op: 'set', key: 'joint-write', value: 'yes' });
    run(cluster, 20_000);
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      const node = cluster.nodes.get(id)!;
      assert.ok(
        node.status().lastApplied >= result.index,
        `${id} 在联合阶段应用了双多数派提交的写入`,
      );
    }

    // 让变更走完。
    await settleOperation(cluster, leader, change);
    assert.equal(configOf(leader).joint, false);
  } finally {
    destroyCluster(cluster);
  }
});

test('一次只处理一项成员变更：并发请求被拒绝', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3'], { seed: 403 });
  try {
    const leader = awaitLeader(cluster)!;
    addNode(cluster, 'n4');
    addNode(cluster, 'n5');
    const first = leader.beginConfigChange(['n1', 'n2', 'n4']);
    await assert.rejects(
      leader.beginConfigChange(['n1', 'n5']),
      ConfigChangeRejectedError,
    );
    await settleOperation(cluster, leader, first);

    // 上一项完成后才能发起下一项。
    const second = leader.beginConfigChange(['n2', 'n4']);
    await settleOperation(cluster, leader, second);
    assert.deepEqual(configOf(leader).newVoters.sort(), ['n2', 'n4']);
  } finally {
    destroyCluster(cluster);
  }
});

test('当前领导者可被移出目标集合：切换后旧领导者下台，集群继续写入', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3'], { seed: 404 });
  try {
    const leader = awaitLeader(cluster)!;
    addNode(cluster, 'n4');
    const oldLeaderId = leader.id;
    const target: NodeId[] = ['n2', 'n3', 'n4']; // 不含旧领导者
    const change = leader.beginConfigChange(target);
    await settleOperation(cluster, leader, change);

    const oldLeader = cluster.nodes.get(oldLeaderId)!;
    assert.notEqual(oldLeader.status().role, 'leader', '旧领导者已主动下台');
    assert.deepEqual(oldLeader.status().config.newVoters.sort(), [...target].sort());

    const next = await clientPropose(cluster, { op: 'set', key: 'post-change', value: 'ok' });
    run(cluster);
    assert.ok(next.leaderId !== oldLeaderId);
    for (const id of target) {
      const state = (cluster.nodes.get(id)! as unknown as { state: Record<string, string> }).state;
      assert.equal(state['post-change'], 'ok');
    }
  } finally {
    destroyCluster(cluster);
  }
});
