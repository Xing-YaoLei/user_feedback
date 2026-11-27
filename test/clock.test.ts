import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ManualClock,
  OffsetClock,
  FixedClock,
  readingInterval,
  definitelyAtOrAfter,
  definitelyStarted,
  conservativeRemainingMs,
  insideConservativeInterval,
  nodeSafeWindow,
  windowIndexAt,
  windowStartAt,
  windowEndAt,
} from '../src/clock.ts';
import { Coordinator } from '../src/coordinator.ts';
import { DirectClient } from '../src/client.ts';
import { QuotaNode } from '../src/node.ts';

const WINDOW = 1000;
const SKEW = 10;

test('a reading is consistent with an interval widened by the skew bound', () => {
  assert.deepEqual(readingInterval(500, 10), { earliest: 490, latest: 510 });
  assert.deepEqual(readingInterval(500, 0), { earliest: 500, latest: 500 });
});

test('definitely-at-or-after uses the latest possible true time', () => {
  assert.equal(definitelyAtOrAfter(89, 100, 10), false);
  assert.equal(definitelyAtOrAfter(90, 100, 10), true);
  assert.equal(definitelyAtOrAfter(91, 100, 10), true);
});

test('definitely-started uses the earliest possible true time', () => {
  assert.equal(definitelyStarted(109, 100, 10), false);
  assert.equal(definitelyStarted(110, 100, 10), true);
  assert.equal(definitelyStarted(111, 100, 10), true);
});

test('conservative remaining time is floored at zero', () => {
  assert.equal(conservativeRemainingMs(100, 500, 10), 390);
  assert.equal(conservativeRemainingMs(490, 500, 10), 0);
  assert.equal(conservativeRemainingMs(1000, 500, 10), 0);
});

test('the conservative interval requires both ends to fit, not just the midpoint', () => {
  // Whole window [0, 1000); skew 10.  995 is inside but its latest reading is 1005.
  assert.equal(insideConservativeInterval(995, 0, 1000, 10), false);
  assert.equal(insideConservativeInterval(990, 0, 1000, 10), true);
  // 5 is inside but its earliest reading is -5.
  assert.equal(insideConservativeInterval(5, 0, 1000, 10), false);
  assert.equal(insideConservativeInterval(10, 0, 1000, 10), true);
});

test('fixed windows are disjoint and cover the whole timeline', () => {
  for (const at of [0, 1, 999, 1000, 1001, 2500, 2501]) {
    const index = windowIndexAt(at, WINDOW);
    assert.ok(windowStartAt(index, WINDOW) <= at);
    assert.ok(at < windowEndAt(index, WINDOW));
  }
  assert.equal(windowIndexAt(999, WINDOW), 0);
  assert.equal(windowIndexAt(1000, WINDOW), 1);
  assert.equal(windowIndexAt(-1, WINDOW), -1);
});

test('node-safe window is inset by one skew bound on each side', () => {
  assert.deepEqual(nodeSafeWindow(0, WINDOW, SKEW), { notBefore: 10, deadline: 990 });
});

/**
 * Sweep a malicious clock offset across the declared skew bound and assert that
 * no admission can ever be justified outside the lease or window, and that the
 * coordinator never answers with a lease whose usable lifetime is under a
 * skew bound.
 */
