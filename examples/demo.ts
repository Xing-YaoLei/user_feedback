/**
 * 可运行的手动步进示例：
 *   node examples/demo.ts
 *
 * 逐步展示：会话/事务创建 -> 共享与独占申请 -> 相互升级死锁与受害者 ->
 * fencing token 校验 -> 第三笔跨资源申请 -> 时钟推进导致会话过期 -> 旧凭证失效。
 */
import { CoordinatorError, LockCoordinator, ManualClock } from '../src/index.ts';

const clock = new ManualClock(0);
const coordinator = new LockCoordinator(clock);

coordinator.onEvent((event) => {
  if (event.type === 'grant') {
    const detail = event.locks
      .map((l) => `${l.resource}:${l.mode}${l.fencingToken ? `#token${l.fencingToken}` : ''}`)
      .join(', ');
    console.log(`[t=${event.at}] grant  -> ${event.transactionId} { ${detail} }`);
  } else {
    console.log(`[t=${event.at}] end    -> ${event.transactionId} (${event.reason})`);
  }
});

const sessionA = coordinator.createSession({ leaseLength: 100 });
const sessionB = coordinator.createSession({ leaseLength: 100 });
const sessionC = coordinator.createSession({ leaseLength: 30 });

const txA = coordinator.startTransaction(sessionA);
const txB = coordinator.startTransaction(sessionB);
const txC = coordinator.startTransaction(sessionC);

console.log('--- A、B 共同持有 r1 的共享锁 ---');
await coordinator.acquire(txA, [{ resource: 'r1', mode: 'shared' }]);
await coordinator.acquire(txB, [{ resource: 'r1', mode: 'shared' }]);

console.log('--- A、B 同时申请升级为独占，形成等待环 ---');
const upgradeA = coordinator.acquire(txA, [{ resource: 'r1', mode: 'exclusive' }]);
const upgradeB = coordinator.acquire(txB, [{ resource: 'r1', mode: 'exclusive' }]);

try {
  await upgradeB;
} catch (error) {
  if (error instanceof CoordinatorError) {
    console.log(`>>> B 被选为死锁受害者: code=${error.code}, reason=${error.reason}`);
  }
}
const aGrant = await upgradeA;
const token = aGrant[0]!.fencingToken!;
console.log(`>>> A 升级成功，token=${token}，校验:`, coordinator.validateFencingToken(txA, 'r1', token));

console.log('--- C 整批申请 r1 + r2（r1 被 A 挡住，整批共同等待）---');
const cBatch = coordinator.acquire(txC, [
  { resource: 'r1', mode: 'exclusive' },
  { resource: 'r2', mode: 'exclusive' },
]);

console.log('--- A 提交，C 的整批一次性授权 ---');
coordinator.commit(txA);
const cGrant = await cBatch;
const r1Token = cGrant.find((l) => l.resource === 'r1')!.fencingToken!;
console.log(`>>> C 凭证校验（过期前）:`, coordinator.validateFencingToken(txC, 'r1', r1Token));

console.log('--- 推进时钟 30 个单位：C 的会话到期 ---');
clock.advance(30);
console.log(`>>> C 是否仍活跃:`, coordinator.isTransactionActive(txC));
console.log(`>>> C 旧凭证校验（过期后）:`, coordinator.validateFencingToken(txC, 'r1', r1Token));
try {
  coordinator.renewSession(sessionC, 50);
} catch (error) {
  if (error instanceof CoordinatorError) {
    console.log(`>>> 迟到续租被拒绝: code=${error.code}`);
  }
}

console.log('--- 授权轨迹 ---');
for (const event of coordinator.getGrantTrail()) {
  console.log(`  t=${event.at} ${event.transactionId}: ${event.locks.map((l) => l.resource).join('+')}`);
}
