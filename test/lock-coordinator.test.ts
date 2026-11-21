import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CoordinatorError,
  LockCoordinator,
  ManualClock,
  type CoordinatorEvent,
  type LockRequest,
} from '../src/index.ts';

const S = (resource: string): LockRequest => ({ resource, mode: 'shared' });
const X = (resource: string): LockRequest => ({ resource, mode: 'exclusive' });

function isError(err: unknown, code: string): boolean {
  return err instanceof CoordinatorError && err.code === code;
}

/** New coordinator on a manual clock, recording every event. */
function harness(leaseLength = 100) {
  const clock = new ManualClock(0);
  const coordinator = new LockCoordinator(clock);
  const events: CoordinatorEvent[] = [];
  coordinator.onEvent((e) => events.push(e));
  const session = () => coordinator.createSession({ leaseLength });
  return { clock, coordinator, events, session };
}

describe('共享/独占基本授权与兼容性', () => {
  test('共享锁可共存，独占锁互斥，独立资源不受阻塞影响', async () => {
    const { coordinator, session } = harness();
    const s1 = session();
    const s2 = session();
    const s3 = session();
    const txA = coordinator.startTransaction(s1);
    const txB = coordinator.startTransaction(s2);
    const txC = coordinator.startTransaction(s3);

    const a = await coordinator.acquire(txA, [S('r1')]);
    assert.deepEqual(a, [{ resource: 'r1', mode: 'shared' }]);

    const b = await coordinator.acquire(txB, [S('r1')]);
    assert.equal(b[0]!.mode, 'shared');
    assert.equal(b[0]!.fencingToken, undefined);

    // 独立资源在 r1 被共享持有时照常授权
    const c = await coordinator.acquire(txC, [X('r2')]);
    assert.deepEqual(c, [{ resource: 'r2', mode: 'exclusive', fencingToken: 1 }]);

    // 独占申请必须排队等待
    const waiter = coordinator.acquire(txC, [X('r1')]);
    assert.equal(coordinator.getQueue('r1')[0]!.transactionId, txC);
    assert.deepEqual(coordinator.getHeldLocks(txC).map((l) => l.resource), ['r2']);

    coordinator.commit(txA);
    coordinator.commit(txB);
    const granted = await waiter;
    // r1 的第一把独占锁，token 从 1 开始（按资源独立计数）
    assert.deepEqual(granted, [{ resource: 'r1', mode: 'exclusive', fencingToken: 1 }]);
  });

  test('先到的独占申请阻挡后来的共享申请插队', async () => {
    const { coordinator, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());
    const txC = coordinator.startTransaction(session());

    await coordinator.acquire(txA, [X('r')]);
    const bWait = coordinator.acquire(txB, [X('r')]); // 先到，排队
    const cWait = coordinator.acquire(txC, [S('r')]); // 后来，共享也不得插队

    assert.deepEqual(coordinator.getQueue('r').map((q) => q.transactionId), [txB, txC]);

    coordinator.commit(txA);
    const bGrant = await bWait;
    assert.equal(bGrant[0]!.fencingToken, 2); // 第二次独占授权
    // B 持独占期间 C 仍在等待
    assert.equal(coordinator.isTransactionActive(txC), true);
    assert.equal(coordinator.getQueue('r')[0]!.transactionId, txC);

    coordinator.commit(txB);
    const cGrant = await cWait;
    assert.equal(cGrant[0]!.mode, 'shared');
  });

  test('同批内重复资源合并为更强模式', async () => {
    const { coordinator, session } = harness();
    const tx = coordinator.startTransaction(session());
    const got = await coordinator.acquire(tx, [S('r'), X('r'), S('r')]);
    assert.deepEqual(got, [{ resource: 'r', mode: 'exclusive', fencingToken: 1 }]);
  });

  test('无效请求被同步拒绝', () => {
    const { coordinator, session } = harness();
    const tx = coordinator.startTransaction(session());
    assert.throws(() => coordinator.acquire(tx, []), (e) => isError(e, 'INVALID_REQUEST'));
    assert.throws(
      () => coordinator.acquire(tx, [{ resource: 'r', mode: 'nope' as never }]),
      (e) => isError(e, 'INVALID_REQUEST'),
    );
  });
});