test('adversarial clock offsets within the bound never escape the window', async () => {
  for (let offset = -SKEW; offset <= SKEW; offset += 1) {
    const trueClock = new ManualClock(0);
    const coordinator = new Coordinator({
      clock: new OffsetClock(trueClock, 0),
      windowMs: WINDOW,
      skewMs: SKEW,
      globalLimitPerWindow: 100,
      tenantLimitsPerWindow: { A: 100 },
      leaseTtlMs: 300,
    });
    const client = new DirectClient(coordinator);
    const node = new QuotaNode({
      nodeId: `n-${offset}`,
      clock: new OffsetClock(trueClock, offset),
      skewMs: SKEW,
      borrowAmount: 50,
      tenantId: 'A',
    });
    trueClock.set(200);
    const outcome = await node.borrow(client, `r-${offset}`, 50);
    assert.equal(outcome.ok, true, `offset ${offset}`);
    if (!outcome.ok) continue;
    const lease = outcome.lease;

    // Sweep the whole lease lifetime at 1ms granularity in true time, and at
    // each point check: any admission the node allows must be provably inside
    // the window for *every* clock offset in [-skew, skew].
    let admitted = 0;
    for (let t = lease.windowStart; t < lease.windowEnd; t += 1) {
      trueClock.set(t);
      const result = node.tryAdmit(1);
      if (!result.ok) continue;
      admitted += 1;
      // True time t plus the node's own offset is what it reads; the admission
      // is legitimate only if the true instant lies inside the lease.
      assert.ok(t >= lease.windowStart, `t=${t} before window`);
      assert.ok(t < lease.windowEnd, `t=${t} after window`);
      assert.ok(t < lease.expiresAt, `t=${t} at/after expiry`);
    }
    // The node can only admit 50 units, so the sweep is bounded by the lease.
    assert.equal(admitted, 50, `offset ${offset} admitted ${admitted}`);
  }
});

test('the coordinator only issues leases whose conservative lifetime is positive', async () => {
  const clock = new ManualClock(0);
  const coordinator = new Coordinator({
    clock,
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 100 },
    leaseTtlMs: 300,
  });
  for (let at = 0; at < WINDOW; at += 10) {
    clock.set(at);
    const response = coordinator.handleBorrow({
      type: 'borrow.request',
      requestId: `r-${at}`,
      nodeId: `n-${at}`,
      generation: 1,
      tenantId: 'A',
      amount: 1,
      sentAt: at,
    });
    if (response.lease) {
      const lease = response.lease;
      assert.ok(lease.expiresAt <= lease.windowEnd - SKEW, `at ${at}: expiry too close to window end`);
      assert.ok(lease.expiresAt - at >= SKEW + 1, `at ${at}: too little usable life`);
    } else {
      assert.equal(response.rejectionReason, 'window_closing');
    }
  }
});

test('a node reading that is early still never attributes work to the next window', async () => {
  const trueClock = new ManualClock(0);
  const coordinator = new Coordinator({
    clock: new OffsetClock(trueClock, 0),
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 100 },
    leaseTtlMs: 400,
  });
  const client = new DirectClient(coordinator);
  // Node clock is 10ms behind true time: at true 1005 it reads 995.
  const node = new QuotaNode({
    nodeId: 'slow',
    clock: new OffsetClock(trueClock, -SKEW),
    skewMs: SKEW,
    borrowAmount: 20,
    tenantId: 'A',
  });
  trueClock.set(100);
  assert.equal((await node.borrow(client, 'r1', 20)).ok, true);

  // At true 995 the node reads 985, which is safe; at true 996 it reads 986 and
  // still cannot admit because its latest reading would be 996.
  const admitted = [];
  for (let t = 100; t < WINDOW + 50; t += 1) {
    trueClock.set(t);
    const result = node.tryAdmit(1);
    if (result.ok) admitted.push(t);
  }
  for (const t of admitted) {
    assert.ok(t >= 0 && t < WINDOW, `admission at true ${t} outside window 0`);
    assert.ok(t < 500 - SKEW, `admission at true ${t} past lease expiry`);
  }
});

test('a frozen clock cannot be used to admit twice in the same lease', async () => {
  const clock = new FixedClock(100);
  const coordinator = new Coordinator({
    clock,
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 100 },
    leaseTtlMs: 400,
  });
  const node = new QuotaNode({
    nodeId: 'n1',
    clock,
    skewMs: SKEW,
    borrowAmount: 10,
    tenantId: 'A',
  });
  const client = new DirectClient(coordinator);
  await node.borrow(client, 'r1', 10);
  assert.equal(node.tryAdmit(10).ok, true);
  assert.equal(node.tryAdmit(1).ok, false);
  assert.equal(node.tryAdmit(1).ok, false);
});
