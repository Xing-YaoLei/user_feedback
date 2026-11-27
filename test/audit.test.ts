import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ManualClock } from '../src/clock.ts';
import { Coordinator } from '../src/coordinator.ts';
import { DirectClient } from '../src/client.ts';
import { QuotaNode } from '../src/node.ts';
import { auditConsumption } from '../src/audit.ts';
import { runTransferScenario } from '../src/scenario.ts';
import { runTransferScenario as runScenario } from '../src/scenario.ts';

const WINDOW = 1000;
const SKEW = 10;

test('audit reconciles real admissions with coordinator accounting', async () => {
  const clock = new ManualClock(100);
  const coordinator = new Coordinator({
    clock,
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 60 },
    leaseTtlMs: 300,
  });
  const client = new DirectClient(coordinator);
  const node = new QuotaNode({
    nodeId: 'n1',
    clock,
    skewMs: SKEW,
    borrowAmount: 40,
    tenantId: 'A',
  });
  await node.borrow(client, 'r1', 40);
  node.tryAdmit(10);
  node.tryAdmit(5);
  await node.reportConsumption(client, 'rep1');

  const admissions = node.allAdmissions().map((record) => ({ ...record, nodeId: 'n1' }));
  const audit = auditConsumption(admissions, coordinator);
  assert.equal(audit.reconciled, true);
  assert.deepEqual(audit.differences, []);
  assert.equal(audit.windows[0].consumed, 15);
  assert.equal(audit.windows[0].consumedPerTenant.A, 15);
  assert.deepEqual(audit.coordinatedConsumed[0], { A: 15 });
});

test('audit flags a coordinator that somehow accounted more than was admitted', () => {
  const clock = new ManualClock(100);
  const coordinator = new Coordinator({
    clock,
    windowMs: WINDOW,
    skewMs: SKEW,
    globalLimitPerWindow: 100,
    tenantLimitsPerWindow: { A: 60 },
  });
  // Report consumption for a lease the coordinator granted directly.
  const response = coordinator.handleBorrow({
    type: 'borrow.request',
    requestId: 'r1',
    nodeId: 'ghost',
    generation: 1,
    tenantId: 'A',
    amount: 20,
    sentAt: 100,
  });
  assert.ok(response.lease);
  coordinator.handleConsumeReport({
    type: 'consume.report',
    reportId: 'rep',
    nodeId: 'ghost',
    generation: 1,
    sentAt: 100,
    entries: [
      {
        seq: 1,
        nodeId: 'ghost',
        generation: 1,
        leaseId: response.lease!.leaseId,
        tenantId: 'A',
        windowIndex: 0,
        cost: 20,
        at: 100,
      },
    ],
  });
  const audit = auditConsumption([], coordinator);
  assert.equal(audit.reconciled, false);
  assert.ok(audit.differences.some((line) => line.includes('coordinator 20 > node admissions 0')));
});

test('audit over the full scenario reconciles every window', async () => {
  const result = await runTransferScenario();
  const audit = auditConsumption(result.admissions, coordinatorOf(result));
  assert.equal(audit.reconciled, true);
  assert.deepEqual(audit.differences, []);
  for (const window of audit.windows) {
    const real = result.facts.realConsumption.find((w) => w.windowIndex === window.windowIndex);
    assert.equal(window.consumed, real?.total);
  }
});

test('the scenario object graph is stable across runs', async () => {
  const a = await runScenario();
  const b = await runTransferScenario();
  assert.deepEqual(a.admissions, b.admissions);
  assert.deepEqual(a.coordinatorRecords.map((r) => r.kind), b.coordinatorRecords.map((r) => r.kind));
});

/**
 * The scenario does not expose its Coordinator instance, so a minimal stand-in
 * is derived from its recorded snapshots.  `auditConsumption` only needs
 * `knownWindows()` and `windowSnapshot()`.
 */
function coordinatorOf(result: Awaited<ReturnType<typeof runTransferScenario>>): Coordinator {
  const snapshots = new Map(result.windows.map((snapshot) => [snapshot.windowIndex, snapshot]));
  return {
    knownWindows: () => [...snapshots.keys()].sort((x, y) => x - y),
    windowSnapshot: (index: number) => snapshots.get(index)!,
  } as unknown as Coordinator;
}