describe('整批共同授权（all-or-nothing）', () => {
  test('一批锁要么全部立即获得，要么整体排队，不会部分持有', async () => {
    const { coordinator, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());
    const txC = coordinator.startTransaction(session());

    await coordinator.acquire(txA, [X('r1')]);

    // r1 被占、r2 空闲：B 的整批仍须排队，r2 不会先落到 B 手里
    const bWait = coordinator.acquire(txB, [S('r1'), X('r2')]);
    assert.deepEqual(coordinator.getHeldLocks(txB), []);
    assert.deepEqual(coordinator.getQueue('r1').map((q) => q.transactionId), [txB]);
    assert.deepEqual(coordinator.getQueue('r2').map((q) => q.transactionId), [txB]);

    // 互不冲突的 r3 继续授权，系统没有被卡死
    const cGrant = await coordinator.acquire(txC, [X('r3')]);
    assert.equal(cGrant[0]!.fencingToken, 1);

    // r2 的队首先于后来者：C 也想要 r2 时只能排在 B 后面
    const cR2 = coordinator.acquire(txC, [S('r2')]);
    assert.deepEqual(coordinator.getQueue('r2').map((q) => q.transactionId), [txB, txC]);

    coordinator.commit(txA);
    // A 释放 r1 后 B 的整批一次性授权（r2 此前无持锁者，只是被 B 的批次占住队首）
    const bGrant = await bWait;
    assert.deepEqual(
      bGrant.sort((x, y) => x.resource.localeCompare(y.resource)),
      [
        { resource: 'r1', mode: 'shared' },
        { resource: 'r2', mode: 'exclusive', fencingToken: 1 },
      ],
    );
    // 这里没有等待环：B 从不请求 C 持有的 r3，C 只是在 r2 上正常排在 B 后面
    assert.equal(coordinator.isTransactionActive(txC), true);

    // B 提交释放 r2，C 随即获锁，协调器持续推进、没有卡死
    coordinator.commit(txB);
    const cGot = await cR2;
    assert.equal(cGot[0]!.resource, 'r2');
    assert.equal(cGot[0]!.mode, 'shared');
  });

  test('事务可分多批申请，已持有的足够模式锁直接从持锁关系应答', async () => {
    const { coordinator, session } = harness();
    const tx = coordinator.startTransaction(session());
    await coordinator.acquire(tx, [S('r1'), S('r2')]);
    // 再次申请已持有的共享锁：立即返回，不排队
    const again = await coordinator.acquire(tx, [S('r1')]);
    assert.deepEqual(again, [{ resource: 'r1', mode: 'shared' }]);
    assert.deepEqual(coordinator.getQueue('r1'), []);
  });
});

