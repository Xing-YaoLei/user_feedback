import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ManualClock, OffsetClock } from '../src/clock.ts';
import { Coordinator } from '../src/coordinator.ts';
import { QuotaNode, type CoordinatorClient } from '../src/node.ts';
import { DirectClient } from '../src/client.ts';
import type { BorrowRequest, ConsumeReport, ReturnIntent } from '../src/protocol.ts';

const WINDOW = 1000;
const SKEW = 10;

interface Harness {
  trueClock: ManualClock;
  coordinatorClock: OffsetClock;
  coordinator: Coordinator;
  client: CoordinatorClient;
}

function harness(overrides: Partial<ConstructorParameters<typeof Coordinator>[0]> = {}): Harness {
  const trueClock = new ManualClock(0);
  const coordinatorClock = new OffsetClock(trueClock, 0);
  const coordinator = new Coordinator({
    clock: coordinatorClock,
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 60, B: 60 },
    leaseTtlMs: 400,
    ...overrides,
  });
  return { trueClock, coordinatorClock, coordinator, client: new DirectClient(coordinator) };
}

function makeNode(
  h: Harness,
  nodeId: string,
  tenantId: string,
  offsetMs = 0,
  borrowAmount = 40,
): QuotaNode {
  return new QuotaNode({
    nodeId,
    clock: new OffsetClock(h.trueClock, offsetMs),
    skewMs: SKEW,
    borrowAmount,
    tenantId,
  });
}

test('a borrow reserves both global and tenant budget in the same window', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  const outcome = await node.borrow(h.client, 'r1', 40);
  assert.equal(outcome.ok, true);
  assert.deepEqual(h.coordinator.available('A'), { global: 60, tenant: 20 });
  assert.deepEqual(h.coordinator.available('B'), { global: 60, tenant: 60 });
});

test('a borrow exceeding the tenant budget is rejected even when global allows it', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  assert.equal((await node.borrow(h.client, 'r1', 50)).ok, true);
  const rejected = await node.borrow(h.client, 'r2', 20);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'insufficient_tenant');
  assert.deepEqual(h.coordinator.available('A'), { global: 50, tenant: 10 });
});

test('a borrow exceeding the global budget is rejected across tenants', async () => {
  const h = harness();
  h.trueClock.set(100);
  const a = makeNode(h, 'a', 'A');
  const b = makeNode(h, 'b', 'B');
  assert.equal((await a.borrow(h.client, 'ra', 50)).ok, true);
  assert.equal((await b.borrow(h.client, 'rb', 50)).ok, true);
  const third = makeNode(h, 'c', 'A');
  const rejected = await third.borrow(h.client, 'rc', 1);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'insufficient_global');
});

test('non-positive and fractional costs are rejected', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  for (const amount of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const outcome = await node.borrow(h.client, `bad-${String(amount)}`, amount);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'invalid_amount', `amount ${String(amount)}`);
  }
  assert.deepEqual(h.coordinator.available('A'), { global: 100, tenant: 60 });

  assert.equal(node.tryAdmit(0).ok, false);
  assert.equal(node.tryAdmit(-1).ok, false);
  assert.equal(node.tryAdmit(2.5).ok, false);
});

test('local admission keeps working while the coordinator is unreachable', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  assert.equal((await node.borrow(h.client, 'r1', 40)).ok, true);

  // No further coordinator calls at all from here on.
  let coordinatorCalls = 0;
  const offline: CoordinatorClient = {
    borrow: async () => {
      coordinatorCalls += 1;
      throw new Error('unreachable');
    },
    returnQuota: async () => {
      coordinatorCalls += 1;
      throw new Error('unreachable');
    },
    reportConsumption: async () => {
      coordinatorCalls += 1;
      throw new Error('unreachable');
    },
  };
  void offline;

  for (let i = 0; i < 4; i += 1) {
    const result = node.tryAdmit(10);
    assert.equal(result.ok, true);
  }
  assert.equal(node.localRemaining(), 0);
  assert.equal(node.tryAdmit(1).reason, 'insufficient_local_lease');
  assert.equal(coordinatorCalls, 0);
});

test('consumption beyond the lease is refused locally', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 30);
  assert.equal(node.tryAdmit(20).ok, true);
  const over = node.tryAdmit(11);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'insufficient_local_lease');
  assert.equal(node.localRemaining(), 10);
});

