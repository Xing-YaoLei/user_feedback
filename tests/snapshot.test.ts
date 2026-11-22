import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness, type InflightItem } from '../src/harness.ts';
import {
  SnapshotNode,
  type ChannelRecord,
  type FailReason,
  type NodeId,
  type SnapshotResult,
} from '../src/snapshot.ts';
import { verifySnapshotResult, type AppState } from './verify.ts';

interface Cluster {
  harness: Harness;
  nodes: Map<NodeId, SnapshotNode>;
  states: Map<NodeId, AppState>;
  completions: SnapshotResult[];
  failures: Array<{ node: NodeId; roundId: string; reason: FailReason }>;
}

function makeCluster(
  ids: NodeId[],
  opts: { maxRounds?: number | ((id: NodeId) => number); epoch?: number } = {},
): Cluster {
  const harness = new Harness();
  const states = new Map<NodeId, AppState>();
  const nodes = new Map<NodeId, SnapshotNode>();
  const completions: SnapshotResult[] = [];
  const failures: Cluster['failures'] = [];
  for (const id of ids) {
    const state: AppState = { received: [] };
    states.set(id, state);
    const maxRounds = typeof opts.maxRounds === 'function' ? opts.maxRounds(id) : opts.maxRounds;
    const node = new SnapshotNode({
      id,
      roster: ids,
      transport: harness,
      maxRounds,
      authorityEpoch: opts.epoch ?? 0,
      captureState: () => structuredClone(state),
      onBusiness: ({ from, seq, payload }) => {
        state.received.push({ from, seq, payload });
        // 交错业务回复:处理 ping 时同步回复 pong
        if (typeof payload === 'string' && payload.startsWith('ping')) {
          node.sendBusiness(from, `pong:${payload}`);
        }
      },
      onRoundComplete: (r) => completions.push(r),
      onRoundFailed: (roundId, reason) => failures.push({ node: id, roundId, reason }),
      onEvent: harness.eventSink(id),
    });
    nodes.set(id, node);
    harness.register(node);
  }
  return { harness, nodes, states, completions, failures };
}

const isAnnounce = (round: string, to: string) => (it: InflightItem) =>
  it.msg.kind === 'announce' && it.msg.round === round && it.to === to;

const isBusiness = (payload: string) => (it: InflightItem) =>
  it.msg.kind === 'business' && it.msg.payload === payload;

const payloadsOf = (rec: ChannelRecord | undefined): unknown[] =>
  (rec?.messages ?? []).map((m) => m.payload).sort();