describe('锁升级与等待图死锁', () => {
  test('两笔事务相互升级：环内最近创建的事务成为受害者，升级保留原锁', async () => {
    const { coordinator, events, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());

    await coordinator.acquire(txA, [S('r')]);
    await coordinator.acquire(txB, [S('r')]);

    // 等待升级期间原共享锁仍被持有
    const upA = coordinator.acquire(txA, [X('r')]);
    assert.deepEqual(coordinator.getHeldLocks(txA).map((l) => l.mode), ['shared']);
    assert.equal(coordinator.getQueue('r')[0]!.isUpgrade, true);

    const upB = coordinator.acquire(txB, [X('r')]);

    // B 创建更晚 -> 死锁受害者；其等待被撤销、共享锁被释放
    await assert.rejects(upB, (e: unknown) => isError(e, 'DEADLOCK'));
    assert.equal(coordinator.isTransactionActive(txB), false);
    assert.deepEqual(coordinator.getHeldLocks(txB), []);

    // B 释放后泵同步推进：A 无需再排队，直接完成升级
    assert.deepEqual(coordinator.getQueue('r'), []);

    // A 保留原锁并完成升级，获得新 fencing token
    const aGrant = await upA;
    assert.deepEqual(aGrant, [{ resource: 'r', mode: 'exclusive', fencingToken: 1 }]);
    assert.deepEqual(coordinator.getHeldLocks(txA), [
      { resource: 'r', mode: 'exclusive', fencingToken: 1 },
    ]);

    const endEvents = events.filter((e) => e.type === 'transaction-end');
    assert.equal(endEvents.length, 1);
    assert.deepEqual(endEvents[0], {
      type: 'transaction-end',
      transactionId: txB,
      reason: 'deadlock-victim',
      at: 0,
    });
  });

  test('三节点等待环：只按创建顺序选择受害者，环解后其余申请继续推进', async () => {
    const { coordinator, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());
    const txC = coordinator.startTransaction(session());

    await coordinator.acquire(txA, [X('r1')]);
    await coordinator.acquire(txB, [X('r2')]);
    await coordinator.acquire(txC, [X('r3')]);

    const aWait = coordinator.acquire(txA, [X('r2')]); // A -> B
    const bWait = coordinator.acquire(txB, [X('r3')]); // B -> C
    const cWait = coordinator.acquire(txC, [X('r1')]); // C -> A，闭环

    await assert.rejects(cWait, (e: unknown) => isError(e, 'DEADLOCK'));
    assert.equal(coordinator.isTransactionActive(txC), false);

    // C 释放 r3 后 B 先推进；A 仍在等 B 手里的 r2（此时已无环）
    const bGrant = await bWait;
    assert.equal(bGrant[0]!.resource, 'r3');
    // r3 的第二次独占授权（C 持有的是 token 1），计数严格递增
    assert.equal(bGrant[0]!.fencingToken, 2);
    assert.equal(coordinator.isTransactionActive(txA), true);
    assert.deepEqual(coordinator.getQueue('r2').map((q) => q.transactionId), [txA]);

    coordinator.commit(txB);
    const aGrant = await aWait;
    assert.equal(aGrant[0]!.resource, 'r2');
    assert.equal(aGrant[0]!.fencingToken, 2);
  });

  test('受害者只在环内按创建顺序选出：环外更年轻的事务不受牵连', async () => {
    const { coordinator, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());
    const txC = coordinator.startTransaction(session());
    const txD = coordinator.startTransaction(session()); // 全局最年轻，但不在环上

    await coordinator.acquire(txA, [X('r1')]);
    await coordinator.acquire(txB, [X('r2')]);
    // C、D 只在互不相关的资源上正常持锁
    await coordinator.acquire(txC, [X('r3')]);
    await coordinator.acquire(txD, [X('r4')]);

    const aWait = coordinator.acquire(txA, [X('r2')]); // A -> B
    const bWait = coordinator.acquire(txB, [X('r1')]); // B -> A，闭环；C 是环内最年轻

    await assert.rejects(bWait, (e: unknown) => isError(e, 'DEADLOCK'));
    assert.equal(coordinator.isTransactionActive(txB), false);
    // 环外的 D（比 C 更年轻）必须保持活跃，C 也未被选作受害者
    assert.equal(coordinator.isTransactionActive(txD), true);
    assert.equal(coordinator.isTransactionActive(txC), true);
    assert.equal(coordinator.isTransactionActive(txA), true);
    assert.deepEqual(coordinator.getHeldLocks(txD).map((l) => l.resource), ['r4']);

    // 环解开后 A 继续推进拿到 r2
    const aGrant = await aWait;
    assert.equal(aGrant[0]!.resource, 'r2');
  });

  test('已失效的等待请求在锁释放后也不会获锁', async () => {
    const { coordinator, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());

    await coordinator.acquire(txA, [X('r')]);
    const bWait = coordinator.acquire(txB, [S('r')]);
    coordinator.cancel(txB);
    await assert.rejects(bWait, (e: unknown) => isError(e, 'CANCELLED'));

    // A 释放后队列里已经没有 B，泵推进不会给 B 补发
    coordinator.commit(txA);
    assert.deepEqual(coordinator.getHeldLocks(txB), []);
    assert.deepEqual(coordinator.getQueue('r'), []);
  });
});