test('a lease is not usable before its window starts or after it expires (skew-conservative)', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  const outcome = await node.borrow(h.client, 'r1', 20);
  assert.equal(outcome.ok, true);
  const lease = node.currentLease();
  assert.ok(lease);

  // Inside the lease with plenty of margin.
  assert.equal(node.tryAdmit(1, { at: lease.issuedAt + 100 }).ok, true);

  // Window start boundary: a reading within skew of the window start could
  // really be before it, so admission must be refused.
  assert.equal(node.tryAdmit(1, { at: lease.windowStart + SKEW - 1 }).reason, 'wrong_window');
  assert.equal(node.tryAdmit(1, { at: lease.windowStart + SKEW }).ok, true);

  // Expiry boundary: a reading within skew of the expiry could really be after
  // it, so admission must be refused.
  assert.equal(node.tryAdmit(1, { at: lease.expiresAt - SKEW + 1 }).reason, 'lease_expired');
  assert.equal(node.tryAdmit(1, { at: lease.expiresAt - SKEW }).ok, true);
});

test('a node whose clock is fast does not admit after the true expiry', async () => {
  const h = harness();
  h.trueClock.set(100);
  // Node clock reads 30ms ahead of true time, but declares skew 10.
  const node = makeNode(h, 'n1', 'A', 30);
  await node.borrow(h.client, 'r1', 20);
  const lease = node.currentLease();
  assert.ok(lease);
  // True time already past expiry + skew: the node's reading is well past it.
  const reading = lease.expiresAt + SKEW + 5 + 30;
  assert.notEqual(node.tryAdmit(1, { at: reading }).ok, true);
});

test('coordinator refuses a lease that cannot be used conservatively before the window ends', async () => {
  const h = harness();
  h.trueClock.set(WINDOW - 2 * SKEW - 1);
  const node = makeNode(h, 'n1', 'A');
  const outcome = await node.borrow(h.client, 'r1', 10);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'window_closing');
  assert.deepEqual(h.coordinator.available('A'), { global: 100, tenant: 60 });
});

test('granted leases never extend past windowEnd - skew', async () => {
  const h = harness();
  h.trueClock.set(900);
  const node = makeNode(h, 'n1', 'A');
  const outcome = await node.borrow(h.client, 'r1', 10);
  if (outcome.ok) {
    assert.ok(outcome.lease.expiresAt <= outcome.lease.windowEnd - SKEW);
    assert.ok(outcome.lease.expiresAt - outcome.lease.issuedAt >= SKEW + 1);
  } else {
    assert.equal(outcome.reason, 'window_closing');
  }
});

test('a return credits exactly the frozen amount and no more', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(15);
  const intent = node.prepareReturn('ret1');
  assert.ok(intent);
  assert.equal(intent.amount, 25);
  assert.equal(intent.consumedAtBoundary, 15);
  // Freezing immediately makes the frozen part inadmissible.
  assert.equal(node.tryAdmit(1).ok, false);

  const confirm = await node.submitReturn(h.client, intent);
  assert.equal(confirm.accepted, true);
  assert.equal(confirm.credited, 25);
  assert.deepEqual(h.coordinator.available('A'), { global: 85, tenant: 45 });

  // Replaying the same return id is a replay and does not credit again.
  const replay = await node.submitReturn(h.client, intent);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(h.coordinator.available('A'), { global: 85, tenant: 45 });
});

test('the same units cannot be returned twice under a different return id', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(15);
  const intent = node.prepareReturn('ret1')!;
  assert.equal((await node.submitReturn(h.client, intent)).accepted, true);
  const second = await node.submitReturn(h.client, { ...intent, returnId: 'ret2' } as ReturnIntent);
  assert.equal(second.accepted, false);
  assert.equal(second.credited, 0);
  assert.deepEqual(h.coordinator.available('A'), { global: 85, tenant: 45 });
});

test('a forged return claiming less consumption than reported is refused', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(20);
  // Report 20 consumed first.
  await node.reportConsumption(h.client, 'rep1');
  // Then try to return 25 (implying only 15 consumed): overlaps reported use.
  const forged: ReturnIntent = {
    type: 'return.intent',
    returnId: 'forged',
    leaseId: node.currentLease()!.leaseId,
    nodeId: 'n1',
    generation: node.generation,
    amount: 25,
    frozenFromSeq: 1,
    consumedAtBoundary: 15,
    sentAt: 100,
  };
  const confirm = await node.submitReturn(h.client, forged);
  assert.equal(confirm.accepted, false);
  assert.equal(confirm.credited, 0);
});

