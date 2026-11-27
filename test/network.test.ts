import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ManualClock } from '../src/clock.ts';
import { Coordinator } from '../src/coordinator.ts';
import { SimulatedClient } from '../src/client.ts';
import { QuotaNode } from '../src/node.ts';
import { SimulatedNetwork, uniformPolicy, type DeliveryPolicy } from '../src/network.ts';
import type { BorrowRequest, ReturnConfirm, ReturnIntent, WireMessage } from '../src/protocol.ts';
import { runTransferScenario, SKEW_MS, GLOBAL_LIMIT, TENANT_LIMITS } from '../src/scenario.ts';
import { checkBudget, Simulation } from '../src/sim.ts';

const WINDOW = 1000;
const SKEW = 10;

function fixed(latencyMs: number, overrides: Partial<DeliveryPolicy> = {}): DeliveryPolicy {
  return { latencyMs: () => latencyMs, ...overrides };
}

interface Rig {
  network: SimulatedNetwork;
  coordinator: Coordinator;
  trueClock: ManualClock;
  addNode(nodeId: string, tenantId: string, offsetMs?: number, amount?: number): {
    node: QuotaNode;
    client: SimulatedClient;
  };
}

function rig(policy: DeliveryPolicy, start = 0): Rig {
  const trueClock = new ManualClock(start);
  const coordinator = new Coordinator({
    clock: trueClock,
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 60, B: 60 },
    leaseTtlMs: 400,
  });
  const network = new SimulatedNetwork({ coordinator, policy, trueClock });
  return {
    network,
    coordinator,
    trueClock,
    addNode(nodeId, tenantId, offsetMs = 0, amount = 40) {
      const node = new QuotaNode({
        nodeId,
        clock: network.clockFor(nodeId, offsetMs),
        skewMs: SKEW,
        borrowAmount: amount,
        tenantId,
      });
      const client = new SimulatedClient(network, node);
      network.registerNode(client);
      return { node, client };
    },
  };
}

