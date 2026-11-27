/**
 * 演示：正常选路 → 连续失败隔离 → 受控探测恢复。
 * 运行：npm start
 */
import { createHealthRouter, type Credential, type Outcome } from './index.ts';

let now = 0;
const router = createHealthRouter({
  clock: () => now,
  policy: {
    windowMs: 5_000,
    consecutiveFailureThreshold: 2,
    maxIsolations: 1,
    baseIsolationMs: 1_000,
    isolationBackoffFactor: 2,
    maxIsolationMs: 10_000,
    probe: { concurrency: 2, successThreshold: 2, roundMs: 500 },
  },
  services: {
    svc: {
      regionPriority: ['east', 'west'],
      nodes: [
        { id: 'a', region: 'east', generation: 1 },
        { id: 'b', region: 'east', generation: 1 },
        { id: 'c', region: 'west', generation: 1 },
      ],
    },
  },
});

function attempt(outcome: Outcome): void {
  const r = router.acquire('svc');
  if (r.status !== 'ok') {
    console.log(`t=${now}  acquire -> 暂不可用`);
    return;
  }
  console.log(`t=${now}  acquire -> ${r.credential.nodeId}，报告 ${outcome}`);
  router.report(r.credential, outcome);
}

function probe(outcome: Outcome): void {
  const r = router.acquireProbe('svc');
  if (r.status !== 'ok') {
    console.log(`t=${now}  probe   -> 无探测名额`);
    return;
  }
  const cred: Credential = r.credential;
  console.log(`t=${now}  probe   -> ${cred.nodeId}，报告 ${outcome}`);
  router.report(cred, outcome);
}

console.log('--- 初始候选:', router.inspect('svc').candidates);
attempt('remote-error'); // a 连续失败
attempt('remote-error'); // a → 隔离
console.log('--- a 隔离后候选:', router.inspect('svc').candidates);
attempt('success'); // b 正常

now = 1_000; // a 隔离到期
router.tick();
probe('success');
probe('success'); // 累计 2 个有效成功 → 恢复
console.log('--- a 恢复后候选:', router.inspect('svc').candidates);

console.log('\n--- 事件轨迹 ---');
for (const e of router.events()) console.log(JSON.stringify(e));
console.log('\n--- 最终快照 ---');
console.log(JSON.stringify(router.inspect('svc'), null, 2));