test('a return of consumed-and-returned-again units beyond the lease is refused', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(20);
  const first = node.prepareReturn('ret1')!; // 20 frozen, 20 consumed
  assert.equal((await node.submitReturn(h.client, first)).accepted, true);
  // A second return claiming 20 consumed and 20 returned again: the first
  // credit already occupies 20, so consumed+returned would exceed the lease.
  const second: ReturnIntent = {
    ...first,
    returnId: 'ret2',
    amount: 20,
    consumedAtBoundary: 20,
  };
  const confirm = await node.submitReturn(h.client, second);
  assert.equal(confirm.accepted, false);
  assert.equal(confirm.credited, 0);
});

test('a return from the wrong generation is fenced out', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  const intent = node.prepareReturn('ret1')!;
  node.reboot();
  // Replaying a *persisted* intent naming generation 1 is a trustworthy final
  // account, so it is accepted; claiming the remainder under generation 2 is not.
  const forged: ReturnIntent = { ...intent, returnId: 'ret-gen2', generation: node.generation };
  const confirm = await node.submitReturn(h.client, forged);
  assert.equal(confirm.accepted, false);
  assert.equal(confirm.reason, 'generation_mismatch');
});

test('a durable return survives reboot and is still accepted', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(10);
  const intent = node.prepareReturn('ret1')!;
  node.reboot();
  assert.equal(node.generation, 2);
  assert.deepEqual(node.durableReturnIntents().map((i) => i.returnId), ['ret1']);
  const results = await node.replayReturns(h.client);
  assert.equal(results.length, 1);
  assert.equal(results[0].accepted, true);
  assert.equal(results[0].credited, 30);
  assert.deepEqual(h.coordinator.available('A'), { global: 90, tenant: 50 });
});

test('returns for an old window are refused and never credit the new window', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(10);
  const intent = node.prepareReturn('ret1')!;
  h.trueClock.set(WINDOW + 100);
  const confirm = await node.submitReturn(h.client, intent);
  assert.equal(confirm.accepted, false);
  assert.equal(confirm.reason, 'stale_window');
  assert.equal(confirm.credited, 0);
  assert.deepEqual(h.coordinator.available('A'), { global: 100, tenant: 60 });
});

test('unconfirmed residue keeps occupying its window and expires with it', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(10);
  // Node dies: no return, no reports.
  node.reboot();
  assert.deepEqual(h.coordinator.available('A'), { global: 60, tenant: 20 });
  assert.equal(h.coordinator.windowSnapshot(0).globalReserved, 40);

  // New window: the old reservation is not carried forward.
  h.trueClock.set(WINDOW + 50);
  assert.deepEqual(h.coordinator.available('A'), { global: 100, tenant: 60 });
  assert.equal(h.coordinator.windowSnapshot(0).globalReserved, 40);
  assert.equal(h.coordinator.windowSnapshot(1).globalReserved, 0);
});

test('a stale borrow from a retired generation is refused', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 20);
  node.reboot();
  await node.borrow(h.client, 'r2', 20);
  const stale: BorrowRequest = {
    type: 'borrow.request',
    requestId: 'stale',
    nodeId: 'n1',
    generation: 1,
    tenantId: 'A',
    amount: 50,
    sentAt: 100,
  };
  const response = h.coordinator.handleBorrow(stale);
  assert.equal(response.lease, null);
  assert.equal(response.rejectionReason, 'stale_generation');
  assert.equal(h.coordinator.available('A').tenant, 20);
});

test('duplicate borrow requests return the original lease without reserving twice', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  const first = h.coordinator.handleBorrow(node.makeBorrowRequest('dup', 30));
  assert.ok(first.lease);
  const second = h.coordinator.handleBorrow(node.makeBorrowRequest('dup', 30));
  assert.equal(second.duplicate, true);
  assert.equal(second.lease?.leaseId, first.lease?.leaseId);
  assert.equal(h.coordinator.available('A').global, 70);
});

test('a duplicated grant never resets local quota', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  const outcome = await node.borrow(h.client, 'r1', 40);
  assert.ok(outcome.ok);
  node.tryAdmit(25);
  assert.equal(node.localRemaining(), 15);
  // Deliver the same grant a second time.
  node.acceptGrant(outcome.lease);
  assert.equal(node.localRemaining(), 15);
});

