import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHealthRouter,
  type Credential,
  type HealthRouter,
  type NodeSpec,
  type ProbePolicy,
  type RouterPolicy,
} from '../src/index.ts';

const BASE_POLICY: RouterPolicy = {
  windowMs: 1000,
  consecutiveFailureThreshold: 2,
  maxIsolations: 2,
  baseIsolationMs: 100,
  isolationBackoffFactor: 2,
  maxIsolationMs: 10_000,
  probe: { concurrency: 2, successThreshold: 2, roundMs: 50 },
};

const A: NodeSpec = { id: 'a', region: 'east', generation: 1 };
const B: NodeSpec = { id: 'b', region: 'east', generation: 1 };
const C: NodeSpec = { id: 'c', region: 'west', generation: 1 };

type PolicyOverrides = Partial<Omit<RouterPolicy, 'probe'>> & { probe?: Partial<ProbePolicy> };

function setup(
  overrides: PolicyOverrides = {},
  nodes: NodeSpec[] = [A, B, C],
  regionPriority = ['east', 'west'],
) {
  let now = 0;
  const policy: RouterPolicy = {
    ...BASE_POLICY,
    ...overrides,
    probe: { ...BASE_POLICY.probe, ...(overrides.probe ?? {}) },
  };
  const router = createHealthRouter({
    clock: () => now,
    policy,
    services: { svc: { regionPriority, nodes } },
  });
  return {
    router,
    setNow(t: number) {
      now = t;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

type Ctx = ReturnType<typeof setup>;

function acquireOk(router: HealthRouter, opts?: { allowDegraded?: boolean }): Credential {
  const r = router.acquire('svc', opts);
  if (r.status !== 'ok') assert.fail(`expected credential, got ${r.status}`);
  return r.credential;
}

function probeOk(router: HealthRouter): Credential {
  const r = router.acquireProbe('svc');
  if (r.status !== 'ok') assert.fail('expected probe slot');
  return r.credential;
}

function view(router: HealthRouter, id: string) {
  const n = router.inspect('svc').nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} missing`);
  return n;
}

/** 让指定节点连续失败进入隔离，再推进到隔离结束进入探测态 */
function toProbing(ctx: Ctx, nodeId: string): void {
  for (let i = 0; i < BASE_POLICY.consecutiveFailureThreshold; i++) {
    const cred = acquireOk(ctx.router);
    assert.equal(cred.nodeId, nodeId);
    ctx.router.report(cred, 'remote-error');
  }
  ctx.advance(BASE_POLICY.baseIsolationMs);
  ctx.router.tick();
  assert.equal(view(ctx.router, nodeId).state, 'probing');
}

test('健康候选按地域优先级和节点ID选路', () => {
  const { router } = setup({}, [
    { id: 'b', region: 'east', generation: 1 },
    { id: 'a', region: 'east', generation: 1 },
    { id: 'c', region: 'west', generation: 1 },
    { id: 'z', region: 'south', generation: 1 }, // 未列入优先级 → 排最后
  ]);
  assert.deepEqual(router.inspect('svc').candidates, ['a', 'b', 'c', 'z']);
  assert.equal(acquireOk(router).nodeId, 'a');
});

test('失去有效候选时返回暂不可用，隔离中的节点不参与降级', () => {
  const { router } = setup({ maxIsolations: 5 });
  for (const id of ['a', 'b', 'c']) {
    for (let i = 0; i < 2; i++) router.report(acquireOk(router), 'remote-error');
    assert.equal(view(router, id).state, 'isolated');
  }
  assert.equal(router.acquire('svc').status, 'unavailable');
  assert.equal(router.acquire('svc', { allowDegraded: true }).status, 'unavailable');
  assert.equal(router.acquireProbe('svc').status, 'none');
});

test('只有明确允许降级时才选择待隔离节点，按失败评分和节点ID稳定排序', () => {
  // maxIsolations = 0 → 达到阈值的节点全部保持待隔离
  const { router } = setup({ maxIsolations: 0 }, [A, B]);
  // a：2/2 失败 → 评分 1.0
  router.report(acquireOk(router), 'remote-error');
  router.report(acquireOk(router), 'remote-error');
  // b：1 成功 + 2 失败 → 评分 2/3
  router.report(acquireOk(router), 'success');
  router.report(acquireOk(router), 'remote-error');
  router.report(acquireOk(router), 'remote-error');
  assert.equal(view(router, 'a').state, 'pending');
  assert.equal(view(router, 'b').state, 'pending');
  // 普通选路避开待隔离节点
  assert.equal(router.acquire('svc').status, 'unavailable');
  // 降级时选评分更低（较不糟）的 b
  const degraded = acquireOk(router, { allowDegraded: true });
  assert.equal(degraded.nodeId, 'b');
  assert.equal(degraded.degraded, true);

  // 评分相同按节点ID 小→大
  const tie = setup({ maxIsolations: 0 }, [A, B]);
  for (let i = 0; i < 2; i++) {
    tie.router.report(acquireOk(tie.router), 'remote-error'); // a
  }
  for (let i = 0; i < 2; i++) {
    tie.router.report(acquireOk(tie.router), 'remote-error'); // b
  }
  assert.equal(acquireOk(tie.router, { allowDegraded: true }).nodeId, 'a');
});

test('滑动窗口按完成时刻淘汰，远端错误占有效样本比例评分，取消与本地超时单独记账', () => {
  const ctx = setup({ consecutiveFailureThreshold: 99 });
  const { router } = ctx;
  ctx.setNow(0);
  router.report(acquireOk(router), 'success');
  ctx.setNow(100);
  router.report(acquireOk(router), 'remote-error');
  ctx.setNow(200);
  router.report(acquireOk(router), 'remote-error');
  let snap = view(router, 'a');
  assert.equal(snap.validSamples, 3);
  assert.equal(snap.remoteErrors, 2);
  assert.ok(Math.abs(snap.score - 2 / 3) < 1e-9);

  // 调用方取消与本地排队超时单独计数，不进入滑动窗口
  router.report(acquireOk(router), 'cancelled');
  router.report(acquireOk(router), 'local-timeout');
  snap = view(router, 'a');
  assert.equal(snap.validSamples, 3);
  assert.equal(snap.cancels, 1);
  assert.equal(snap.localTimeouts, 1);

  // 窗口 1000ms：t=1101 时只剩 t=200 的样本
  ctx.setNow(1101);
  snap = view(router, 'a');
  assert.equal(snap.validSamples, 1);
  assert.equal(snap.score, 1);
  // t=1201 时全部淘汰
  ctx.setNow(1201);
  snap = view(router, 'a');
  assert.equal(snap.validSamples, 0);
  assert.equal(snap.score, 0);
});

test('连续远端失败达到阈值进入隔离，成功会重置连续计数', () => {
  const { router } = setup();
  router.report(acquireOk(router), 'remote-error'); // 连续 1
  router.report(acquireOk(router), 'success'); // 重置
  router.report(acquireOk(router), 'remote-error'); // 连续 1
  assert.equal(view(router, 'a').state, 'healthy');
  router.report(acquireOk(router), 'remote-error'); // 连续 2 → 隔离
  const a = view(router, 'a');
  assert.equal(a.state, 'isolated');
  assert.deepEqual(a.isolation, { round: 1, until: 100 });
  assert.deepEqual(router.inspect('svc').candidates, ['b', 'c']);
});

test('隔离数量上限触顶后其余异常节点保持待隔离', () => {
  const { router } = setup({ maxIsolations: 1 }, [A, B]);
  router.report(acquireOk(router), 'remote-error');
  router.report(acquireOk(router), 'remote-error'); // a → 隔离（占满名额）
  assert.equal(view(router, 'a').state, 'isolated');
  router.report(acquireOk(router), 'remote-error');
  router.report(acquireOk(router), 'remote-error'); // b → 待隔离
  assert.equal(view(router, 'b').state, 'pending');
  assert.equal(router.inspect('svc').isolatedCount, 1);
  assert.deepEqual(router.inspect('svc').candidates, []);
});

test('隔离名额释放后按错误率从高到低补入，平分按节点ID从小到大', () => {
  // 错误率排序：c(1.0) 优先于 b(2/3)
  const ctx = setup({ maxIsolations: 1 });
  const { router } = ctx;
  router.report(acquireOk(router), 'remote-error');
  router.report(acquireOk(router), 'remote-error'); // a → 隔离
  router.report(acquireOk(router), 'success');
  router.report(acquireOk(router), 'remote-error');
  router.report(acquireOk(router), 'remote-error'); // b → 待隔离，评分 2/3
  router.report(acquireOk(router), 'remote-error');
  router.report(acquireOk(router), 'remote-error'); // c → 待隔离，评分 1.0
  assert.equal(view(router, 'b').state, 'pending');
  assert.equal(view(router, 'c').state, 'pending');
  // a 隔离到期 → 探测 → 恢复 → 名额释放 → 补入错误率更高的 c
  ctx.advance(100);
  router.tick();
  router.report(probeOk(router), 'success');
  router.report(probeOk(router), 'success');
  assert.equal(view(router, 'a').state, 'healthy');
  assert.equal(view(router, 'c').state, 'isolated');
  assert.equal(view(router, 'b').state, 'pending');

  // 平分：b、c 同为 1.0 → 补入 id 更小的 b
  const tie = setup({ maxIsolations: 1 });
  tie.router.report(acquireOk(tie.router), 'remote-error');
  tie.router.report(acquireOk(tie.router), 'remote-error'); // a → 隔离
  for (let i = 0; i < 2; i++) tie.router.report(acquireOk(tie.router), 'remote-error'); // b → 待隔离
  for (let i = 0; i < 2; i++) tie.router.report(acquireOk(tie.router), 'remote-error'); // c → 待隔离
  tie.advance(100);
  tie.router.tick();
  tie.router.report(probeOk(tie.router), 'success');
  tie.router.report(probeOk(tie.router), 'success');
  assert.equal(view(tie.router, 'b').state, 'isolated');
  assert.equal(view(tie.router, 'c').state, 'pending');
});

test('隔离期按连续失败轮次退避并封顶', () => {
  const ctx = setup(
    {
      consecutiveFailureThreshold: 1,
      baseIsolationMs: 100,
      isolationBackoffFactor: 2,
      maxIsolationMs: 250,
      probe: { concurrency: 1, successThreshold: 1, roundMs: 50 },
    },
    [A],
  );
  const { router } = ctx;
  router.report(acquireOk(router), 'remote-error'); // 第 1 轮隔离 → 100ms
  assert.deepEqual(view(router, 'a').isolation, { round: 1, until: 100 });
  ctx.advance(100);
  router.tick();
  router.report(probeOk(router), 'remote-error'); // 第 2 轮 → 200ms
  assert.deepEqual(view(router, 'a').isolation, { round: 2, until: 300 });
  ctx.setNow(300);
  router.tick();
  router.report(probeOk(router), 'remote-error'); // 第 3 轮 → 400ms 封顶 250ms
  assert.deepEqual(view(router, 'a').isolation, { round: 3, until: 550 });
});

test('探测轮限制并发，取消的探测归还名额以便补充，累计足够有效成功才恢复', () => {
  const ctx = setup({}, [A]);
  toProbing(ctx, 'a');
  const p1 = probeOk(ctx.router);
  const p2 = probeOk(ctx.router);
  assert.equal(ctx.router.acquireProbe('svc').status, 'none'); // 并发已满
  // 取消 → 归还名额 → 可补充
  ctx.router.report(p1, 'cancelled');
  const p3 = probeOk(ctx.router);
  assert.equal(ctx.router.acquireProbe('svc').status, 'none');
  const probe = view(ctx.router, 'a').probe;
  assert.ok(probe);
  assert.equal(probe.issued, 3); // 本轮实际发放 3 个
  assert.equal(probe.inFlight, 2);
  // 取消不算有效成功：还需 2 个成功
  ctx.router.report(p2, 'success');
  assert.equal(view(ctx.router, 'a').state, 'probing');
  ctx.router.report(p3, 'success');
  assert.equal(view(ctx.router, 'a').state, 'healthy');
  // 恢复后隔离轮次重置：再次失败按第 1 轮退避
  ctx.router.report(acquireOk(ctx.router), 'remote-error');
  ctx.router.report(acquireOk(ctx.router), 'remote-error');
  assert.deepEqual(view(ctx.router, 'a').isolation, { round: 1, until: 200 });
});

test('探测任一远端失败立即重新隔离，旧轮次迟到成功只进诊断', () => {
  const ctx = setup({}, [A, B]);
  toProbing(ctx, 'a'); // now = 100
  const p1 = probeOk(ctx.router);
  const p2 = probeOk(ctx.router);
  ctx.router.report(p1, 'remote-error');
  const a = view(ctx.router, 'a');
  assert.equal(a.state, 'isolated');
  assert.deepEqual(a.isolation, { round: 2, until: 300 });
  // 旧轮次在途探测的迟到成功不能关闭新的隔离轮次
  ctx.router.report(p2, 'success');
  assert.equal(view(ctx.router, 'a').state, 'isolated');
  assert.equal(ctx.router.diagnostics().length, 1);
  assert.equal(ctx.router.diagnostics()[0].reason, 'stale-phase');
  assert.equal(ctx.router.diagnostics()[0].outcome, 'success');
});

test('探测本轮截止时间到达即重新隔离', () => {
  const ctx = setup({}, [A]);
  toProbing(ctx, 'a'); // 截止 150
  ctx.router.report(probeOk(ctx.router), 'success'); // 1/2，不够恢复
  ctx.setNow(150);
  ctx.router.tick();
  const a = view(ctx.router, 'a');
  assert.equal(a.state, 'isolated');
  assert.deepEqual(a.isolation, { round: 2, until: 350 });
  const events = ctx.router.events().filter((e) => e.type === 're-isolated');
  assert.equal(events[0].reason, 'probe-deadline');
});

test('旧阶段的迟到结果不能占用新一轮探测名额', () => {
  const ctx = setup({}, [A]);
  toProbing(ctx, 'a'); // 第 1 轮探测，now = 100
  const p1 = probeOk(ctx.router);
  const p2 = probeOk(ctx.router);
  ctx.router.report(p1, 'remote-error'); // 重新隔离至 300
  ctx.setNow(300);
  ctx.router.tick(); // 第 2 轮探测开始
  assert.equal(view(ctx.router, 'a').probe?.round, 2);
  // 旧轮次 p2 的迟到取消只进诊断，不影响新一轮名额
  ctx.router.report(p2, 'cancelled');
  assert.equal(ctx.router.diagnostics()[0].reason, 'stale-phase');
  assert.equal(view(ctx.router, 'a').probe?.inFlight, 0);
  probeOk(ctx.router);
  probeOk(ctx.router);
  assert.equal(ctx.router.acquireProbe('svc').status, 'none'); // 恰好 2 个名额
});

test('旧代次节点的迟到结果只进入诊断记录', () => {
  const { router } = setup();
  const stale = acquireOk(router); // a，代次 1
  router.setNodes('svc', [
    { id: 'a', region: 'east', generation: 2 },
    { id: 'b', region: 'east', generation: 1 },
    { id: 'c', region: 'west', generation: 1 },
  ]);
  router.report(stale, 'success');
  assert.equal(router.diagnostics().length, 1);
  assert.equal(router.diagnostics()[0].reason, 'stale-generation');
  const a = view(router, 'a');
  assert.equal(a.generation, 2);
  assert.equal(a.validSamples, 0); // 未计入统计
  // 新代次正常参与
  const fresh = acquireOk(router);
  assert.equal(fresh.generation, 2);
  router.report(fresh, 'remote-error');
  assert.equal(view(router, 'a').remoteErrors, 1);
});

test('重复报告进入诊断，未知凭证抛错', () => {
  const { router } = setup();
  const cred = acquireOk(router);
  router.report(cred, 'success');
  router.report(cred, 'success');
  assert.equal(router.diagnostics().length, 1);
  assert.equal(router.diagnostics()[0].reason, 'duplicate-report');
  assert.equal(view(router, 'a').validSamples, 1); // 只计一次
  const fake: Credential = { ...cred, attemptId: 'att-999' };
  assert.throws(() => router.report(fake, 'success'), /unknown credential/);
});

test('多个探测同时完成时状态转换与选路结果彼此一致', () => {
  // 成功 + 成功：达到恢复阈值后选路立即可见
  const ctx1 = setup({}, [A]);
  toProbing(ctx1, 'a');
  const p1 = probeOk(ctx1.router);
  const p2 = probeOk(ctx1.router);
  ctx1.router.report(p1, 'success');
  ctx1.router.report(p2, 'success');
  assert.equal(view(ctx1.router, 'a').state, 'healthy');
  assert.equal(acquireOk(ctx1.router).nodeId, 'a');

  // 失败 + 成功（同一时刻到达）：按到达顺序应用，先失败后旧成功失效
  const ctx2 = setup({}, [A]);
  toProbing(ctx2, 'a');
  const q1 = probeOk(ctx2.router);
  const q2 = probeOk(ctx2.router);
  ctx2.router.report(q1, 'remote-error'); // 立即重新隔离
  ctx2.router.report(q2, 'success'); // 旧轮次 → 诊断
  assert.equal(view(ctx2.router, 'a').state, 'isolated');
  assert.equal(ctx2.router.acquire('svc').status, 'unavailable');
  assert.equal(ctx2.router.diagnostics().length, 1);
});