describe('fencing token 与写入凭证校验', () => {
  test('同一资源独占授权严格递增，校验绑定当前持有与租约', async () => {
    const { clock, coordinator, session } = harness(50);
    const sA = session();
    const txA = coordinator.startTransaction(sA);

    const g1 = await coordinator.acquire(txA, [X('r')]);
    const token1 = g1[0]!.fencingToken!;
    assert.equal(token1, 1);
    assert.equal(coordinator.validateFencingToken(txA, 'r', token1), true);
    assert.equal(coordinator.validateFencingToken(txA, 'r', 999), false);
    assert.equal(coordinator.validateFencingToken(txA, 'other', token1), false);

    // 释放后再获取：旧凭证立即失效，新凭证递增
    coordinator.release(txA, ['r']);
    assert.equal(coordinator.validateFencingToken(txA, 'r', token1), false);
    const g2 = await coordinator.acquire(txA, [X('r')]);
    const token2 = g2[0]!.fencingToken!;
    assert.equal(token2, 2);
    assert.equal(coordinator.validateFencingToken(txA, 'r', token2), true);
    assert.equal(coordinator.validateFencingToken(txA, 'r', token1), false);

    // 租约过期 -> 事务终止、锁释放，凭证全部失效
    clock.advance(50); // 边界：expiresAt <= now 即到期
    assert.equal(coordinator.isTransactionActive(txA), false);
    assert.equal(coordinator.validateFencingToken(txA, 'r', token2), false);
    assert.deepEqual(coordinator.getHeldLocks(txA), []);
  });

  test('共享->独占升级产生新 token，共享期间无凭证', async () => {
    const { coordinator, session } = harness();
    const tx = coordinator.startTransaction(session());
    await coordinator.acquire(tx, [S('r')]);
    assert.equal(coordinator.validateFencingToken(tx, 'r', 1), false);
    const up = await coordinator.acquire(tx, [X('r')]);
    assert.equal(up[0]!.fencingToken, 1);
    assert.equal(coordinator.validateFencingToken(tx, 'r', 1), true);
  });

  test('不同资源的 token 各自独立计数', async () => {
    const { coordinator, session } = harness();
    const tx = coordinator.startTransaction(session());
    const got = await coordinator.acquire(tx, [X('a'), X('b')]);
    assert.deepEqual(
      got.map((l) => [l.resource, l.fencingToken]),
      [
        ['a', 1],
        ['b', 1],
      ],
    );
  });
});

describe('租约、续租、截止时间与取消', () => {
  test('时钟逐步推进触发会话过期，迟到的续租不能恢复旧会话', () => {
    const clock = new ManualClock(0);
    const coordinator = new LockCoordinator(clock);
    const s1 = coordinator.createSession({ leaseLength: 10 });
    const tx = coordinator.startTransaction(s1);

    clock.advance(9);
    assert.equal(coordinator.isSessionValid(s1), true);
    // 到期前续租成功，过期时间从当前时刻重算
    const newExpiry = coordinator.renewSession(s1, 10);
    assert.equal(newExpiry, 19);

    clock.advance(10); // t=19，恰好到期
    assert.equal(coordinator.isSessionValid(s1), false);
    assert.equal(coordinator.isTransactionActive(tx), false);
    assert.throws(() => coordinator.renewSession(s1, 100), (e) => isError(e, 'SESSION_EXPIRED'));
    // 再推进时间也不会让旧会话复活
    clock.advance(100);
    assert.equal(coordinator.isSessionValid(s1), false);
  });

  test('事务截止时间到达即终止，等待中的申请被撤销', async () => {
    const clock = new ManualClock(0);
    const coordinator = new LockCoordinator(clock);
    const holder = coordinator.startTransaction(coordinator.createSession({ leaseLength: 100 }));
    const waiterSession = coordinator.createSession({ leaseLength: 100 });
    const waiter = coordinator.startTransaction(waiterSession, { deadline: 20 });

    await coordinator.acquire(holder, [X('r')]);
    const pending = coordinator.acquire(waiter, [S('r')]);

    clock.advance(15);
    assert.equal(coordinator.isTransactionActive(waiter), true);
    clock.advance(5); // t=20 截止
    await assert.rejects(pending, (e: unknown) => isError(e, 'DEADLINE_EXCEEDED'));
    assert.equal(coordinator.isTransactionActive(waiter), false);
    assert.deepEqual(coordinator.getQueue('r'), []);
  });

  test('取消结束事务、释放全部锁并通知后续等待者', async () => {
    const { coordinator, events, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());

    await coordinator.acquire(txA, [X('r')]);
    const bWait = coordinator.acquire(txB, [X('r')]);
    coordinator.cancel(txA);

    const granted = await bWait;
    assert.equal(granted[0]!.fencingToken, 2);
    const cancelEvent = events.find(
      (e) => e.type === 'transaction-end' && e.transactionId === txA,
    );
    assert.ok(cancelEvent);
    assert.equal(cancelEvent!.type, 'transaction-end');
    if (cancelEvent!.type === 'transaction-end') {
      assert.equal(cancelEvent.reason, 'cancelled');
    }
  });

  test('已经结束的事务 ID 永久失效，每个操作都确定报错', () => {
    const { coordinator, session } = harness();
    const tx = coordinator.startTransaction(session());
    coordinator.commit(tx);

    assert.throws(() => coordinator.acquire(tx, [X('r')]), (e) => isError(e, 'TRANSACTION_ENDED'));
    assert.throws(() => coordinator.cancel(tx), (e) => isError(e, 'TRANSACTION_ENDED'));
    assert.throws(() => coordinator.commit(tx), (e) => isError(e, 'TRANSACTION_ENDED'));
    assert.throws(() => coordinator.release(tx, ['r']), (e) => isError(e, 'TRANSACTION_ENDED'));
    assert.equal(coordinator.isTransactionActive(tx), false);

    // 会话仍有效，可以开启新事务
    const tx2 = coordinator.startTransaction(session());
    assert.equal(coordinator.isTransactionActive(tx2), true);
  });

  test('等待批次未决时不能结束事务，也不能发起第二批申请', async () => {
    const { coordinator, session } = harness();
    const txA = coordinator.startTransaction(session());
    const txB = coordinator.startTransaction(session());

    await coordinator.acquire(txA, [X('r')]);
    const pending = coordinator.acquire(txB, [S('r')]);

    assert.throws(
      () => coordinator.acquire(txB, [X('r2')]),
      (e) => isError(e, 'INVALID_REQUEST'),
    );
    assert.throws(() => coordinator.commit(txB), (e) => isError(e, 'INVALID_REQUEST'));
    assert.throws(() => coordinator.rollback(txB), (e) => isError(e, 'INVALID_REQUEST'));

    // cancel 仍然可以撤销等待中的事务
    coordinator.cancel(txB);
    await assert.rejects(pending, (e: unknown) => isError(e, 'CANCELLED'));
  });
});

