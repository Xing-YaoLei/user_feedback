/**
 * 用发送/接收轨迹复验一轮成功快照:
 * 1. 一致切面:任何“接收效果计入截面”的消息,其发送必须也在截面内;
 * 2. 通道记录恰好等于“截面内发出、截面外接收”的消息(不多、不少、不重复);
 * 3. 接收方截面状态中的接收记录恰好等于“截面内发出、截面内接收”的消息;
 * 4. 重复投递不会造成重复计数或重复状态。
 */
import assert from 'node:assert/strict';
import type { Harness, TraceEvent } from '../src/harness.ts';
import type { NodeId, SnapshotResult } from '../src/snapshot.ts';

export interface AppState {
  received: Array<{ from: NodeId; seq: number; payload: unknown }>;
}

export function verifySnapshotResult(harness: Harness, result: SnapshotResult): void {
  const roundId = result.roundId;

  // 各节点记录本轮截面的轨迹位置
  const recIdx = new Map<NodeId, number>();
  for (const e of harness.trace) {
    if (e.type === 'record' && e.round === roundId) {
      assert(!recIdx.has(e.node), `节点 ${e.node} 重复记录轮次 ${roundId}`);
      recIdx.set(e.node, e.index);
    }
  }
  for (const n of result.roster) {
    assert(recIdx.has(n), `节点 ${n} 从未记录轮次 ${roundId},却出现在结果中`);
  }

  // 发送事件与首次投递事件(重复投递只算第一次)
  const sends: TraceEvent[] = [];
  const firstDeliver = new Map<string, TraceEvent>();
  for (const e of harness.trace) {
    if (e.type === 'send-business') sends.push(e);
    if (e.type === 'deliver-business') {
      const k = `${e.from}#${e.node}#${e.seq}`;
      if (!firstDeliver.has(k)) firstDeliver.set(k, e);
    }
  }

  const expectedChannels = new Map<string, Map<number, unknown>>(); // "n->m" -> seq -> payload
  const absorbed = new Map<NodeId, Map<string, unknown>>(); // m -> "n#seq" -> payload

  for (const s of sends) {
    const d = firstDeliver.get(`${s.node}#${s.to}#${s.seq}`);
    if (!d) continue; // 尚未投递(只可能是截面后消息)
    const sendPre = s.index < recIdx.get(s.node!)!;
    const recvPre = d.index < recIdx.get(s.to!)!;
    assert(
      !(recvPre && !sendPre),
      `不一致切面:消息 ${s.node}#${s.seq} 的接收计入截面,但发送不在截面内`,
    );
    if (sendPre && !recvPre) {
      const key = `${s.node}->${s.to}`;
      if (!expectedChannels.has(key)) expectedChannels.set(key, new Map());
      expectedChannels.get(key)!.set(s.seq!, s.payload);
    }
    if (sendPre && recvPre) {
      if (!absorbed.has(s.to!)) absorbed.set(s.to!, new Map());
      absorbed.get(s.to!)!.set(`${s.node}#${s.seq}`, s.payload);
    }
  }

  // 通道记录恰好等于“截面内发出、截面外接收”的消息
  for (const n of result.roster) {
    for (const m of result.roster) {
      if (n === m) continue;
      const key = `${n}->${m}`;
      const expected = expectedChannels.get(key) ?? new Map<number, unknown>();
      const actual = result.channels[key];
      assert(actual, `结果缺少通道记录 ${key}`);
      assert.equal(
        actual.messages.length,
        expected.size,
        `通道 ${key} 在途消息数量不符:实际 [${actual.messages.map((x) => x.seq)}],期望 [${[...expected.keys()]}]`,
      );
      const seenSeq = new Set<number>();
      for (const msg of actual.messages) {
        assert(!seenSeq.has(msg.seq), `通道 ${key} 出现重复消息 seq=${msg.seq}(重复投递污染)`);
        seenSeq.add(msg.seq);
        assert(expected.has(msg.seq), `通道 ${key} 出现不该有的消息 seq=${msg.seq}`);
        assert.deepEqual(msg.payload, expected.get(msg.seq), `通道 ${key} 消息 seq=${msg.seq} 载荷不符`);
      }
    }
  }

  // 接收方截面状态恰好等于“截面内发出、截面内接收”的消息
  for (const m of result.roster) {
    const state = result.states[m] as AppState;
    const expectedAbsorbed = absorbed.get(m) ?? new Map<string, unknown>();
    const receivedKeys = new Set(state.received.map((r) => `${r.from}#${r.seq}`));
    assert.equal(
      state.received.length,
      receivedKeys.size,
      `节点 ${m} 的截面状态含重复接收记录(重复投递污染)`,
    );
    assert.equal(
      receivedKeys.size,
      expectedAbsorbed.size,
      `节点 ${m} 截面状态与轨迹不符:状态 [${[...receivedKeys]}],期望 [${[...expectedAbsorbed.keys()]}]`,
    );
    for (const k of expectedAbsorbed.keys()) {
      assert(receivedKeys.has(k), `节点 ${m} 的截面状态缺少已吸收消息 ${k}`);
    }
  }
}
