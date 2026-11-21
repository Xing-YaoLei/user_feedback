/**
 * 可重复的成员替换混沌调度（题目指定场景）。
 *
 * 时间线（全部由固定种子的确定性调度器驱动）：
 *  1. 5 节点集群稳定服务，积累提交历史
 *  2. 发起成员替换，进入联合共识阶段（Cold,new 双多数派）
 *  3. 联合条目提交后、final 条目生成前，隔离旧领导者 L（双向滞留消息）
 *  4. 重启一个节点 R（保留本地持久化目录）
 *  5. 联合仲裁成员恢复通信并推进时间，新领导者 L2 在双多数派下产生
 *  6. 向两侧分区分别发起写入，核对各自是否满足当时的仲裁边界
 *  7. 对旧领导者发起读取，核对其无法仅凭自认领导者读到结果
 *  8. 补投先前滞留的消息，集群收敛到 Cnew
 *  9. 核对全部节点提交历史一致、读取结果线性一致
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  awaitLeader,
  clientPropose,
  createCluster,
  destroyCluster,
  isolatePolicy,
  restartNode,
  run,
  type Cluster,
} from './helpers.ts';
import {
  NotLeaderError,
  type ConfigEntry,
  type KvCommand,
  type LogEntry,
  type NodeId,
} from '../src/types.ts';
import type { RaftNode } from '../src/raft.ts';

type KvNode = RaftNode<Record<string, string>, KvCommand>;

function findJointIndex(node: KvNode): number {
  const log = (node as unknown as { log: LogEntry<KvCommand>[] }).log;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!.entry;
    if (entry.kind === 'config' && (entry as ConfigEntry).phase === 'joint') return log[i]!.index;
  }
  return 0;
}

function findFinalIndex(node: KvNode): number {
  const log = (node as unknown as { log: LogEntry<KvCommand>[] }).log;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!.entry;
    if (entry.kind === 'config' && (entry as ConfigEntry).phase === 'final') return log[i]!.index;
  }
  return 0;
}

function commandLog(node: KvNode): { index: number; term: number; command: KvCommand | null }[] {
  const log = (node as unknown as { log: LogEntry<KvCommand>[] }).log;
  return log
    .filter((e) => e.entry.kind === 'command' && !(e.entry as { noop?: boolean }).noop)
    .map((e) => ({
      index: e.index,
      term: e.term,
      command: (e.entry as { command: KvCommand }).command,
    }));
}

test('混沌：联合阶段隔离旧领导者 + 重启节点 + 滞留消息补投后的仲裁与收敛', async () => {
  const cluster = createCluster(['n1', 'n2', 'n3', 'n4', 'n5'], { seed: 777 });
  const trace: string[] = [];
  try {
    // -- 步骤 1：稳定集群与基线历史 --------------------------------------
    const leader = awaitLeader(cluster)!;
    const L = leader.id;
    trace.push(`t=${cluster.scheduler.now()} 初始领导者 L=${L}`);

    const baseline: { index: number; command: KvCommand }[] = [];
    for (let i = 0; i < 4; i++) {
      const command: KvCommand = { op: 'set', key: `base${i}`, value: `${i}` };
      const result = await clientPropose(cluster, command);
      baseline.push({ index: result.index, command });
    }
    run(cluster);

    // -- 步骤 2：发起成员替换 n1..n5 -> n3,n4,n5,n6,n7 -------------------
    const target: NodeId[] = ['n3', 'n4', 'n5', 'n6', 'n7'];
    const configChange = leader.beginConfigChange(target);

    // 推进到 joint 条目在旧领导者上提交（final 条目尚未生成）。
    let jointIndex = 0;
    for (let i = 0; i < 200; i++) {
      run(cluster, 200);
      jointIndex = findJointIndex(leader);
      if (jointIndex > 0 && leader.status().commitIndex >= jointIndex) break;
    }
    assert.ok(jointIndex > 0, '联合配置条目应当已提交');
    assert.equal(leader.status().config.joint, true);
    assert.equal(findFinalIndex(leader), 0, '隔离前 final 条目尚未生成');
    trace.push(`t=${cluster.scheduler.now()} 联合配置提交于 index=${jointIndex}`);

    // 联合阶段法定人数边界快照：
    //   Cold = {n1..n5} 多数派 3；Cnew = {n3,n4,n5,n6,n7} 多数派 3
    const config = leader.status().config;
    assert.deepEqual([...config.oldVoters].sort(), ['n1', 'n2', 'n3', 'n4', 'n5']);
    assert.deepEqual([...config.newVoters].sort(), ['n3', 'n4', 'n5', 'n6', 'n7']);

    // -- 步骤 3：隔离旧领导者 L（消息滞留而非丢弃） -----------------------
    cluster.transport.setPolicy(isolatePolicy(L));
    const heldBefore = cluster.transport.currentlyHeld();
    run(cluster, 500);
    trace.push(`t=${cluster.scheduler.now()} 隔离旧领导者 ${L}，滞留消息=${cluster.transport.currentlyHeld()}`);
    assert.ok(cluster.transport.currentlyHeld() >= heldBefore);

    // -- 步骤 4：重启一个节点 R（选一个同时属于新旧配置的成员 n4） --------
    const R: NodeId = 'n4';
    const termBeforeRestart = cluster.nodes.get(R)!.status().currentTerm;
    restartNode(cluster, R);
    const restarted = cluster.nodes.get(R)!;
    assert.equal(restarted.status().currentTerm, termBeforeRestart, '重启保留已持久化任期');
    assert.ok(restarted.status().lastLogIndex >= jointIndex, '重启保留联合配置日志');
    trace.push(`t=${cluster.scheduler.now()} 重启节点 ${R}`);

    // -- 步骤 5：推进时间，联合双多数派选出新领导者 L2 --------------------
    const newLeader = awaitLeader(cluster, 30_000);
    assert.ok(newLeader, '仲裁成员恢复通信后必须能选出新领导者');
    assert.notEqual(newLeader!.id, L, '新领导者不可能是被隔离的旧领导者');
    const L2 = newLeader!.id;
    assert.equal(newLeader!.status().config.joint, true, '选举发生在联合阶段，按双多数派裁决');
    trace.push(`t=${cluster.scheduler.now()} 联合阶段新领导者 L2=${L2} term=${newLeader!.status().currentTerm}`);

    // -- 步骤 6a：多数派一侧（新领导者侧）写入应成功 ----------------------
    const quorumWrite: KvCommand = { op: 'set', key: 'quorum-side', value: 'committed' };
    const quorumResult = await clientPropose(cluster, quorumWrite, 10);
    run(cluster, 20_000);
    trace.push(`t=${cluster.scheduler.now()} 仲裁侧写入提交 index=${quorumResult.index}`);

    // 联合阶段提交必须同时满足两套多数派：
    // 核对每个投票组都有至少多数派节点复制到该下标。
    const quorumIndex = quorumResult.index;
    const replicatedIn = (group: NodeId[]): number => {
      let count = 0;
      for (const id of group) {
        const node = cluster.nodes.get(id);
        if (node && node.status().lastApplied >= quorumIndex) count++;
      }
      return count;
    };
    assert.ok(
      replicatedIn(config.oldVoters) >= Math.floor(config.oldVoters.length / 2) + 1,
      '联合提交满足旧配置多数派',
    );
    assert.ok(
      replicatedIn(config.newVoters) >= Math.floor(config.newVoters.length / 2) + 1,
      '联合提交满足新配置多数派',
    );

    // -- 步骤 6b：分区 minority 侧（旧领导者 L）写入必须失败 --------------
    const staleLeader = cluster.nodes.get(L)!;
    assert.equal(staleLeader.status().role, 'leader', '旧领导者尚未收到更高任期，仍自认领导者');
    const staleWrite = staleLeader.propose({ op: 'set', key: 'isolated-side', value: 'never-commit' });
    run(cluster, 3_000);
    await assert.rejects(
      staleWrite,
      (error: unknown) => error instanceof NotLeaderError || error instanceof Error,
      '隔离侧写入无法取得联合仲裁，必须失败',
    );
    // 该命令绝不能出现在新领导者的提交历史中。
    const l2Log = commandLog(cluster.nodes.get(L2)!);
    assert.ok(
      !l2Log.some((e) => (e.command as { key?: string }).key === 'isolated-side'),
      '隔离侧的未仲裁写入不得进入提交历史',
    );
    trace.push(`t=${cluster.scheduler.now()} 隔离侧写入被仲裁边界拒绝`);

    // -- 步骤 7：旧领导者的读取不能仅凭自认领导者成功 ---------------------
    const staleRead = staleLeader.read((s) => s['quorum-side']);
    run(cluster, 3_000);
    await assert.rejects(staleRead, Error, '旧领导者读取缺少当前任期法定确认，必须失败');
    trace.push(`t=${cluster.scheduler.now()} 旧领导者读取被拒绝`);

    // -- 步骤 8：补投滞留消息，集群收敛到 Cnew ----------------------------
    const heldCount = cluster.transport.currentlyHeld();
    assert.ok(heldCount > 0, '隔离期间确实滞留了消息');
    cluster.transport.setPolicy({});
    const released = cluster.transport.releaseHeld();
    assert.equal(released, heldCount);
    run(cluster, 40_000);
    trace.push(`t=${cluster.scheduler.now()} 补投 ${released} 条滞留消息`);

    // 成员变更承诺最终结算，final 配置在所有目标节点生效。
    const finalIndex = await configChange;
    assert.ok(finalIndex > jointIndex);
    for (const id of target) {
      const node = cluster.nodes.get(id);
      assert.ok(node, `目标成员 ${id} 在线`);
      const nodeConfig = node!.status().config;
      assert.equal(nodeConfig.joint, false);
      assert.deepEqual([...nodeConfig.newVoters].sort(), [...target].sort());
    }

    // 旧领导者收到更高任期后下台，并通过退休补投追平 final 配置。
    assert.notEqual(staleLeader.status().role, 'leader');
    assert.ok(staleLeader.status().lastLogIndex >= finalIndex, '旧领导者补投后追平日志');

    // -- 步骤 9：提交历史与读取结果的全量核对 -----------------------------
    // 9a. 同一下标在所有节点上是同一条命令（日志一致性）。
    const referenceLog = commandLog(cluster.nodes.get(L2)!);
    for (const [id, node] of cluster.nodes) {
      const log = commandLog(node);
      assert.equal(log.length, referenceLog.length, `${id} 命令历史长度一致`);
      for (let i = 0; i < referenceLog.length; i++) {
        assert.deepEqual(log[i]!.command, referenceLog[i]!.command, `${id} 位置 ${i + 1} 命令一致`);
        assert.equal(log[i]!.term, referenceLog[i]!.term, `${id} 位置 ${i + 1} 任期一致`);
      }
    }

    // 9b. 所有基线命令与仲裁侧写入在每个节点的应用状态中成立。
    for (const node of cluster.nodes.values()) {
      const state = (node as unknown as { state: Record<string, string> }).state;
      for (let i = 0; i < 4; i++) assert.equal(state[`base${i}`], `${i}`);
      assert.equal(state['quorum-side'], 'committed');
      assert.equal(state['isolated-side'], undefined, '未仲裁写入在任何节点都不可见');
    }

    // 9c. 收敛后线性一致读取可用，且读到最新值。
    const healedLeader = awaitLeader(cluster)!;
    const value = await healedLeader.read((s) => s['quorum-side']);
    assert.equal(value, 'committed');

    const after = await clientPropose(cluster, { op: 'set', key: 'post-heal', value: 'done' });
    run(cluster);
    assert.ok(after.index > finalIndex);
    for (const id of target) {
      const state = (cluster.nodes.get(id)! as unknown as { state: Record<string, string> }).state;
      assert.equal(state['post-heal'], 'done');
    }
    trace.push(`t=${cluster.scheduler.now()} 收敛后新写入 index=${after.index}`);

    // 轨迹打印到测试诊断，便于人工复盘调度过程。
    assert.ok(trace.length === 9);
    // eslint-disable-next-line no-console
    console.log('\n混沌调度时间线：\n' + trace.map((line) => '  ' + line).join('\n'));
  } finally {
    destroyCluster(cluster);
  }
});

test('可重复性：相同种子的两次混沌运行产生相同的选举与提交轨迹', async () => {
  const runOnce = async (): Promise<{ leader: NodeId; terms: number[]; indices: number[] }> => {
    const cluster: Cluster = createCluster(['n1', 'n2', 'n3'], { seed: 909 });
    try {
      const leader = awaitLeader(cluster)!;
      const indices: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await clientPropose(cluster, { op: 'set', key: `k${i}`, value: 'v' });
        indices.push(r.index);
      }
      run(cluster);
      const terms: number[] = [];
      for (const node of cluster.nodes.values()) terms.push(node.status().currentTerm);
      return { leader: leader.id, terms: terms.sort(), indices };
    } finally {
      destroyCluster(cluster);
    }
  };

  const a = await runOnce();
  const b = await runOnce();
  assert.deepEqual(a, b, '相同种子下调度结果必须完全一致');
});
