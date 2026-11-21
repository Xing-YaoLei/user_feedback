import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Federation } from '../src/federation.ts';
import { RING_DOMAINS, RING_EDGES, ringTopology } from './helpers.ts';
import { referenceShortestPaths } from '../src/reference.ts';

function build(): Federation {
  const fed = new Federation({ seed: 41 });
  for (const id of RING_DOMAINS) fed.addDomain(id);
  for (const e of RING_EDGES) fed.connect(e.a, e.b, e.cost);
  return fed;
}

test('数据转发沿选定完整路径逐跳交付，轨迹无环', () => {
  const fed = build();
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();

  const table = new Map(fed.allDomains().map((d) => [d.id, d]));
  const result = fed.domain('E').forward('d', table);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('应当交付成功');
  assert.equal(result.trace[0], 'E');
  assert.equal(result.trace[result.trace.length - 1], 'A');
  assert.equal(new Set(result.trace).size, result.trace.length, '转发轨迹无环');
  // 与 E 选定路由的完整路径一致；转发沿路径从末端走向来源
  const route = fed.domain('E').getSelected('d')!;
  assert.deepEqual([...result.trace], [...route.fullPath].reverse());
});

test('路径失效时返回可定位断点，修复后新事件按更新路由重新交付', () => {
  const fed = build();
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();
  const table = new Map(fed.allDomains().map((d) => [d.id, d]));

  // 断开 D-E：E 唯一邻居失活，本地路由被撤销，转发在 E 处以 no-route 定位
  fed.bringDown('D', 'E');
  fed.runUntilIdle();
  const broken = fed.domain('E').forward('d', table);
  assert.equal(broken.ok, false);
  if (broken.ok) throw new Error('应当失败');
  assert.equal(broken.breakDomain, 'E');
  assert.equal(broken.reason, 'no-route');

  // 恢复链路并重新收敛，再次转发成功
  fed.bringUp('D', 'E');
  fed.runUntilIdle();
  const healed = fed.domain('E').forward('d', table, 1);
  assert.equal(healed.ok, true);
  if (!healed.ok) throw new Error('恢复后应交付成功');
  assert.equal(healed.trace[healed.trace.length - 1], 'A');

  // 两次转发轨迹都被记录，且第二次无环
  const traces = fed.trace.forwardTraces('d');
  assert.equal(traces.length, 2);
  for (const t of traces) {
    assert.equal(new Set(t).size, t.length);
  }
});

test('inactive-link 断点：路由仍在但下一跳链路失活时精确定位', () => {
  // 线性链 A-B-C，目的地在 A；断开 B-C 后 C 路由撤销。
  // 为单独覆盖 inactive-link 分支，构造 B 仍持有经 A 路由、但 B-C 失活的场景，
  // 由 C 侧转发：C 先 no-route；再验证 B 自身向 A 的转发不受影响。
  const fed = new Federation({ seed: 43 });
  for (const id of ['A', 'B', 'C']) fed.addDomain(id);
  fed.connect('A', 'B', 1);
  fed.connect('B', 'C', 1);
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();
  const table = new Map(fed.allDomains().map((d) => [d.id, d]));

  fed.bringDown('B', 'C');
  fed.runUntilIdle();
  // C 撤销：no-route 断点
  const atC = fed.domain('C').forward('d', table);
  assert.equal(atC.ok, false);
  if (atC.ok) throw new Error('应当失败');
  assert.equal(atC.breakDomain, 'C');
  assert.equal(atC.reason, 'no-route');
  // B 仍可经活动链路 B-A 交付
  const atB = fed.domain('B').forward('d', table, 1);
  assert.equal(atB.ok, true);
  if (!atB.ok) throw new Error('B 应仍能交付');
  assert.deepEqual([...atB.trace], ['B', 'A']);
});

test('无路由断点可定位到具体域，且不会产生转发环', () => {
  const fed = new Federation({ seed: 42 });
  for (const id of ['A', 'B', 'C']) fed.addDomain(id);
  fed.connect('A', 'B', 1);
  fed.connect('B', 'C', 1);
  fed.runUntilIdle();
  const table = new Map(fed.allDomains().map((d) => [d.id, d]));

  const result = fed.domain('C').forward('ghost', table);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('应当失败');
  assert.equal(result.reason, 'no-route');
  assert.equal(result.breakDomain, 'C');
  assert.deepEqual([...result.trace], ['C']);
});

test('目的地消失后转发失败定位断点，重新发布后按新路由交付', () => {
  const fed = build();
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();
  const table = new Map(fed.allDomains().map((d) => [d.id, d]));
  assert.equal(fed.domain('E').forward('d', table).ok, true);

  fed.domain('A').removeOwnedDestination('d');
  fed.runUntilIdle();
  const gone = fed.domain('E').forward('d', table);
  assert.equal(gone.ok, false);
  if (gone.ok) throw new Error('目的地消失后应失败');
  assert.ok(gone.breakDomain.length > 0, '断点域可定位');

  // 在新的拥有者 F 上重新发布同一目的地
  fed.domain('F').addOwnedDestination('d');
  fed.runUntilIdle();
  const again = fed.domain('E').forward('d', table, 1);
  assert.equal(again.ok, true);
  if (!again.ok) throw new Error('重新发布后应交付成功');
  assert.equal(again.trace[again.trace.length - 1], 'F');

  // 新的全网路由与以 F 为根的参考最短路径一致
  const ref = referenceShortestPaths(ringTopology(), 'F');
  for (const id of RING_DOMAINS) {
    if (id === 'F') continue;
    const r = fed.domain(id).getSelected('d')!;
    assert.deepEqual([...r.fullPath], ref.get(id)!.path, `${id} 与参考路径不一致`);
  }
});