test('重叠快照与交错业务回复:一致切面、精确通道记录、重复投递不污染', () => {
  const { harness, nodes, completions, failures } = makeCluster(['A', 'B', 'C']);
  const A = nodes.get('A')!;
  const B = nodes.get('B')!;
  const C = nodes.get('C')!;

  // 快照开始前的业务流量
  A.sendBusiness('B', 'ping-a1');
  B.sendBusiness('C', 'ping-b1');

  // 截面前消息先投递:B 吸收 ping-a1,并同步回复 pong(交错业务回复)
  assert(harness.deliverOne(isBusiness('ping-a1')));

  // 两个不同节点同时发起快照
  assert.equal(A.startRound('r1'), true);
  assert.equal(B.startRound('r2'), true);

  A.sendBusiness('C', 'ping-a2'); // A 已记录 r1 → 携带 r1 标记
  C.sendBusiness('A', 'ping-c1'); // C 不知任何轮次 → 无标记

  // 部分控制消息:r1 公告到 B;r2 公告到 A、C
  assert(harness.deliverOne(isAnnounce('r1', 'B')));
  assert(harness.deliverOne(isAnnounce('r2', 'A')));
  assert(harness.deliverOne(isAnnounce('r2', 'C')));

  // C 尚未得知 r1:r1 的控制消息仍在途中
  assert.deepEqual(C.activeRoundIds().sort(), ['r2']);
  assert.equal(harness.findInflight(isAnnounce('r1', 'C')).length, 1);

  // 先到的截面后消息:ping-a2 携带 r1 标记先于 r1 公告到达 C,
  // C 依据业务消息携带的轮次信息补做 r1 截面(而非依据控制消息到达顺序)
  assert(harness.deliverOne(isBusiness('ping-a2'), 2)); // 重复投递
  assert.deepEqual(C.activeRoundIds().sort(), ['r1', 'r2']);
  assert.equal(harness.findInflight(isAnnounce('r1', 'C')).length, 1); // 公告仍未到达

  // 迟到的截面前消息:ping-c1 无标记,在 A 记录 r1/r2 之后才到达 → 进入通道记录
  assert(harness.deliverOne(isBusiness('ping-c1'), 2)); // 重复投递

  // B 截面前发出的 pong 迟到 → 进入通道记录;重复投递
  assert(harness.deliverOne(isBusiness('pong:ping-a1'), 2));

  // 剩余消息乱序投递,约 1/4 重复
  harness.flush({ seed: 42, dupProb: 0.25 });

  assert.equal(failures.length, 0, `不应有失败轮次: ${JSON.stringify(failures)}`);
  const r1 = completions.find((c) => c.roundId === 'r1');
  const r2 = completions.find((c) => c.roundId === 'r2');
  assert(r1 && r2, '两轮快照都应成功');

  // 用发送/接收轨迹复验每个成功切面和通道记录
  verifySnapshotResult(harness, r1);
  verifySnapshotResult(harness, r2);

  // 场景定点断言
  assert.deepEqual(payloadsOf(r1.channels['C->A']), ['ping-c1']); // 迟到的截面前消息
  assert.deepEqual(payloadsOf(r2.channels['C->A']), ['ping-c1']);
  assert.deepEqual(payloadsOf(r1.channels['A->C']), []); // ping-a2 对 r1 是截面后
  assert.deepEqual(payloadsOf(r2.channels['A->C']), ['ping-a2']); // 对 r2 是截面前、在途
  assert.deepEqual(payloadsOf(r1.channels['B->A']), ['pong:ping-a1']); // 迟到的截面前回复
  assert.deepEqual(payloadsOf(r2.channels['B->A']), ['pong:ping-a1']);
  assert.deepEqual((r1.states['B'] as AppState).received.map((x) => x.payload), ['ping-a1']);
  assert.deepEqual((r1.states['C'] as AppState).received, []); // ping-a2 在记录后处理

  // 重复投递确实发生过,且未污染结果(verify 内部已断言无重复)
  assert(harness.trace.some((e) => e.type === 'duplicate-business'));

  // 轮次结束后回收:无活动轮次,后续业务消息不再携带轮次标记
  for (const n of [A, B, C]) assert.deepEqual(n.activeRoundIds(), []);
  A.sendBusiness('B', 'ping-end');
  const last = harness.inflight.at(-1)!;
  assert(last.msg.kind === 'business' && last.msg.rounds.length === 0);
});

test('单轮取消:该轮明确失败,其他快照与业务继续推进', () => {
  const { harness, nodes, states, completions, failures } = makeCluster(['A', 'B', 'C']);
  const A = nodes.get('A')!;
  const B = nodes.get('B')!;
  const C = nodes.get('C')!;

  A.sendBusiness('B', 'ping-x');
  assert(A.startRound('r1'));
  assert(B.startRound('r2'));
  assert(harness.deliverOne(isAnnounce('r1', 'B'))); // B 记录 r1
  assert(harness.deliverOne(isAnnounce('r2', 'A'))); // A 记录 r2

  // 发起者取消 r1,中止广播重复投递
  assert.equal(A.cancelRound('r1'), true);
  harness.deliverWhere((it) => it.msg.kind === 'abort' && it.msg.round === 'r1', 2);
  harness.flush({ seed: 1, dupProb: 0.2 });

  // r1 明确失败且无结果
  assert(!completions.some((c) => c.roundId === 'r1'));
  assert(failures.some((f) => f.node === 'A' && f.roundId === 'r1' && f.reason === 'cancelled'));
  assert(failures.some((f) => f.node === 'B' && f.roundId === 'r1' && f.reason === 'cancelled'));

  // r2 不受取消影响,成功完成且结果经得起轨迹复验
  const r2 = completions.find((c) => c.roundId === 'r2');
  assert(r2, 'r2 应成功完成');
  verifySnapshotResult(harness, r2);

  // r1 状态已回收
  for (const n of [A, B, C]) assert.deepEqual(n.activeRoundIds(), []);
  assert.equal(A.roundOutcome('r1')?.outcome, 'failed');

  // 业务继续推进
  C.sendBusiness('A', 'ping-after');
  harness.flush();
  assert(states.get('A')!.received.some((x) => x.payload === 'ping-after'));
});

