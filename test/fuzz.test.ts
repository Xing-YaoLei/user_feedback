import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ManualClock } from '../src/clock.ts';
import { Coordinator } from '../src/coordinator.ts';
import { SimulatedClient } from '../src/client.ts';
import { QuotaNode } from '../src/node.ts';
import { SimulatedNetwork, mulberry32 } from '../src/network.ts';
import type { ReturnConfirm, WireMessage } from '../src/protocol.ts';
import { checkBudget, type BudgetReport } from '../src/sim.ts';

const WINDOW_MS = 1000;
const SKEW_MS = 10;
const GLOBAL_LIMIT = 90;
const TENANTS = { A: 40, B: 30, C: 25 } as const;

interface FuzzNode {
  node: QuotaNode;
  client: SimulatedClient;
  tenant: string;
}

/**
 * A seeded fuzz driver: random borrows, local admits, returns, restarts, and
 * partition windows, all delivered through a lossy, duplicating, jittery
 * network.  Retries reuse request ids exactly as a real caller would.
 */
async function fuzz(seed: number, rounds: number): Promise<void> {
  const random = mulberry32(seed);
  const trueClock = new ManualClock(0);
  const coordinator = new Coordinator({
    clock: trueClock,
    windowMs: WINDOW_MS,
    skewMs: SKEW_MS,
    globalLimitPerWindow: GLOBAL_LIMIT,
    tenantLimitsPerWindow: TENANTS,
    leaseTtlMs: 300,
  });
  const network = new SimulatedNetwork({
    coordinator,
    trueClock,
    policy: {
      latencyMs: () => 1 + Math.floor(random() * 30),
      copies: () => (random() < 0.25 ? 2 : 1),
      drop: () => random() < 0.1,
    },
  });

  const names = ['n0', 'n1', 'n2', 'n3'];
  const tenantOf = (i: number) => ['A', 'B', 'C', 'A'][i] as keyof typeof TENANTS;
  const nodes: FuzzNode[] = names.map((nodeId, i) => {
    const node = new QuotaNode({
      nodeId,
      clock: network.clockFor(nodeId, Math.floor(random() * (2 * SKEW_MS + 1)) - SKEW_MS),
      skewMs: SKEW_MS,
      borrowAmount: 20,
      tenantId: tenantOf(i),
    });
    const client = new SimulatedClient(network, node);
    network.registerNode(client);
    return { node, client, tenant: tenantOf(i) };
  });

  const settle = async <T>(tracked: { done: boolean; value?: T }, budgetMs: number): Promise<T | undefined> => {
    const deadline = network.now + budgetMs;
    await new Promise((resolve) => setImmediate(resolve));
    while (!tracked.done && network.now < deadline) {
      network.advanceBy(1);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return tracked.value;
  };
  const track = <T>(promise: Promise<T>): { done: boolean; value?: T } => {
    const state: { done: boolean; value?: T } = { done: false };
    promise.then((value) => {
      state.done = true;
      state.value = value;
    });
    return state;
  };

  const requestSeq = new Map<string, number>();
  const nextRequestId = (nodeId: string) => {
    const n = (requestSeq.get(nodeId) ?? 0) + 1;
    requestSeq.set(nodeId, n);
    return `${nodeId}-req-${n}`;
  };
  const pendingReturns = new Map<string, ReturnConfirm>();

  for (let round = 0; round < rounds; round += 1) {
    // Randomly partition / heal nodes.
    for (const { node } of nodes) {
      if (random() < 0.12) {
        if (network.isOffline(node.nodeId)) network.heal(node.nodeId);
        else network.partition(node.nodeId);
      }
    }

    const target = nodes[Math.floor(random() * nodes.length)];
    const roll = random();

    if (roll < 0.3) {
      // Borrow (retry if a previous attempt for this id is still in flight).
      const id = nextRequestId(target.node.nodeId);
      const amount = [10, 15, 20][Math.floor(random() * 3)]!;
      const first = track(target.node.borrow(target.client, id, amount));
      await settle(first, 60);
      if (!first.done) {
        // Retry the same id, as a caller would after a timeout.
        const retry = track(target.node.borrow(target.client, id, amount));
        await settle(retry, 80);
      }
    } else if (roll < 0.72) {
      // Local admissions, cost 1..5.
      const cost = 1 + Math.floor(random() * 5);
      target.node.tryAdmit(cost);
      if (random() < 0.5) target.node.tryAdmit(cost);
    } else if (roll < 0.9) {
      // Freeze and return the remainder, retrying the same id on timeout.
      const id = `ret-${target.node.nodeId}-${round}`;
      const intent = target.node.prepareReturn(id);
      if (intent) {
        const first = track(target.node.submitReturn(target.client, intent));
        const confirm = await settle(first, 60);
        if (confirm) pendingReturns.set(id, confirm);
        else {
          const retry = track(target.node.submitReturn(target.client, intent));
          const late = await settle(retry, 80);
          if (late) pendingReturns.set(id, late);
        }
      }
    } else {
      // Restart: new generation abandons the lease; replay durable returns.
      target.node.reboot();
      const replay = track(target.node.replayReturns(target.client));
      await settle(replay, 60);
    }

    // Occasionally nudge time forward; cross windows regularly.
    if (random() < 0.35) network.advanceBy(10 + Math.floor(random() * 60));
    await new Promise((resolve) => setImmediate(resolve));
  }

  // Let everything in flight finish before judging.
  for (let i = 0; i < 40; i += 1) {
    network.advanceBy(20);
    await new Promise((resolve) => setImmediate(resolve));
  }

  // ---- Invariants -------------------------------------------------------

  const admissions = nodes.flatMap(({ node }) =>
    node.allAdmissions().map((record) => ({ ...record, nodeId: node.nodeId })),
  );

  const byWindow = new Map<number, { total: number; tenants: Record<string, number> }>();
  for (const record of admissions) {
    const bucket = byWindow.get(record.windowIndex) ?? { total: 0, tenants: {} };
    byWindow.set(record.windowIndex, bucket);
    bucket.total += record.cost;
    bucket.tenants[record.tenantId] = (bucket.tenants[record.tenantId] ?? 0) + record.cost;
  }
  const budget: BudgetReport = {
    admissions,
    windows: [...byWindow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([windowIndex, bucket]) => ({
        windowIndex,
        total: bucket.total,
        tenants: bucket.tenants,
        entries: 0,
      })),
  };
  assert.deepEqual(
    checkBudget(budget, { globalLimitPerWindow: GLOBAL_LIMIT, tenantLimitsPerWindow: TENANTS }),
    [],
    `seed ${seed}: budget violation`,
  );

  // No lease may have consumption + returns beyond its amount.
  for (const leaseId of coordinator.leaseIds()) {
    const summary = coordinator.leaseSummary(leaseId)!;
    assert.ok(
      summary.reportedConsumed + summary.creditedReturns <= summary.amount,
      `seed ${seed}: lease ${leaseId} over-accounted`,
    );
    assert.ok(summary.outstanding >= 0, `seed ${seed}: lease ${leaseId} negative outstanding`);
  }

  // Each admitted record's attributed window must match the lease it names.
  for (const record of coordinator.recordsOfKind('consume')) {
    const lease = coordinator.leaseGrant(record.leaseId);
    if (lease) {
      assert.equal(record.windowIndex, lease.windowIndex, `seed ${seed}: consume window drifted`);
      assert.ok(record.consumedAt >= lease.windowStart - SKEW_MS, `seed ${seed}: consume before window`);
      assert.ok(record.consumedAt < lease.windowEnd + SKEW_MS, `seed ${seed}: consume after window`);
    }
  }

  // Coordinator-reported consumption never exceeds real admission totals.
  for (const windowIndex of coordinator.knownWindows()) {
    const snapshot = coordinator.windowSnapshot(windowIndex);
    const real = byWindow.get(windowIndex);
    for (const [tenant, consumed] of Object.entries(snapshot.tenantConsumed)) {
      assert.ok(
        consumed <= (real?.tenants[tenant] ?? 0),
        `seed ${seed}: window ${windowIndex} tenant ${tenant} reported ${consumed} > real`,
      );
    }
    // Committed quota never exceeds the window budget, in either dimension.
    assert.ok(
      snapshot.globalReserved <= GLOBAL_LIMIT,
      `seed ${seed}: window ${windowIndex} committed ${snapshot.globalReserved} > ${GLOBAL_LIMIT}`,
    );
    assert.ok(snapshot.globalAvailable >= 0, `seed ${seed}: window ${windowIndex} negative availability`);
    for (const [tenant, reserved] of Object.entries(snapshot.tenantReserved)) {
      const limit = TENANTS[tenant as keyof typeof TENANTS];
      assert.ok(
        reserved <= limit,
        `seed ${seed}: window ${windowIndex} tenant ${tenant} committed ${reserved} > ${limit}`,
      );
    }
    // Consumption never exceeds committed quota.
    assert.ok(
      snapshot.globalConsumed <= snapshot.globalReserved,
      `seed ${seed}: window ${windowIndex} consumed ${snapshot.globalConsumed} > committed`,
    );
  }

  // At most one accepted credit per return id, and every accepted credit is
  // exactly what the confirm said.
  const creditsByReturn = new Map<string, number[]>();
  for (const record of coordinator.recordsOfKind('return_accepted')) {
    const list = creditsByReturn.get(record.returnId) ?? [];
    list.push(record.credited);
    creditsByReturn.set(record.returnId, list);
  }
  for (const [returnId, credits] of creditsByReturn) {
    assert.equal(credits.length, 1, `seed ${seed}: return ${returnId} credited ${credits.length} times`);
    const confirm = pendingReturns.get(returnId);
    if (confirm) assert.equal(credits[0], confirm.credited);
  }
}

test('fuzz: seeded random schedules never overspend any budget', async () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21]) {
    await fuzz(seed, 160);
  }
});

