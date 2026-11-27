import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHealthRouter,
  type Credential,
  type Outcome,
} from '../src/index.ts';

/**
 * 一次跨地域选路过程，交错：
 * - 滑动窗口淘汰（d 的样本滑出窗口、评分归零）
 * - 隔离上限触顶（c、d 保持待隔离）
 * - 取消探测归还名额并补充（a 第 1 轮实际发放 3 个探测）
 * - 旧成功回报只进诊断（b、c 旧轮次探测的迟到成功）
 * 全程观察候选集合、阶段变更与每轮实际探测数量。
 */
test('跨地域选路：滑动窗口淘汰、隔离上限、取消探测与旧成功回报交错', () => {
  let now = 0;
  const router = createHealthRouter({
    clock: () => now,
    policy: {
      windowMs: 300,
      consecutiveFailureThreshold: 2,
      maxIsolations: 2,
      baseIsolationMs: 200,
      isolationBackoffFactor: 2,
      maxIsolationMs: 1000,
      probe: { concurrency: 2, successThreshold: 2, roundMs: 100 },
    },
    services: {
      svc: {
        regionPriority: ['east', 'west'],
        nodes: [
          { id: 'a', region: 'east', generation: 1 },
          { id: 'b', region: 'east', generation: 1 },
          { id: 'c', region: 'west', generation: 1 },
          { id: 'd', region: 'west', generation: 1 },
        ],
      },
    },
  });

  const at = (t: number) => {
    now = t;
  };
  const candidates = () => router.inspect('svc').candidates;
  const nodeView = (id: string) => {
    const n = router.inspect('svc').nodes.find((x) => x.id === id);
    assert.ok(n, `node ${id} missing`);
    return n;
  };
  const attempt = (outcome: Outcome): Credential => {
    const r = router.acquire('svc');
    if (r.status !== 'ok') assert.fail(`expected credential, got ${r.status}`);
    router.report(r.credential, outcome);
    return r.credential;
  };
  const probe = (): Credential => {
    const r = router.acquireProbe('svc');
    if (r.status !== 'ok') assert.fail('expected probe slot');
    return r.credential;
  };
  const events = (type: string, nodeId?: string) =>
    router.events().filter((e) => e.type === type && (nodeId === undefined || e.nodeId === nodeId));

  // ---- t=0：健康候选按地域优先级（east 优先）+ 节点ID ----
  assert.deepEqual(candidates(), ['a', 'b', 'c', 'd']);

  // a 连续两次远端错误 → 隔离（第 1 轮，至 t=200）
  at(0);
  attempt('remote-error');
  attempt('remote-error');
  assert.equal(nodeView('a').state, 'isolated');
  assert.deepEqual(
    events('isolated', 'a').map((e) => [e.round, e.until, e.reason]),
    [[1, 200, 'threshold']],
  );

  // b 同样进入隔离，隔离名额（2）占满
  attempt('remote-error');
  attempt('remote-error');
  assert.equal(nodeView('b').state, 'isolated');
  assert.equal(router.inspect('svc').isolatedCount, 2);
  // 跨地域故障转移：候选只剩 west
  assert.deepEqual(candidates(), ['c', 'd']);

  // ---- t=10：c 达到阈值，但隔离名额已满 → 保持待隔离 ----
  at(10);
  attempt('remote-error');
  attempt('remote-error');
  assert.equal(nodeView('c').state, 'pending');
  assert.deepEqual(candidates(), ['d']);

  // ---- t=20..40：d 一次成功（重置连续计数）后连续两次失败 → 待隔离 ----
  at(20);
  attempt('success');
  at(30);
  attempt('remote-error');
  at(40);
  attempt('remote-error');
  assert.equal(nodeView('d').state, 'pending');

  // ---- t=50：失去有效候选 → 暂不可用；显式降级才选待隔离节点 ----
  at(50);
  assert.deepEqual(candidates(), []);
  assert.equal(router.acquire('svc').status, 'unavailable');
  // 降级选择：d 评分 2/3 < c 评分 1.0 → 稳定选 d
  const degraded = router.acquire('svc', { allowDegraded: true });
  if (degraded.status !== 'ok') assert.fail('expected degraded credential');
  assert.equal(degraded.credential.nodeId, 'd');
  assert.equal(degraded.credential.degraded, true);
  // 调用方取消单独记账，不进滑动窗口
  router.report(degraded.credential, 'cancelled');
  assert.equal(nodeView('d').cancels, 1);
  assert.equal(nodeView('d').validSamples, 3);

  // ---- t=200：a、b 隔离到期 → 各自进入第 1 轮探测（截止 300）----
  at(200);
  router.tick();
  assert.equal(nodeView('a').state, 'probing');
  assert.equal(nodeView('b').state, 'probing');
  assert.deepEqual(
    events('probe-round-started', 'a').map((e) => [e.round, e.deadline]),
    [[1, 300]],
  );

  // ---- t=210：每轮最多并发 2 个探测，按节点ID顺序发放 ----
  at(210);
  const pa1 = probe();
  const pa2 = probe();
  assert.equal(pa1.nodeId, 'a');
  assert.equal(pa2.nodeId, 'a');
  const pb1 = probe();
  const pb2 = probe();
  assert.equal(pb1.nodeId, 'b');
  assert.equal(pb2.nodeId, 'b');
  assert.equal(router.acquireProbe('svc').status, 'none'); // 两轮并发均已满

  // ---- t=220：取消的探测归还名额，可补充新探测 ----
  at(220);
  router.report(pa2, 'cancelled');
  assert.equal(events('probe-slot-returned', 'a').length, 1);
  const pa3 = probe();
  assert.equal(pa3.nodeId, 'a');
  assert.equal(router.acquireProbe('svc').status, 'none');
  // a 第 1 轮实际发放 3 个探测（含取消后补充）
  assert.equal(events('probe-issued', 'a').filter((e) => e.round === 1).length, 3);

  // ---- t=230：a 累计 2 个有效成功 → 恢复；名额按错误率补入 c（1.0 > d 的 2/3）----
  at(230);
  router.report(pa1, 'success');
  assert.equal(nodeView('a').state, 'probing'); // 1 个成功还不够
  router.report(pa3, 'success');
  assert.equal(nodeView('a').state, 'healthy');
  assert.equal(nodeView('a').phase, 3); // healthy → isolated → probing → healthy
  assert.equal(nodeView('c').state, 'isolated');
  assert.deepEqual(
    events('isolated', 'c').map((e) => [e.round, e.until, e.reason]),
    [[1, 430, 'filled-from-pending']],
  );
  assert.equal(nodeView('d').state, 'pending'); // 名额只有一个，d 继续等待
  assert.deepEqual(candidates(), ['a']);

  // b 第 1 轮探测出现远端失败 → 立即重新隔离（第 2 轮，退避 400ms 至 630）
  router.report(pb1, 'remote-error');
  assert.equal(nodeView('b').state, 'isolated');
  assert.deepEqual(
    events('re-isolated', 'b').map((e) => [e.round, e.until, e.reason]),
    [[2, 630, 'probe-failure']],
  );

  // ---- t=240：b 旧轮次在途探测的迟到成功只进诊断，不能关闭新的隔离轮次 ----
  at(240);
  router.report(pb2, 'success');
  assert.equal(nodeView('b').state, 'isolated');
  assert.deepEqual(
    router.diagnostics().map((d) => [d.nodeId, d.outcome, d.reason]),
    [['b', 'success', 'stale-phase']],
  );

  // ---- t=350：滑动窗口淘汰 —— d 的样本（t=20/30/40）全部滑出，评分归零 ----
  at(350);
  const d350 = nodeView('d');
  assert.equal(d350.validSamples, 0);
  assert.equal(d350.remoteErrors, 0);
  assert.equal(d350.score, 0);
  // 待隔离状态由连续失败计数维持，不因窗口淘汰而消失
  assert.equal(d350.state, 'pending');
  assert.equal(d350.consecutiveFailures, 2);

  // ---- t=430：c 隔离到期 → 第 1 轮探测（截止 530）----
  at(430);
  router.tick();
  assert.equal(nodeView('c').state, 'probing');
  at(440);
  const pc1 = probe();
  const pc2 = probe();
  assert.equal(pc1.nodeId, 'c');
  assert.equal(pc2.nodeId, 'c');
  at(450);
  router.report(pc1, 'success'); // 1/2，尚未恢复

  // ---- t=535：本轮截止（530）到达仍未凑够成功 → 重新隔离（第 2 轮，至 935）----
  at(535);
  router.tick();
  assert.equal(nodeView('c').state, 'isolated');
  assert.deepEqual(
    events('re-isolated', 'c').map((e) => [e.round, e.until, e.reason]),
    [[2, 935, 'probe-deadline']],
  );

  // c 旧轮次在途探测的迟到成功同样只进诊断
  at(540);
  router.report(pc2, 'success');
  assert.equal(nodeView('c').state, 'isolated');
  assert.equal(router.diagnostics().length, 2);

  // ---- t=630：b 第 2 轮探测开始；t=650 累计足够成功 → 恢复，名额补入 d ----
  at(630);
  router.tick();
  assert.equal(nodeView('b').state, 'probing');
  assert.deepEqual(
    events('probe-round-started', 'b').map((e) => [e.round, e.deadline]),
    [
      [1, 300],
      [2, 730],
    ],
  );
  at(640);
  const pb3 = probe();
  const pb4 = probe();
  at(650);
  router.report(pb3, 'success');
  router.report(pb4, 'success');
  assert.equal(nodeView('b').state, 'healthy');
  assert.equal(nodeView('d').state, 'isolated');
  assert.deepEqual(
    events('isolated', 'd').map((e) => [e.round, e.until, e.reason]),
    [[1, 850, 'filled-from-pending']],
  );

  // ---- 最终：健康候选按地域优先级为 [a, b]，c、d 在隔离中 ----
  assert.deepEqual(candidates(), ['a', 'b']);
  const finalAcquire = router.acquire('svc');
  if (finalAcquire.status !== 'ok') assert.fail('expected credential');
  assert.equal(finalAcquire.credential.nodeId, 'a');
  const finalSnap = router.inspect('svc');
  assert.equal(finalSnap.isolatedCount, 2);
  assert.deepEqual(finalSnap.degraded, []);

  // ---- 每轮实际探测数量：a/1=3（含取消后补充），b/1=2，b/2=2，c/1=2 ----
  const perRound = new Map<string, number>();
  for (const e of router.events()) {
    if (e.type !== 'probe-issued') continue;
    const key = `${e.nodeId}#${e.round}`;
    perRound.set(key, (perRound.get(key) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(perRound), {
    'a#1': 3,
    'b#1': 2,
    'b#2': 2,
    'c#1': 2,
  });

  // ---- 阶段变更轨迹 ----
  assert.equal(nodeView('a').phase, 3); // isolated → probing → healthy
  assert.equal(nodeView('b').phase, 5); // isolated → probing → re-isolated → probing → healthy
  assert.equal(nodeView('c').phase, 4); // pending → isolated → probing → re-isolated
  assert.equal(nodeView('d').phase, 2); // pending → isolated
});
