import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Federation } from '../src/federation.ts';
import type { Announcement, SessionEnvelope, Withdrawal } from '../src/types.ts';

test('较新来源代次生效后，旧代次公告/撤销一律拒绝', () => {
  const fed = new Federation({ seed: 21 });
  fed.addDomain('A');
  fed.addDomain('B');
  fed.connect('A', 'B', 1);
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();
  assert.ok(fed.domain('B').getSelected('d'));

  // A 重启：代次 +1，重新收敛
  const oldGen = fed.domain('A').currentGen();
  fed.restartDomain('A');
  fed.runUntilIdle();
  const newGen = fed.domain('A').currentGen();
  assert.equal(newGen, oldGen + 1);
  assert.ok(fed.domain('B').getSelected('d'));
  assert.equal(fed.domain('B').getSelected('d')!.source.gen, newGen);

  // 注入旧代次迟到公告：必须被拒绝，不能恢复旧路径
  const sessionB = fed.domain('B').getNeighbor('A')!;
  const staleAnn: Announcement = {
    kind: 'announce',
    destination: 'd',
    source: { stableId: 'A', gen: oldGen },
    path: ['A'],
    cost: 0,
    version: 999, // 版本再新也不能越过代次闸门
  };
  const acceptedBefore = fed.trace.byType('announce-accepted').length;
  fed.domain('B').receive('A', { sessionGen: sessionB.peerSessionGen, payload: staleAnn });
  const rejects = fed.trace
    .byType('announce-rejected')
    .filter((e) => e.reason === 'stale-source-generation');
  assert.ok(rejects.length >= 1);
  assert.equal(fed.trace.byType('announce-accepted').length, acceptedBefore);
  assert.equal(fed.domain('B').getSelected('d')!.source.gen, newGen);

  // 旧代次撤销同样被拒绝，且不能误删当前路由
  const staleWd: Withdrawal = {
    kind: 'withdraw',
    destination: 'd',
    source: { stableId: 'A', gen: oldGen },
    version: 1000,
  };
  fed.domain('B').receive('A', { sessionGen: sessionB.peerSessionGen, payload: staleWd });
  assert.ok(
    fed.trace.byType('withdraw-rejected').some((e) => e.reason === 'stale-source-generation'),
  );
  assert.ok(fed.domain('B').getSelected('d'));
});

test('公告版本流阻止重复与旧版本消息（幂等）', () => {
  const fed = new Federation({ seed: 22 });
  fed.addDomain('A');
  fed.addDomain('B');
  fed.connect('A', 'B', 1);
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();

  const sessionB = fed.domain('B').getNeighbor('A')!;
  const gen = fed.domain('A').currentGen();
  const currentVersion = fed.domain('B').getSelected('d')!.version;

  const dup: Announcement = {
    kind: 'announce',
    destination: 'd',
    source: { stableId: 'A', gen },
    path: ['A'],
    cost: 0,
    version: currentVersion, // 重复版本
  };
  const before = fed.domain('B').ribCandidates().length;
  fed.domain('B').receive('A', { sessionGen: sessionB.peerSessionGen, payload: dup });
  assert.ok(
    fed.trace.byType('announce-rejected').some((e) => e.reason === 'duplicate-version'),
  );
  assert.equal(fed.domain('B').ribCandidates().length, before);

  // 更旧版本也被拒绝
  const older: Announcement = { ...dup, version: currentVersion - 1 };
  fed.domain('B').receive('A', { sessionGen: sessionB.peerSessionGen, payload: older });
  assert.equal(fed.domain('B').ribCandidates().length, before);
});

test('会话代次阻止已死会话上的迟到消息恢复撤回路径', () => {
  const fed = new Federation({ seed: 23 });
  fed.addDomain('A');
  fed.addDomain('B');
  fed.addDomain('C');
  fed.connect('A', 'B', 1);
  fed.connect('B', 'C', 1);
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();
  assert.ok(fed.domain('C').getSelected('d'));

  // 捕获 B->C 会话重建前的旧会话代次
  const deadPeerGen = fed.domain('C').getNeighbor('B')!.peerSessionGen;

  // 断开 A-B 并让 B 与 C 重建会话（会话代次前进）
  fed.bringDown('A', 'B');
  fed.runUntilIdle();
  assert.equal(fed.domain('B').getSelected('d'), null);
  fed.bringUp('B', 'C');
  fed.runUntilIdle();
  const livePeerGen = fed.domain('C').getNeighbor('B')!.peerSessionGen;
  assert.notEqual(deadPeerGen, livePeerGen);

  // 旧会话信封携带一条仍然有效的公告迟到：必须被会话代次闸门拒绝
  const ghost: SessionEnvelope = {
    sessionGen: deadPeerGen,
    payload: {
      kind: 'announce',
      destination: 'd',
      source: { stableId: 'A', gen: 1 },
      path: ['A', 'B'],
      cost: 1,
      version: 1,
    },
  };
  fed.domain('C').receive('B', ghost);
  assert.ok(
    fed.trace.byType('announce-rejected').some((e) => e.reason === 'stale-session-generation'),
  );
  assert.equal(fed.domain('C').getSelected('d'), null, '迟到消息不得恢复已撤回路径');
});

test('来源重启后重新收敛，邻居学到的代次与全网一致', () => {
  const fed = new Federation({ seed: 24 });
  fed.addDomain('A');
  fed.addDomain('B');
  fed.addDomain('C');
  fed.connect('A', 'B', 1);
  fed.connect('B', 'C', 1);
  fed.domain('A').addOwnedDestination('d');
  fed.runUntilIdle();

  fed.restartDomain('A');
  fed.runUntilIdle();
  const gen = fed.domain('A').currentGen();
  for (const id of ['B', 'C'] as const) {
    const r = fed.domain(id).getSelected('d');
    assert.ok(r, `${id} 重启后应重新学到路由`);
    assert.equal(r!.source.gen, gen);
    assert.equal(r!.source.stableId, 'A');
  }
  // 完整路径保持无环
  const path = fed.domain('C').getSelected('d')!.fullPath;
  assert.equal(new Set(path).size, path.length);
  assert.deepEqual([...path], ['A', 'B', 'C']);
});