test('容量不足:该轮明确失败,其他轮次不受影响', () => {
  const { harness, nodes, completions, failures } = makeCluster(['A', 'B', 'C'], {
    maxRounds: (id) => (id === 'B' ? 1 : 4),
  });
  const A = nodes.get('A')!;
  const B = nodes.get('B')!;
  const C = nodes.get('C')!;

  assert(A.startRound('r1'));
  assert(C.startRound('r2'));

  // B 先记录 r1(占满容量),再收到 r2 公告 → 容量不足,明确失败并通知发起者
  assert(harness.deliverOne(isAnnounce('r1', 'B')));
  assert(harness.deliverOne(isAnnounce('r2', 'B')));
  harness.flush({ seed: 7, dupProb: 0.2 });

  // r1 成功,r2 明确失败
  const r1 = completions.find((c) => c.roundId === 'r1');
  assert(r1, 'r1 应成功完成');
  assert(!completions.some((c) => c.roundId === 'r2'));
  assert(failures.some((f) => f.node === 'B' && f.roundId === 'r2' && f.reason === 'capacity'));
  assert(failures.some((f) => f.node === 'C' && f.roundId === 'r2' && f.reason === 'capacity'));

  // 失败轮次不污染成功结果
  verifySnapshotResult(harness, r1);

  // 全部回收
  for (const n of [A, B, C]) assert.deepEqual(n.activeRoundIds(), []);
  assert.equal(C.roundOutcome('r2')?.outcome, 'failed');
});

test('权威节点代次变更:活动轮次明确失败,新代次可重新快照', () => {
  const { harness, nodes, states, completions, failures } = makeCluster(['A', 'B', 'C'], {
    epoch: 1,
  });
  const A = nodes.get('A')!;
  const B = nodes.get('B')!;
  const C = nodes.get('C')!;

  A.sendBusiness('B', 'ping-e1');
  assert(A.startRound('r1'));
  assert(harness.deliverOne(isAnnounce('r1', 'B'))); // B 记录 r1,C 的公告仍在途中

  // 权威节点代次变更 → r1 在所有节点明确失败
  for (const n of [A, B, C]) n.setAuthorityEpoch(2);
  harness.flush({ seed: 5, dupProb: 0.2 });

  assert(failures.some((f) => f.node === 'A' && f.roundId === 'r1' && f.reason === 'authority-epoch'));
  assert(failures.some((f) => f.node === 'B' && f.roundId === 'r1' && f.reason === 'authority-epoch'));
  assert(!completions.some((c) => c.roundId === 'r1'));
  // C 收到的是过期公告,被拒绝,从未记录 r1
  assert(!harness.trace.some((e) => e.type === 'record' && e.node === 'C' && e.round === 'r1'));

  // 业务投递继续推进
  assert(states.get('B')!.received.some((x) => x.payload === 'ping-e1'));

  // 新代次下新一轮快照成功
  assert(A.startRound('r2'));
  harness.flush({ seed: 6, dupProb: 0.2 });
  const r2 = completions.find((c) => c.roundId === 'r2');
  assert(r2, 'r2 应成功完成');
  assert.equal(r2.epoch, 2);
  verifySnapshotResult(harness, r2);
  for (const n of [A, B, C]) assert.deepEqual(n.activeRoundIds(), []);
});

test('重复投递只生效一次', () => {
  const { harness, nodes, states } = makeCluster(['A', 'B']);
  const A = nodes.get('A')!;

  A.sendBusiness('B', 'ping-dup');
  harness.deliverAt(0, 3); // 同一消息投递 3 次
  assert.equal(states.get('B')!.received.length, 1);
  assert.equal(states.get('B')!.received[0].payload, 'ping-dup');

  // pong 回复重复投递,同样只生效一次
  assert(harness.deliverOne(isBusiness('pong:ping-dup'), 2));
  assert.equal(states.get('A')!.received.length, 1);
  assert(harness.trace.filter((e) => e.type === 'duplicate-business').length >= 2);
});

test('无业务流量时快照完成且通道记录为空', () => {
  const { harness, nodes, completions, failures } = makeCluster(['A', 'B', 'C']);
  const A = nodes.get('A')!;

  assert(A.startRound('r1'));
  harness.flush();

  assert.equal(failures.length, 0);
  assert.equal(completions.length, 1);
  const r = completions[0];
  verifySnapshotResult(harness, r);
  for (const key of Object.keys(r.channels)) {
    assert.deepEqual(r.channels[key].messages, [], `通道 ${key} 应为空`);
  }
  for (const n of ['A', 'B', 'C']) {
    assert.deepEqual((r.states[n] as AppState).received, []);
  }
});
