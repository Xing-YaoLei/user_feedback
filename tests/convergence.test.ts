import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Federation } from '../src/federation.ts';
import { referenceShortestPaths } from '../src/reference.ts';
import { RING_DOMAINS, RING_EDGES, ringTopology } from './helpers.ts';

/** 收敛后：每个域对每个可达目的地的选定路由必须匹配全图参考最短路径 */
function assertConvergedToReference(fed: Federation, destination: string, owner: string): void {
  const topo = ringTopology();
  const refFromOwner = referenceShortestPaths(topo, owner);
  for (const id of RING_DOMAINS) {
    const router = fed.domain(id);
    if (id === owner) {
      const local = router.getSelected(destination);
      assert.ok(local && local.local, `${id} 应持有本地始发路由`);
      continue;
    }
    const route = router.getSelected(destination);
    const ref = refFromOwner.get(id);
    assert.ok(ref, `参考图中 ${id} 应可达 ${owner}`);
    assert.ok(route, `${id} 应收敛到 ${destination} 的路由`);
    // fullPath 与参考路径同为 owner -> ... -> id 方向
    const expectedFullPath = ref.path;
    assert.deepEqual([...route!.fullPath], expectedFullPath, `${id} 路径不匹配参考最短路径`);
    assert.equal(route!.totalCost, ref.cost, `${id} 代价不匹配`);
    assert.equal(route!.hops, ref.hops, `${id} 跳数不匹配`);
  }
}

test('环形拓扑收敛：全部域与全图参考最短路径一致（含零代价边）', () => {
  const fed = new Federation({ seed: 11 });
  for (const id of RING_DOMAINS) fed.addDomain(id);
  for (const e of RING_EDGES) fed.connect(e.a, e.b, e.cost);
  fed.domain('A').addOwnedDestination('dest-1');
  fed.runUntilIdle();

  assertConvergedToReference(fed, 'dest-1', 'A');

  // 零代价边存在时 B 的路由代价应为 0
  assert.equal(fed.domain('B').getSelected('dest-1')!.totalCost, 0);
  // E 经 D 到达 A：参考最短
  const refE = referenceShortestPaths(ringTopology(), 'A').get('E')!;
  assert.deepEqual(
    [...fed.domain('E').getSelected('dest-1')!.fullPath],
    refE.path,
  );
});

test('链路代价变化触发增量重选并重新公告，收敛到新参考', () => {
  const fed = new Federation({ seed: 12 });
  for (const id of RING_DOMAINS) fed.addDomain(id);
  for (const e of RING_EDGES) fed.connect(e.a, e.b, e.cost);
  fed.domain('A').addOwnedDestination('dest-1');
  fed.runUntilIdle();

  const before = fed.domain('B').getSelected('dest-1')!.fullPath.join('->');
  // 抬高 A-B 零代价边，迫使 B 改走环另一侧 B-C-F-A
  fed.setLinkCost('A', 'B', 50);
  fed.runUntilIdle();

  const changedTopo = {
    nodes: [...RING_DOMAINS],
    edges: RING_EDGES.map((e) =>
      (e.a === 'A' && e.b === 'B') || (e.a === 'B' && e.b === 'A') ? { ...e, cost: 50 } : e,
    ),
  };
  const ref = referenceShortestPaths(changedTopo, 'A');
  for (const id of RING_DOMAINS) {
    if (id === 'A') continue;
    const route = fed.domain(id).getSelected('dest-1')!;
    assert.deepEqual([...route.fullPath], ref.get(id)!.path, `${id} 未按新代价重选`);
  }
  const after = fed.domain('B').getSelected('dest-1')!.fullPath.join('->');
  assert.notEqual(before, after, 'B 的路径应发生增量切换');
  assert.equal(after, 'A->F->C->B');
});

test('等价路径由域 ID 序列字典序唯一决胜，结果稳定', () => {
  // 小型菱形拓扑：S -> X 存在两条严格等价路径
  const fed = new Federation({ seed: 13 });
  for (const id of ['S', 'L', 'R', 'X']) fed.addDomain(id);
  fed.connect('S', 'L', 1);
  fed.connect('S', 'R', 1);
  fed.connect('L', 'X', 1);
  fed.connect('R', 'X', 1);
  fed.domain('X').addOwnedDestination('d');
  fed.runUntilIdle();

  const route = fed.domain('S').getSelected('d')!;
  // 两条路径 X-L-S 与 X-R-S 代价/跳数相同，字典序 L < R
  assert.deepEqual([...route.fullPath], ['X', 'L', 'S']);
  // 再跑一次独立仿真，结果必须一致（确定性）
  const fed2 = new Federation({ seed: 999 });
  for (const id of ['S', 'L', 'R', 'X']) fed2.addDomain(id);
  fed2.connect('S', 'L', 1);
  fed2.connect('S', 'R', 1);
  fed2.connect('L', 'X', 1);
  fed2.connect('R', 'X', 1);
  fed2.domain('X').addOwnedDestination('d');
  fed2.runUntilIdle();
  assert.deepEqual([...fed2.domain('S').getSelected('d')!.fullPath], ['X', 'L', 'S']);
});

test('邻居撤销：会话断开后沿邻居链逐步撤回，全网最终无该目的地路由', () => {
  const fed = new Federation({ seed: 14 });
  for (const id of RING_DOMAINS) fed.addDomain(id);
  for (const e of RING_EDGES) fed.connect(e.a, e.b, e.cost);
  fed.domain('A').addOwnedDestination('dest-1');
  fed.runUntilIdle();
  assert.ok(fed.domain('E').getSelected('dest-1'));

  // A 与所有邻居断开：等价于来源域不可达，撤销应逐跳传播
  fed.bringDown('A', 'B');
  fed.bringDown('A', 'F');
  fed.runUntilIdle();

  for (const id of RING_DOMAINS) {
    if (id === 'A') continue;
    assert.equal(fed.domain(id).getSelected('dest-1'), null, `${id} 应已撤销 dest-1`);
  }
  // 撤销传播轨迹覆盖完整环上的域
  const seq = fed.trace.withdrawPropagationSequence('dest-1');
  assert.ok(seq.includes('B') && seq.includes('C') && seq.includes('F'));
});