describe('题目要求的综合步进场景', () => {
  test('相互升级 -> 第三笔跨资源申请 -> 会话过期 -> 旧凭证校验，逐步可判定', async () => {
    const clock = new ManualClock(0);
    const coordinator = new LockCoordinator(clock);
    const events: CoordinatorEvent[] = [];
    coordinator.onEvent((e) => events.push(e));

    // 三笔事务，租约 deliberately 错开以便只让 C 的会话先过期
    const sA = coordinator.createSession({ leaseLength: 100 });
    const sB = coordinator.createSession({ leaseLength: 100 });
    const sC = coordinator.createSession({ leaseLength: 30 });
    const sD = coordinator.createSession({ leaseLength: 100 });
    const txA = coordinator.startTransaction(sA);
    const txB = coordinator.startTransaction(sB);
    const txC = coordinator.startTransaction(sC);
    const txD = coordinator.startTransaction(sD);

    // 1) A、B 先后取得 r1 共享锁
    await coordinator.acquire(txA, [S('r1')]);
    await coordinator.acquire(txB, [S('r1')]);

    // 2) 互相升级形成等待环，B 更新 -> B 受害，A 升级成功
    const upA = coordinator.acquire(txA, [X('r1')]);
    const upB = coordinator.acquire(txB, [X('r1')]);
    await assert.rejects(upB, (e: unknown) => isError(e, 'DEADLOCK'));
    const aExclusive = await upA;
    assert.equal(aExclusive[0]!.fencingToken, 1);
    assert.equal(coordinator.validateFencingToken(txA, 'r1', 1), true);

    // 3) C 跨 r1/r2 整批申请：r1 被 A 挡住，r2 空闲但整批共同等待
    const cBatch = coordinator.acquire(txC, [X('r1'), X('r2')]);
    assert.deepEqual(coordinator.getHeldLocks(txC), []);
    assert.deepEqual(coordinator.getQueue('r1').map((q) => q.transactionId), [txC]);
    assert.deepEqual(coordinator.getQueue('r2').map((q) => q.transactionId), [txC]);

    // 4) 互不冲突的 r3 上 D 立即获锁，协调器仍在推进其他资源
    const dGrant = await coordinator.acquire(txD, [X('r3')]);
    assert.equal(dGrant[0]!.fencingToken, 1);

    // 5) A 提交 -> r1 释放 -> C 的整批一次性授权，token 按资源各自递增
    coordinator.commit(txA);
    const cGrant = await cBatch;
    assert.deepEqual(
      cGrant.sort((x, y) => x.resource.localeCompare(y.resource)),
      [
        { resource: 'r1', mode: 'exclusive', fencingToken: 2 },
        { resource: 'r2', mode: 'exclusive', fencingToken: 1 },
      ],
    );

    // 授权轨迹：每个 grant 事件依次可核对
    const grants = coordinator.getGrantTrail();
    assert.deepEqual(
      grants.map((g) => `${g.transactionId}:${g.locks.map((l) => l.resource).join('+')}`),
      [`${txA}:r1`, `${txB}:r1`, `${txA}:r1`, `${txD}:r3`, `${txC}:r1+r2`],
    );

    // 6) C 凭证当前有效；推进时钟使 C 的会话过期（t=30），其余会话仍有效
    assert.equal(coordinator.validateFencingToken(txC, 'r1', 2), true);
    clock.advance(30);
    assert.equal(coordinator.isSessionValid(sC), false);
    assert.equal(coordinator.isSessionValid(sA), true); // A 的会话租约未到
    assert.equal(coordinator.isTransactionActive(txC), false);

    // 7) 旧凭证校验全部失败：C 因过期失锁，A 的 token 1 因提交早已失效
    assert.equal(coordinator.validateFencingToken(txC, 'r1', 2), false);
    assert.equal(coordinator.validateFencingToken(txC, 'r2', 1), false);
    assert.equal(coordinator.validateFencingToken(txA, 'r1', 1), false);
    assert.deepEqual(coordinator.getHeldLocks(txC), []);

    // 8) 迟到续租无法恢复旧会话；结束事件原因正确
    assert.throws(() => coordinator.renewSession(sC, 50), (e) => isError(e, 'SESSION_EXPIRED'));
    const endReasons = events
      .filter((e) => e.type === 'transaction-end')
      .map((e) => (e.type === 'transaction-end' ? `${e.transactionId}:${e.reason}` : ''));
    assert.ok(endReasons.includes(`${txB}:deadlock-victim`));
    assert.ok(endReasons.includes(`${txA}:committed`));
    assert.ok(endReasons.includes(`${txC}:session-expired`));
  });

  test('续租、等待升级、超时回调与取消通知交错，状态始终一致', async () => {
    const clock = new ManualClock(0);
    const coordinator = new LockCoordinator(clock);
    const sA = coordinator.createSession({ leaseLength: 10 });
    const sB = coordinator.createSession({ leaseLength: 100 });
    const txA = coordinator.startTransaction(sA);
    const txB = coordinator.startTransaction(sB);
    const txC = coordinator.startTransaction(sB, { deadline: 20 });
    const txD = coordinator.startTransaction(sB);

    // A、B 先共同持有 r1 共享锁
    await coordinator.acquire(txA, [S('r1')]);
    await coordinator.acquire(txB, [S('r1')]);

    // A 申请升级为独占：排队等待，期间保留原共享锁（等待升级）
    const upgrade = coordinator.acquire(txA, [X('r1')]);
    assert.equal(coordinator.getQueue('r1')[0]!.isUpgrade, true);
    assert.deepEqual(coordinator.getHeldLocks(txA).map((l) => l.mode), ['shared']);

    // C 后来申请共享锁，排在 A 后面，不得插队
    const cWait = coordinator.acquire(txC, [S('r1')]);
    assert.deepEqual(coordinator.getQueue('r1').map((q) => q.transactionId), [txA, txC]);

    // t=5：A 续租（延长 20，新到期点 t=25），等待队列不受影响
    clock.advance(5);
    assert.equal(coordinator.renewSession(sA, 20), 25);
    assert.deepEqual(coordinator.getQueue('r1').map((q) => q.transactionId), [txA, txC]);

    // t=15：A 租约因续租仍有效；独立资源 r2 上的其他事务照常授权
    clock.advance(10);
    assert.equal(coordinator.isSessionValid(sA), true);
    const side = await coordinator.acquire(txD, [X('r2')]);
    assert.equal(side[0]!.fencingToken, 1);

    // t=20：C 的截止时间触发，C 被撤销且不补发锁，A 仍是队首
    clock.advance(5);
    assert.equal(coordinator.isSessionValid(sA), true);
    await assert.rejects(cWait, (e: unknown) => isError(e, 'DEADLINE_EXCEEDED'));
    assert.deepEqual(coordinator.getQueue('r1').map((q) => q.transactionId), [txA]);

    // B 提交释放共享锁 -> A 的等待升级完成，获得 fencing token
    coordinator.commit(txB);
    const upGrant = await upgrade;
    assert.deepEqual(upGrant, [{ resource: 'r1', mode: 'exclusive', fencingToken: 1 }]);
    assert.equal(coordinator.validateFencingToken(txA, 'r1', 1), true);

    // A 取消 -> 释放 r1（取消通知），结束的事务 ID 随即失效
    coordinator.cancel(txA);
    assert.equal(coordinator.isTransactionActive(txA), false);
    assert.equal(coordinator.validateFencingToken(txA, 'r1', 1), false);
    assert.deepEqual(coordinator.getHeldLocks(txC), []);
  });
});
