import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Federation } from '../src/federation.ts';
import { RING_DOMAINS, RING_EDGES } from './helpers.ts';

test('消息丢失后通过摘要重新交换补齐，最终收敛', () => {
  const fed = new Federation({ seed: 31 });
  for (const id of RING_DOMAINS) fed.addDomain(id);
  // A-B 链路上前 3 条消息全部丢失（会话摘要与首批公告丢失）
  let seen = 0;
  fed.connect('A', 'B', 0, {
    drop: () => {
      seen += 1;
      return seen <= 3;
    },
  });
  for (const e of RING_EDGES) {
    if ((e.a === 'A' && e.b === 'B') || (e.a === 'B' && e.b === 'A')) continue;
    fed.connect(e.a, e.b, e.cost);
  }
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();

  // B 仍可经环另一侧（B-C-F-A）学到路由，先验证已有备用路径
  assert.ok(fed.domain('B').getSelected('d'));
  assert.ok(fed.network.stats.dropped >= 3);

  // 重新建立 A-B 会话触发摘要重交换，补齐直连路径
  fed.bringUp('A', 'B');
  fed.runUntilIdle();
  const route = fed.domain('B').getSelected('d')!;
  // 直连零代价路径补齐后应成为最优
  assert.equal(route.totalCost, 0);
  assert.deepEqual([...route.fullPath], ['A', 'B']);
});

test('乱序与重复消息下版本流保证幂等且仍然收敛', () => {
  const fed = new Federation({ seed: 32 });
  for (const id of ['A', 'B', 'C']) fed.addDomain(id);
  fed.connect('A', 'B', 1, { reorderProb: 0.8, duplicateProb: 0.8 });
  fed.connect('B', 'C', 1, { reorderProb: 0.5, duplicateProb: 0.5 });
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();

  assert.ok(fed.domain('C').getSelected('d'));
  assert.deepEqual([...fed.domain('C').getSelected('d')!.fullPath], ['A', 'B', 'C']);
  assert.ok(fed.network.stats.duplicated > 0, '应实际发生重复投递');
  assert.ok(fed.network.stats.reordered > 0, '应实际发生乱序投递');

  // 重复消息没有产生重复 RIB 候选
  for (const id of ['A', 'B', 'C'] as const) {
    const rib = fed.domain(id).ribCandidates();
    const keys = new Set(rib.map((c) => `${c.learnedFrom}|${c.destination}`));
    assert.equal(keys.size, rib.length, `${id} RIB 中每个(邻居,目的地)至多一条候选`);
  }
});

test('REQUEST 补齐：丢失单条公告后经摘要请求重发恢复', () => {
  const fed = new Federation({ seed: 33 });
  for (const id of ['A', 'B']) fed.addDomain(id);
  // 仅丢弃第一条 announce（放行 summary，使重建后摘要能触发 request）
  let announceDropped = false;
  fed.connect('A', 'B', 2, {
    drop: (msg) => {
      if (!announceDropped && msg.kind === 'announce') {
        announceDropped = true;
        return true;
      }
      return false;
    },
  });
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();
  assert.equal(announceDropped, true);
  // 首条公告丢失，B 暂时没有路由
  assert.equal(fed.domain('B').getSelected('d'), null);

  // 重新会话：B 从 A 的摘要发现缺口并发送 REQUEST，A 重发当前公告
  fed.bringUp('A', 'B');
  fed.runUntilIdle();
  const route = fed.domain('B').getSelected('d');
  assert.ok(route, 'REQUEST 补齐后 B 应学到路由');
  assert.equal(route!.totalCost, 2);
  assert.ok(fed.trace.byType('request-sent').length >= 1);
});

test('撤销消息丢失后，摘要核对触发请求并以撤销状态收敛', () => {
  const fed = new Federation({ seed: 34 });
  for (const id of ['A', 'B', 'C']) fed.addDomain(id);
  fed.connect('A', 'B', 1);
  let withdrawDropped = false;
  fed.connect('B', 'C', 1, {
    drop: (msg) => {
      if (!withdrawDropped && msg.kind === 'withdraw') {
        withdrawDropped = true;
        return true;
      }
      return false;
    },
  });
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();
  assert.ok(fed.domain('C').getSelected('d'));

  // 目的地消失，B 向 C 的撤销被丢弃
  fed.domain('A').removeOwnedDestination('d');
  fed.runUntilIdle();
  assert.equal(withdrawDropped, true);
  assert.ok(fed.domain('C').getSelected('d'), '撤销丢失，C 暂时保留过期路由');

  // 重建会话：C 的摘要核对发现 B 已无该目的地，请求后 B 重发撤销
  fed.bringUp('B', 'C');
  fed.runUntilIdle();
  assert.equal(fed.domain('C').getSelected('d'), null, '补齐后 C 必须完成撤销');
});