test('fuzz: a hostile clock offset near the skew bound is still safe', async () => {
  // Every node runs at the maximum permitted offset in the worst direction.
  const trueClock = new ManualClock(0);
  const coordinator = new Coordinator({
    clock: trueClock,
    windowMs: WINDOW_MS,
    skewMs: SKEW_MS,
    globalLimitPerWindow: 40,
    tenantLimitsPerWindow: { A: 40 },
    leaseTtlMs: 400,
  });
  const network = new SimulatedNetwork({
    coordinator,
    trueClock,
    policy: { latencyMs: () => 5, copies: () => (Math.random() < 0 ? 2 : 1) },
  });
  const fast = new QuotaNode({
    nodeId: 'fast',
    clock: network.clockFor('fast', SKEW_MS),
    skewMs: SKEW_MS,
    borrowAmount: 20,
    tenantId: 'A',
  });
  const slow = new QuotaNode({
    nodeId: 'slow',
    clock: network.clockFor('slow', -SKEW_MS),
    skewMs: SKEW_MS,
    borrowAmount: 20,
    tenantId: 'A',
  });
  const fastClient = new SimulatedClient(network, fast);
  const slowClient = new SimulatedClient(network, slow);
  network.registerNode(fastClient);
  network.registerNode(slowClient);

  const track = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ done: true as const, value }),
      () => ({ done: true as const, value: undefined }),
    );
  const borrows = [track(fast.borrow(fastClient, 'f1', 20)), track(slow.borrow(slowClient, 's1', 20))];
  network.advanceTo(200);
  await Promise.all(borrows);

  // Both nodes consume as much as they can, whenever they think it is safe.
  for (let t = 0; t < WINDOW_MS; t += 1) {
    trueClock.set(t);
    fast.tryAdmit(1);
    slow.tryAdmit(1);
  }
  const total = [...fast.allAdmissions(), ...slow.allAdmissions()].reduce((s, r) => s + r.cost, 0);
  assert.ok(total <= 40, `admitted ${total} > 40`);
  assert.ok(total > 0, 'expected some admissions');

  // Every admission must lie inside window 0 in true time.
  for (const record of [...fast.allAdmissions(), ...slow.allAdmissions()]) {
    assert.equal(record.windowIndex, 0);
    assert.ok(record.at >= 0 && record.at < WINDOW_MS, `record at ${record.at} outside window`);
  }
});

test('fuzz: no message type is silently dropped from the network log', async () => {
  const trueClock = new ManualClock(0);
  const coordinator = new Coordinator({
    clock: trueClock,
    windowMs: WINDOW_MS,
    skewMs: SKEW_MS,
    globalLimitPerWindow: 50,
    tenantLimitsPerWindow: { A: 50 },
  });
  const network = new SimulatedNetwork({
    coordinator,
    trueClock,
    policy: { latencyMs: () => 5, drop: (m: WireMessage) => m.type === 'consume.report' },
  });
  const node = new QuotaNode({
    nodeId: 'n1',
    clock: trueClock,
    skewMs: SKEW_MS,
    borrowAmount: 20,
    tenantId: 'A',
  });
  const client = new SimulatedClient(network, node);
  network.registerNode(client);
  await new Promise<void>((resolve) => {
    node.borrow(client, 'r1', 20).then(() => resolve());
    network.advanceTo(100);
    setImmediate(() => setImmediate(resolve));
  });
  node.tryAdmit(5);
  void node.reportConsumption(client, 'rep-drop');
  network.advanceTo(200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(network.log.some((entry) => entry.outcome === 'dropped'));
  assert.equal(coordinator.recordsOfKind('consume').length, 0);
});