test('consumption reports are de-duplicated per node, generation, and seq', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(5);
  node.tryAdmit(7);
  const report = node.makeConsumeReport('rep1');
  const ack1 = h.coordinator.handleConsumeReport(report);
  assert.deepEqual(ack1.accepted, [1, 2]);
  const ack2 = h.coordinator.handleConsumeReport({ ...report, reportId: 'rep2' });
  assert.deepEqual(ack2.duplicates, [1, 2]);
  assert.equal(h.coordinator.windowSnapshot(0).globalConsumed, 12);
});

test('consumption from a retired generation is accounted separately and in its own window', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 20);
  node.tryAdmit(6);
  const g1Report = node.makeConsumeReport('g1-report');
  node.reboot();
  await node.borrow(h.client, 'r2', 20);
  node.tryAdmit(9);
  const g2Report = node.makeConsumeReport('g2-report');
  h.trueClock.set(WINDOW + 10);
  // The old generation's report arrives late, in the next window.
  const ack = h.coordinator.handleConsumeReport(g1Report);
  assert.deepEqual(ack.accepted, [1]);
  h.coordinator.handleConsumeReport(g2Report);
  const recorded = h.coordinator.recordsOfKind('consume').filter((r) => r.nodeId === 'n1');
  const g1 = recorded.find((r) => r.generation === 1);
  const g2 = recorded.find((r) => r.generation === 2);
  assert.ok(g1);
  assert.equal(g1.windowIndex, 0);
  assert.ok(g2);
  assert.equal(g2.windowIndex, 0);
  assert.equal(h.coordinator.windowSnapshot(0).globalConsumed, 15);
});

test('the same seq in a different generation is not treated as a duplicate', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 20);
  node.tryAdmit(4);
  const g1 = node.makeConsumeReport('g1');
  node.reboot();
  await node.borrow(h.client, 'r2', 20);
  node.tryAdmit(6);
  const g2 = node.makeConsumeReport('g2');
  assert.deepEqual(h.coordinator.handleConsumeReport(g1).accepted, [1]);
  assert.deepEqual(h.coordinator.handleConsumeReport(g2).accepted, [1]);
  assert.equal(h.coordinator.windowSnapshot(0).globalConsumed, 10);
});

test('reported consumption plus accepted returns never exceed the lease', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 50);
  node.tryAdmit(30);
  await node.reportConsumption(h.client, 'rep1');
  const intent = node.prepareReturn('ret1')!;
  assert.equal(intent.amount, 20);
  const confirm = await node.submitReturn(h.client, intent);
  assert.equal(confirm.accepted, true);
  const summary = h.coordinator.leaseSummary(intent.leaseId)!;
  assert.equal(summary.reportedConsumed + summary.creditedReturns, 50);
  assert.equal(summary.outstanding, 0);
});

test('every decision leaves an auditable record', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  await node.borrow(h.client, 'r2', 30); // insufficient tenant
  node.tryAdmit(10);
  await node.reportConsumption(h.client, 'rep1');
  const intent = node.prepareReturn('ret1')!;
  await node.submitReturn(h.client, intent);
  const kinds = new Set(h.coordinator.records().map((r) => r.kind));
  assert.ok(kinds.has('borrow_granted'));
  assert.ok(kinds.has('borrow_rejected'));
  assert.ok(kinds.has('consume'));
  assert.ok(kinds.has('return_accepted'));
});

test('a restarted node reusing a request id gets a fresh decision', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  assert.equal((await node.borrow(h.client, 'same-id', 20)).ok, true);
  node.reboot();
  const second = await node.borrow(h.client, 'same-id', 20);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, false);
  assert.notEqual(node.currentLease()?.leaseId, undefined);
  // Both leases are independently reserved.
  assert.equal(h.coordinator.available('A').tenant, 20);
});

test('a rejected return leaves the frozen units inadmissible (no double spend)', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(10);
  const intent = node.prepareReturn('ret1')!;
  // Send it in the next window: refused, nothing credited.
  h.trueClock.set(WINDOW + 10);
  const confirm = await node.submitReturn(h.client, intent);
  assert.equal(confirm.accepted, false);
  // Back in a safe instant of window 0 is impossible now, but local state must
  // still refuse the frozen units forever, even after the rejection.
  assert.equal(node.tryAdmit(1, { at: 200 }).ok, false);
  assert.equal(node.localRemaining(), 0);
});