async function settle<T>(
  network: SimulatedNetwork,
  tracked: { done: boolean; value?: T },
  budgetMs = 500,
): Promise<T | undefined> {
  const deadline = network.now + budgetMs;
  await new Promise((resolve) => setImmediate(resolve));
  while (!tracked.done && network.now < deadline) {
    network.advanceBy(1);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return tracked.value;
}

function track<T>(promise: Promise<T>): { done: boolean; value?: T } {
  const state: { done: boolean; value?: T } = { done: false };
  promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

test('a delivered borrow grants quota and the node admits locally', async () => {
  const r = rig(fixed(10), 100);
  const { node, client } = r.addNode('n1', 'A');
  const tracked = track(node.borrow(client, 'r1', 30));
  const outcome = await settle(r.network, tracked);
  assert.ok(outcome?.ok);
  assert.equal(node.localRemaining(), 30);
  assert.equal(node.tryAdmit(10).ok, true);
  assert.deepEqual(r.coordinator.available('A'), { global: 70, tenant: 30 });
});

test('a dropped borrow request is never answered and reserves nothing', async () => {
  let dropped = false;
  const r = rig({
    latencyMs: () => 10,
    drop: (message: WireMessage) => {
      if (message.type === 'borrow.request' && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    },
  }, 100);
  const { node, client } = r.addNode('n1', 'A');
  const tracked = track(node.borrow(client, 'r1', 30));
  const outcome = await settle(r.network, tracked, 200);
  assert.equal(outcome, undefined);
  assert.equal(node.localRemaining(), 0);
  assert.deepEqual(r.coordinator.available('A'), { global: 100, tenant: 60 });
});

test('a retry with the same request id succeeds after a drop and reserves exactly once', async () => {
  let dropNext = true;
  const r = rig({
    latencyMs: () => 10,
    drop: (message: WireMessage) => {
      if (message.type === 'borrow.request' && dropNext) {
        dropNext = false;
        return true;
      }
      return false;
    },
  }, 100);
  const { node, client } = r.addNode('n1', 'A');
  const first = track(node.borrow(client, 'r1', 30));
  await settle(r.network, first, 100);
  assert.equal(first.done, false);

  // Retry uses the same id: the coordinator must still grant exactly once.
  const retried = track(node.borrow(client, 'r1', 30));
  const outcome = await settle(r.network, retried);
  assert.ok(outcome?.ok);
  assert.equal(r.coordinator.available('A').tenant, 30);
  assert.equal(node.localRemaining(), 30);
});

test('duplicated coordinator replies do not hand out quota twice', async () => {
  const r = rig(fixed(10, { copies: (m) => (m.type === 'borrow.response' ? 3 : 1) }), 100);
  const { node, client } = r.addNode('n1', 'A');
  const tracked = track(node.borrow(client, 'r1', 30));
  await settle(r.network, tracked);
  node.tryAdmit(5);
  // Let any remaining duplicate copies arrive.
  await settle(r.network, { done: false }, 100);
  assert.equal(node.localRemaining(), 25);
  assert.equal(r.coordinator.available('A').tenant, 30);
});

test('a partitioned node cannot borrow but keeps admitting from an existing lease', async () => {
  const r = rig(fixed(10), 100);
  const { node, client } = r.addNode('n1', 'A');
  const tracked = track(node.borrow(client, 'r1', 40));
  await settle(r.network, tracked);
  r.network.partition('n1');
  // Local admission is purely synchronous and unaffected.
  assert.equal(node.tryAdmit(10).ok, true);
  assert.equal(node.tryAdmit(10).ok, true);
  // A further borrow cannot get through.
  const blocked = track(node.borrow(client, 'r2', 10));
  await settle(r.network, blocked, 100);
  assert.equal(blocked.done, false);
  assert.equal(node.localRemaining(), 20);
});

test('out-of-order duplicated returns credit the lease exactly once', async () => {
  let copy = 0;
  const r = rig({
    latencyMs: () => {
      copy += 1;
      // First copy slow, second copy fast: they arrive out of order.
      return copy === 1 ? 40 : 10;
    },
    copies: (m) => (m.type === 'return.intent' ? 2 : 1),
  }, 100);
  const { node, client } = r.addNode('n1', 'A');
  const borrow = track(node.borrow(client, 'r1', 40));
  await settle(r.network, borrow);
  node.tryAdmit(10);
  const intent = node.prepareReturn('ret1')!;
  const returned = track(node.submitReturn(client, intent));
  const confirm = (await settle(r.network, returned)) as ReturnConfirm;
  assert.equal(confirm.accepted, true);
  assert.equal(confirm.credited, 30);
  assert.equal(confirm.duplicate ?? false, false);
  // Let the second (slower) copy land too.
  await settle(r.network, { done: false }, 100);
  assert.deepEqual(r.coordinator.available('A'), { global: 90, tenant: 50 });
  const credits = r.coordinator
    .recordsOfKind('return_accepted')
    .filter((record) => record.returnId === 'ret1')
    .map((record) => record.credited);
  assert.deepEqual(credits, [30]);
});

test('uniform policy with drops, duplicates, and jitter still never over-consumes', async () => {
  for (const seed of [1, 7, 99]) {
    const r = rig(
      uniformPolicy({ minLatencyMs: 1, maxLatencyMs: 25, dropRate: 0.12, duplicateRate: 0.25, seed }),
      50,
    );
    const a = r.addNode('a', 'A', -5, 30);
    const b = r.addNode('b', 'B', 4, 30);
    // Borrow a few times with retries; dropped requests simply stay pending.
    for (let i = 0; i < 6; i += 1) {
      const ta = track(a.node.borrow(a.client, `a-${i}`, 15));
      const tb = track(b.node.borrow(b.client, `b-${i}`, 15));
      await settle(r.network, ta, 60);
      await settle(r.network, tb, 60);
      // Actually consume whatever lease is held.
      if (a.node.currentLease()) a.node.tryAdmit(Math.min(5, a.node.localRemaining()));
      if (b.node.currentLease()) b.node.tryAdmit(Math.min(5, b.node.localRemaining()));
    }
    await settle(r.network, { done: false }, 100);

    const admissions = [...a.node.allAdmissions(), ...b.node.allAdmissions()];
    const byWindow = new Map<number, { total: number; tenants: Record<string, number> }>();
    for (const entry of admissions) {
      const bucket = byWindow.get(entry.windowIndex) ?? { total: 0, tenants: {} };
      byWindow.set(entry.windowIndex, bucket);
      bucket.total += entry.cost;
      bucket.tenants[entry.tenantId] = (bucket.tenants[entry.tenantId] ?? 0) + entry.cost;
    }
    const violations = checkBudget(
      {
        admissions: admissions.map((entry) => ({ ...entry, nodeId: 'x' })),
        windows: [...byWindow.entries()].map(([windowIndex, bucket]) => ({
          windowIndex,
          total: bucket.total,
          tenants: bucket.tenants,
          entries: 0,
        })),
      },
      { globalLimitPerWindow: 100, tenantLimitsPerWindow: { A: 60, B: 60 } },
    );
    assert.deepEqual(violations, [], `seed ${seed}`);
  }
});

test('a late old-window return is refused after the window switch', async () => {
  const r = rig(fixed(10), 100);
  const { node, client } = r.addNode('n1', 'A');
  const borrow = track(node.borrow(client, 'r1', 40));
  await settle(r.network, borrow);
  node.tryAdmit(10);
  const intent = node.prepareReturn('ret1')!;
  // Do not send it yet; advance to the next window, then send.
  r.network.advanceTo(WINDOW + 50);
  const returned = track(node.submitReturn(client, intent));
  const confirm = (await settle(r.network, returned)) as ReturnConfirm;
  assert.equal(confirm.accepted, false);
  assert.equal(confirm.reason, 'stale_window');
  assert.equal(confirm.credited, 0);
  assert.deepEqual(r.coordinator.available('A'), { global: 100, tenant: 60 });
});

test('the simulation scenario is deterministic across runs', async () => {
  const one = await runTransferScenario();
  const two = await runTransferScenario();
  assert.deepEqual(one.facts, two.facts);
  assert.deepEqual(one.budgetViolations, []);
  assert.equal(one.budgetViolations.length, 0);
});

test('scenario: quota really moves from alpha to gamma after recovery', async () => {
  const result = await runTransferScenario();
  const f = result.facts;
  assert.equal(f.alphaReturnCredits.length, 1);
  assert.equal(f.alphaReturnCredits[0], 20);
  assert.deepEqual(f.duplicateConfirmIds, ['alpha-ret-1']);
  // Same units under a fresh id must be refused.
  assert.equal(f.repeatedUnitsReason, 'exceeds_lease');
  // 60 - 40 = 20 available; gamma took 20, so it is exhausted.
  assert.equal(f.availableAAfterReturn, 20);
  assert.equal(f.availableAAfterRedistribution, 0);
});

test('scenario: the stop boundary matches the ledger', async () => {
  const { facts } = await runTransferScenario();
  assert.deepEqual(facts.alphaReturnBoundary, { amount: 20, frozenFromSeq: 2, consumedAtBoundary: 20 });
  assert.deepEqual(facts.alphaG1Lease, {
    amount: 40,
    reportedConsumed: 20,
    creditedReturns: 20,
    outstanding: 0,
  });
});

test('scenario: a duplicate grant does not change local quota', async () => {
  const { facts } = await runTransferScenario();
  assert.equal(facts.alphaGen2RemainingAfterDuplicate, 15);
  assert.equal(facts.alphaGen2RemainingAfterAdmits, 5);
});

test('scenario: old-window quota is void in the new window', async () => {
  const { facts } = await runTransferScenario();
  assert.equal(facts.availableABeforeStaleReturn, facts.availableAWindow1AfterStaleReturn);
  assert.deepEqual(facts.staleReturnReasons, [
    { returnId: 'gamma-ret-1', reason: 'stale_window', credited: 0 },
  ]);
  assert.deepEqual(facts.lateBorrowReasons, [
    { requestId: 'alpha-g1-late', reason: 'stale_generation' },
  ]);
});

test('scenario: dead residue keeps occupying window 0 only', async () => {
  const { facts } = await runTransferScenario();
  // delta took 10, consumed 5, never returned: the whole 10 stays reserved in
  // window 0 even though only 5 was consumed, because the remainder is
  // unconfirmed.  Reporting consumption does not release a reservation; only
  // an accepted return does.
  assert.deepEqual(facts.deltaG1Lease, {
    amount: 10,
    reportedConsumed: 5,
    creditedReturns: 0,
    outstanding: 5,
  });
  // Window-0 tenant B committed quota is beta's lease (10, fully consumed and
  // never returned) plus delta's dead lease (10, 5 consumed).
  assert.equal(facts.window0BReserved, 20);
  assert.equal(facts.window0BReportedConsumed, 15);
  // Nothing of the dead lease is carried into window 1.  Window-1 tenant-B
  // reservation is exactly delta's new-generation lease (15).
  assert.equal(facts.window1BReserved, 15);
});

test('scenario: real admissions stay within every budget, and reports reconcile', async () => {
  const result = await runTransferScenario();
  assert.deepEqual(result.budgetViolations, []);
  for (const window of result.budget.windows) {
    assert.ok(window.total <= GLOBAL_LIMIT, `window ${window.windowIndex} total`);
    for (const [tenant, consumed] of Object.entries(window.tenants)) {
      const limit = TENANT_LIMITS[tenant as keyof typeof TENANT_LIMITS];
      assert.ok(consumed <= limit, `window ${window.windowIndex} tenant ${tenant}`);
    }
  }
  // Coordinator accounting must never exceed real admissions.
  for (const coordinated of result.facts.coordinatedConsumption) {
    const real = result.facts.realConsumption.find((w) => w.windowIndex === coordinated.windowIndex);
    for (const [tenant, consumed] of Object.entries(coordinated.tenants)) {
      const actual = real?.tenants[tenant] ?? 0;
      assert.ok(consumed <= actual, `window ${coordinated.windowIndex} tenant ${tenant} over-reported`);
    }
  }
  assert.deepEqual(result.facts.reportedGenerations, [1, 2]);
  assert.equal(result.facts.hasAllRecordKinds, true);
});

test('scenario: every message outcome is one the network can produce', async () => {
  const { networkLog } = await runTransferScenario();
  const outcomes = new Set(networkLog.map((entry) => entry.outcome));
  assert.ok(outcomes.has('delivered'));
  assert.ok(outcomes.has('partitioned'));
  // Duplicated copies exist.
  assert.ok(networkLog.some((entry) => (entry.copy ?? 0) > 0));
});

test('simulation harness: settle advances time and reports unfinished work', async () => {
  const sim = new Simulation({
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 60 },
    policy: fixed(10),
    startMs: 100,
  });
  const a = sim.addNode({ nodeId: 'a', tenantId: 'A', borrowAmount: 20 });
  const state = sim.track(a.node.borrow(a.client, 'r1', 20));
  const done = await sim.settle(state);
  assert.equal(done.done, true);
  assert.equal(done.value?.ok, true);
  a.node.tryAdmit(5);
  assert.equal(sim.budgetReport().windows[0].total, 5);
});

test('healing a partition automatically retries pending borrows', async () => {
  const r = rig(fixed(10), 100);
  const { node, client } = r.addNode('n1', 'A');
  r.network.partition('n1');
  const pending = track(node.borrow(client, 'r1', 30));
  await new Promise((resolve) => setImmediate(resolve));
  r.network.advanceTo(500);
  assert.equal(pending.done, false);
  assert.equal(client.pendingCount(), 1);

  // Healing alone re-sends the pending request; no caller retry is needed.
  r.network.heal('n1');
  await settle(r.network, pending);
  assert.equal(pending.done, true);
  assert.equal(pending.value?.ok, true);
  assert.equal(client.pendingCount(), 0);
  assert.equal(node.localRemaining(), 30);
  assert.equal(r.coordinator.available('A').tenant, 30);
});

test('healing re-sends pending returns without double-crediting', async () => {
  const r = rig(fixed(10), 100);
  const { node, client } = r.addNode('n1', 'A');
  const borrow = track(node.borrow(client, 'r1', 40));
  await settle(r.network, borrow);
  node.tryAdmit(10);
  const intent = node.prepareReturn('ret1')!;
  r.network.partition('n1');
  const returned = track(node.submitReturn(client, intent));
  await new Promise((resolve) => setImmediate(resolve));
  r.network.advanceTo(400);
  assert.equal(returned.done, false);

  r.network.heal('n1');
  await settle(r.network, returned);
  assert.equal(returned.done, true);
  assert.equal(returned.value?.accepted, true);
  assert.deepEqual(r.coordinator.available('A'), { global: 90, tenant: 50 });
  const credits = r.coordinator
    .recordsOfKind('return_accepted')
    .filter((record) => record.returnId === 'ret1');
  assert.equal(credits.length, 1);
});

test('network never moves simulated time backwards', () => {
  const r = rig(fixed(10), 100);
  r.network.advanceTo(200);
  assert.throws(() => r.network.advanceTo(150), /backwards/);
});
