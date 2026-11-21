/**
 * 网络故障注入：消息丢失、重复、延迟与乱序下集群仍可收敛。
 * 故障策略由调度器 RNG 驱动，固定种子即可重复。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  awaitLeader,
  clientPropose,
  createCluster,
  destroyCluster,
  run,
} from './helpers.ts';

test('消息持续随机丢失：重试后命令仍能提交并复制到多数派', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3', 'n4', 'n5'], {
    seed: 201,
    policy: {
      // 约 20% 消息丢失，低于多数派存活边界，集群保持可用；
      // 概率抽取走调度器 RNG，整个过程严格可重复。
      dropPolicy: () => cluster.scheduler.randomInt(0, 100) < 20,
    },
  });
  try {
    awaitLeader(cluster);
    for (let i = 0; i < 6; i++) {
      const result = await clientPropose(cluster, { op: 'set', key: `k${i}`, value: `v${i}` }, 20);
      assert.ok(result.index > 0);
    }
    run(cluster, 40_000);

    const leader = awaitLeader(cluster)!;
    const leaderState = (leader as unknown as { state: Record<string, string> }).state;
    for (let i = 0; i < 6; i++) assert.equal(leaderState[`k${i}`], `v${i}`);

    // 至少多数派节点应用了全部命令。
    let applied = 0;
    for (const node of cluster.nodes.values()) {
      const state = (node as unknown as { state: Record<string, string> }).state;
      if (state.k5 === 'v5') applied++;
    }
    assert.ok(applied >= 3, `多数派应已应用全部命令，实际 ${applied} 个节点`);
    assert.ok(cluster.transport.dropped > 0, '测试应当真实触发了消息丢失');
  } finally {
    destroyCluster(cluster);
  }
});

test('消息重复：重复投递不破坏日志一致性', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3'], {
    seed: 202,
    policy: {
      duplicatePolicy: (message) =>
        message.type === 'AppendEntries' && cluster.scheduler.randomInt(0, 100) < 30,
    },
  });
  try {
    awaitLeader(cluster);
    for (let i = 0; i < 4; i++) {
      await clientPropose(cluster, { op: 'set', key: `dup${i}`, value: 'x' });
    }
    run(cluster);

    const lengths = new Set<number>();
    for (const node of cluster.nodes.values()) {
      const log = (node as unknown as { log: unknown[] }).log;
      lengths.add(log.length);
    }
    assert.equal(lengths.size, 1, '所有节点日志长度一致');
    assert.ok(cluster.transport.duplicated > 0, '测试应当真实触发了重复投递');
  } finally {
    destroyCluster(cluster);
  }
});

test('延迟与乱序：随机延迟下提交历史仍然一致', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3', 'n4'], {
    seed: 203,
    policy: {
      // 0-40ms 抖动，心跳 60ms，制造持续乱序。
      delayPolicy: () => cluster.scheduler.randomInt(0, 41),
    },
  });
  try {
    awaitLeader(cluster);
    for (let i = 0; i < 5; i++) {
      await clientPropose(cluster, { op: 'set', key: `o${i}`, value: `${i}` });
    }
    run(cluster, 40_000);

    const reference = (awaitLeader(cluster)! as unknown as { log: { index: number; term: number; entry: unknown }[] }).log;
    for (const node of cluster.nodes.values()) {
      const log = (node as unknown as { log: { index: number; term: number; entry: unknown }[] }).log;
      assert.equal(log.length, reference.length, `${node.id} 日志长度一致`);
      for (let i = 0; i < reference.length; i++) {
        assert.deepEqual(log[i]!.entry, reference[i]!.entry, `${node.id} 位置 ${i + 1} 命令一致`);
        assert.equal(log[i]!.term, reference[i]!.term);
      }
    }
  } finally {
    destroyCluster(cluster);
  }
});