test('a return after lease expiry but inside the same window is still accepted', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  const lease = node.currentLease()!;
  // Jump past the lease expiry (but not past the window).
  const lateButInside = lease.expiresAt + 1;
  assert.ok(lateButInside < lease.windowEnd);
  h.trueClock.set(lateButInside);
  assert.equal(node.tryAdmit(1).ok, false);
  // A return is a window-level operation, not an admission: the unspent
  // remainder of an expired lease can still be handed back inside its window.
  const intent = node.prepareReturn('ret1');
  assert.ok(intent, 'should be able to return the unspent remainder of an expired lease');
  const confirm = await node.submitReturn(h.client, intent);
  assert.equal(confirm.accepted, true);
  assert.equal(confirm.credited, 40);
  // Returning the whole lease releases the whole reservation for this window.
  assert.deepEqual(h.coordinator.available('A'), { global: 100, tenant: 60 });
});

test('consumption reported after a full return is refused, not double-counted', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(10);
  // Report the real 10 before returning, so the lease is fully accounted.
  await node.reportConsumption(h.client, 'rep-real');
  const intent = node.prepareReturn('ret1')!;
  assert.equal(intent.amount, 30);
  assert.equal((await node.submitReturn(h.client, intent)).accepted, true);

  // A stale extra entry trying to consume from the returned part must fail:
  // reported 10 + returned 30 already equals the lease amount of 40.
  const forgedReport = {
    type: 'consume.report' as const,
    reportId: 'forged',
    nodeId: 'n1',
    generation: 1,
    sentAt: 100,
    entries: [
      {
        seq: 99,
        nodeId: 'n1',
        generation: 1,
        leaseId: intent.leaseId,
        tenantId: 'A',
        windowIndex: 0,
        cost: 10,
        at: 100,
      },
    ],
  };
  const ack = h.coordinator.handleConsumeReport(forgedReport);
  assert.deepEqual(ack.accepted, []);
  assert.equal(ack.rejected[0]?.reason, 'lease_exhausted');
  assert.equal(h.coordinator.windowSnapshot(0).globalConsumed, 10);
});

test('a lease from a different node is not installed locally', () => {
  const h = harness();
  const node = makeNode(h, 'n1', 'A');
  const outcome = node.acceptGrant({
    leaseId: 'foreign',
    fence: 1,
    nodeId: 'someone-else',
    generation: 1,
    tenantId: 'A',
    amount: 10,
    windowIndex: 0,
    windowStart: 0,
    windowEnd: WINDOW,
    issuedAt: 0,
    expiresAt: 100,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'wrong_node');
});

test('window arithmetic is integer-exact at the boundaries', () => {
  const h = harness();
  h.trueClock.set(WINDOW - 1);
  assert.equal(h.coordinator.currentWindow(), 0);
  h.trueClock.set(WINDOW);
  assert.equal(h.coordinator.currentWindow(), 1);
  h.trueClock.set(2 * WINDOW + 1);
  assert.equal(h.coordinator.currentWindow(), 2);
});

test('confirmed consumption stays within the window budget and does not free quota', async () => {
  const h = harness();
  h.trueClock.set(100);
  const node = makeNode(h, 'n1', 'A');
  await node.borrow(h.client, 'r1', 40);
  node.tryAdmit(40);
  await node.reportConsumption(h.client, 'rep1');
  const snapshot = h.coordinator.windowSnapshot(0);
  // The window stays fully committed: consumed quota was really used.
  assert.equal(snapshot.globalReserved, 40);
  assert.equal(snapshot.globalConsumed, 40);
  assert.equal(snapshot.globalOutstanding, 0);
  assert.equal(snapshot.globalAvailable, 60);
  assert.equal(snapshot.tenantAvailable.A, 20);
  // A second borrow still sees only the unconsumed remainder.
  assert.equal((await node.borrow(h.client, 'r2', 21)).ok, false);
  assert.equal((await node.borrow(h.client, 'r3', 20)).ok, true);
});

test('construction validates the skew/window relationship', () => {
  assert.throws(
    () =>
      new Coordinator({
        clock: new ManualClock(0),
        windowMs: 41,
        skewMs: 10,
        globalLimitPerWindow: 10,
        tenantLimitsPerWindow: { A: 10 },
      }),
    /windowMs must be greater/,
  );
});
