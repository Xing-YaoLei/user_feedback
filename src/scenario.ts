/**
 * Reproducible quota-transfer scenario.
 *
 * One run of `runTransferScenario()` exercises, with a fixed message schedule
 * and a fixed (deterministic) delivery policy:
 *
 *   - alpha borrows, consumes, loses its link to the coordinator, freezes its
 *     remainder and prepares a return *while partitioned*;
 *   - alpha reboots into a new generation, retries its borrow (same id) and
 *     replays its durable generation-1 return after the link heals;
 *   - the retried borrow response is duplicated and arrives twice (the second
 *     copy must not hand out the same quota again);
 *   - alpha keeps admitting locally during a second outage;
 *   - delta dies with an unconfirmed remainder that keeps occupying its window
 *     until the window ends, then a *new generation* reports the old ledger
 *     late, in the next window;
 *   - the window switch refuses a late borrow from a retired generation and a
 *     late return of old-window quota, so neither enlarges the new window;
 *   - consumption from both old and new generations is reported and accounted
 *     separately.
 *
 * The result contains the coordinator's auditable records, a budget report
 * computed from *real local admissions*, and the facts asserted by the tests.
 */

import { ManualClock, OffsetClock } from './clock.ts';
import { Coordinator } from './coordinator.ts';
import type { CoordinatorRecord } from './coordinator.ts';
import { SimulatedClient } from './client.ts';
import { QuotaNode } from './node.ts';
import type { AdmissionRecord } from './node.ts';
import { SimulatedNetwork, type DeliveryPolicy } from './network.ts';
import type { BorrowRequest, ConsumeAck, ReturnConfirm, WireMessage } from './protocol.ts';
import { checkBudget, type BudgetReport } from './sim.ts';

export const WINDOW_MS = 1000;
export const SKEW_MS = 10;
export const GLOBAL_LIMIT = 100;
export const TENANT_LIMITS = { A: 60, B: 60 } as const;
export const LEASE_TTL_MS = 500;

export const SCENARIO_LIMITS = {
  globalLimitPerWindow: GLOBAL_LIMIT,
  tenantLimitsPerWindow: TENANT_LIMITS,
};

export interface ScenarioNode {
  node: QuotaNode;
  client: SimulatedClient;
  clockOffsetMs: number;
}

export interface ScenarioStep {
  at: number;
  action: string;
  detail: string;
}

export interface ScenarioFactSet {
  availableAAfterReturn: number;
  availableAAfterRedistribution: number;
  availableABeforeStaleReturn: number;
  availableAWindow1AfterStaleReturn: number;
  alphaReturnCredits: number[];
  alphaG1Lease: {
    amount: number;
    reportedConsumed: number;
    creditedReturns: number;
    outstanding: number;
  };
  alphaReturnBoundary: { amount: number; frozenFromSeq: number; consumedAtBoundary: number };
  alphaGen2RemainingAfterDuplicate: number;
  alphaGen2RemainingAfterAdmits: number;
  duplicateConfirmIds: string[];
  repeatedUnitsReason: string | null;
  lateBorrowReasons: Array<{ requestId: string; reason: string }>;
  staleReturnReasons: Array<{ returnId: string; reason: string; credited: number }>;
  window0BReserved: number;
  window0BReportedConsumed: number;
  /** delta's dead generation-1 lease: amount, consumed, committed residue. */
  deltaG1Lease: { amount: number; reportedConsumed: number; creditedReturns: number; outstanding: number };
  /** Window 1 tenant B reservation (nothing carried over from window 0). */
  window1BReserved: number;
  realConsumption: Array<{ windowIndex: number; total: number; tenants: Record<string, number> }>;
  coordinatedConsumption: Array<{ windowIndex: number; tenants: Record<string, number> }>;
  reportedGenerations: number[];
  hasAllRecordKinds: boolean;
}

export interface ScenarioResult {
  steps: ScenarioStep[];
  networkLog: Array<{ at: number; direction: string; type: string; outcome: string; copy?: number }>;
  coordinatorRecords: CoordinatorRecord[];
  admissions: Array<AdmissionRecord & { nodeId: string }>;
  budget: BudgetReport;
  budgetViolations: string[];
  windows: Array<ReturnType<Coordinator['windowSnapshot']>>;
  facts: ScenarioFactSet;
}

/** Fixed delivery policy: deterministic latencies with targeted duplication. */
function scenarioPolicy(): DeliveryPolicy {
  const returnLatencyCalls = new Map<string, number>();
  const borrowResponseCalls = new Map<string, number>();
  return {
    latencyMs(message: WireMessage): number {
      if (message.type === 'return.intent' && message.returnId === 'alpha-ret-1') {
        const call = returnLatencyCalls.get(message.returnId) ?? 0;
        returnLatencyCalls.set(message.returnId, call + 1);
        // The two copies of alpha-ret-1 deliberately arrive out of order.
        return call === 0 ? 12 : 26;
      }
      if (message.type === 'borrow.response' && message.requestId === 'alpha-g2-req') {
        const call = borrowResponseCalls.get(message.requestId) ?? 0;
        borrowResponseCalls.set(message.requestId, call + 1);
        // The duplicate grant for alpha's new generation arrives much later.
        return call === 0 ? 8 : 34;
      }
      return 10;
    },
    copies(message: WireMessage): number {
      if (message.type === 'return.intent' && message.returnId === 'alpha-ret-1') return 2;
      if (message.type === 'borrow.response' && message.requestId === 'alpha-g2-req') return 2;
      return 1;
    },
    drop(): boolean {
      return false;
    },
  };
}

function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Tracked<T> {
  done: boolean;
  value?: T;
}

class ScenarioRunner {
  readonly steps: ScenarioStep[] = [];
  readonly trueClock = new ManualClock(0);
  readonly coordinator: Coordinator;
  readonly network: SimulatedNetwork;
  private readonly nodes = new Map<string, ScenarioNode>();

  constructor() {
    this.coordinator = new Coordinator({
      clock: new OffsetClock(this.trueClock, 0),
      windowMs: WINDOW_MS,
      skewMs: SKEW_MS,
      globalLimitPerWindow: GLOBAL_LIMIT,
      tenantLimitsPerWindow: TENANT_LIMITS,
      leaseTtlMs: LEASE_TTL_MS,
    });
    this.network = new SimulatedNetwork({
      coordinator: this.coordinator,
      policy: scenarioPolicy(),
      trueClock: this.trueClock,
    });
  }

  addNode(nodeId: string, tenantId: string, borrowAmount: number, clockOffsetMs: number): ScenarioNode {
    const node = new QuotaNode({
      nodeId,
      clock: this.network.clockFor(nodeId, clockOffsetMs),
      skewMs: SKEW_MS,
      borrowAmount,
      tenantId,
    });
    const client = new SimulatedClient(this.network, node);
    this.network.registerNode(client);
    const handle: ScenarioNode = { node, client, clockOffsetMs };
    this.nodes.set(nodeId, handle);
    return handle;
  }

  get(nodeId: string): ScenarioNode {
    const handle = this.nodes.get(nodeId);
    if (!handle) throw new Error(`unknown node ${nodeId}`);
    return handle;
  }

  get allNodes(): ScenarioNode[] {
    return [...this.nodes.values()];
  }

  /** Advance to an absolute instant, dispatching every delivery due by then. */
  async runTo(at: number): Promise<void> {
    this.network.advanceTo(at);
    await drain();
  }

  track<T>(promise: Promise<T>): Tracked<T> {
    const state: Tracked<T> = { done: false };
    promise.then(
      (value) => {
        state.done = true;
        state.value = value;
      },
      () => {
        state.done = true;
      },
    );
    return state;
  }

  /**
   * Advance 1ms at a time until `tracked` settles.  Throws when it does not
   * within `budgetMs`, which keeps every "expect a reply" point explicit.
   */
  async awaitReply<T>(tracked: Tracked<T>, label: string, budgetMs = 400): Promise<T> {
    const deadline = this.trueClock.now() + budgetMs;
    await drain();
    while (!tracked.done && this.trueClock.now() < deadline) {
      this.network.advanceBy(1);
      await drain();
    }
    if (!tracked.done) throw new Error(`${label}: no reply within ${budgetMs}ms`);
    return tracked.value as T;
  }

  /** Let all queued microtasks run without advancing simulated time. */
  async flush(): Promise<void> {
    await drain();
    await drain();
  }

  /**
   * Advance true time to `at` (or stay put if protocol waits already carried
   * time further) and record the step at the *actual* simulated instant.  This
   * keeps the printed schedule honest: every time shown is when the action
   * really ran.
   */
  step(at: number, action: string, detail: string): void {
    if (at > this.trueClock.now()) this.network.advanceTo(at);
    this.steps.push({ at: this.trueClock.now(), action, detail });
  }

  allAdmissions(): Array<AdmissionRecord & { nodeId: string }> {
    const result: Array<AdmissionRecord & { nodeId: string }> = [];
    for (const [nodeId, handle] of this.nodes) {
      for (const record of handle.node.allAdmissions()) result.push({ ...record, nodeId });
    }
    return result;
  }
}

function summariseConsumption(
  admissions: ReadonlyArray<AdmissionRecord & { nodeId: string }>,
): Array<{ windowIndex: number; total: number; tenants: Record<string, number> }> {
  const buckets = new Map<number, { total: number; tenants: Map<string, number> }>();
  for (const record of admissions) {
    const bucket = buckets.get(record.windowIndex) ?? { total: 0, tenants: new Map() };
    buckets.set(record.windowIndex, bucket);
    bucket.total += record.cost;
    bucket.tenants.set(record.tenantId, (bucket.tenants.get(record.tenantId) ?? 0) + record.cost);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([windowIndex, bucket]) => ({
      windowIndex,
      total: bucket.total,
      tenants: Object.fromEntries(bucket.tenants),
    }));
}

/** Run the whole reproducible scenario and return its audit trail. */
export async function runTransferScenario(): Promise<ScenarioResult> {
  const runner = new ScenarioRunner();
  const alpha = runner.addNode('alpha', 'A', 40, -8);
  const beta = runner.addNode('beta', 'B', 30, 6);
  const gamma = runner.addNode('gamma', 'A', 20, 2);
  const delta = runner.addNode('delta', 'B', 10, 0);

  // ---- Window 0: normal transfer ---------------------------------------

  runner.step(100, 'alpha.borrow(40)', 'tenant A, generation 1');
  const alphaBorrow = runner.track(alpha.node.borrow(alpha.client, 'alpha-req-1', 40));
  const alphaGrant = await runner.awaitReply(alphaBorrow, 'alpha first borrow');
  if (!alphaGrant.ok) throw new Error(`alpha first borrow rejected: ${alphaGrant.reason}`);

  runner.step(130, 'alpha.admit(10)', 'local admission, no coordinator round trip');
  if (!alpha.node.tryAdmit(10).ok) throw new Error('alpha admission 1 failed');
  runner.step(135, 'alpha.admit(10)', 'local admission');
  if (!alpha.node.tryAdmit(10).ok) throw new Error('alpha admission 2 failed');

  runner.step(150, 'beta.borrow(10)', 'tenant B');
  const betaBorrow = runner.track(beta.node.borrow(beta.client, 'beta-req-1', 10));
  const betaGrant = await runner.awaitReply(betaBorrow, 'beta borrow');
  if (!betaGrant.ok) throw new Error(`beta borrow rejected: ${betaGrant.reason}`);
  runner.step(175, 'beta.admit(10)', 'beta consumes its whole lease');
  if (!beta.node.tryAdmit(10).ok) throw new Error('beta admission failed');

  // ---- Alpha loses the coordinator mid-window ---------------------------

  runner.step(200, 'network.partition(alpha)', 'alpha loses its link to the coordinator');
  runner.network.partition('alpha');

  runner.step(210, 'alpha.prepareReturn(20)', 'stop boundary: 20 consumed, 20 frozen');
  const alphaIntent = alpha.node.prepareReturn('alpha-ret-1');
  if (!alphaIntent || alphaIntent.amount !== 20) {
    throw new Error(`expected alpha to freeze 20, got ${alphaIntent?.amount}`);
  }
  if (alphaIntent.frozenFromSeq !== 2 || alphaIntent.consumedAtBoundary !== 20) {
    throw new Error('alpha stop boundary is not what the ledger says');
  }
  if (alpha.node.tryAdmit(1).ok) throw new Error('frozen quota must not be admissible');

  runner.step(215, 'alpha.submitReturn', 'sent while partitioned: no delivery, no confirm');
  const firstReturnAttempt = runner.track(alpha.node.submitReturn(alpha.client, alphaIntent));
  await runner.runTo(240);
  if (firstReturnAttempt.done) throw new Error('partitioned return unexpectedly completed');

  // ---- Delta dies with an unconfirmed remainder -------------------------

  runner.step(250, 'delta.borrow(10)', 'tenant B, will die with an unconfirmed remainder');
  const deltaBorrow = runner.track(delta.node.borrow(delta.client, 'delta-req-1', 10));
  const deltaGrant = await runner.awaitReply(deltaBorrow, 'delta borrow');
  if (!deltaGrant.ok) throw new Error(`delta borrow rejected: ${deltaGrant.reason}`);
  const deltaIntentLeaseId = deltaGrant.lease.leaseId;
  runner.step(275, 'delta.admit(5)', '5 of 10 consumed, 5 left unconfirmed');
  if (!delta.node.tryAdmit(5).ok) throw new Error('delta admission failed');
  runner.step(300, 'network.partition(delta)', 'delta dies; remainder stays reserved');
  runner.network.partition('delta');

  // ---- Alpha reboots and retries after recovery -------------------------

  runner.step(310, 'alpha.reboot()', 'generation 1 -> 2; old lease abandoned');
  alpha.node.reboot();
  if (alpha.node.generation !== 2) throw new Error('alpha did not advance generation');

  runner.step(315, 'alpha.borrow(alpha-g2-req, 20)', 'queued while partitioned');
  const queuedBorrow = runner.track(alpha.node.borrow(alpha.client, 'alpha-g2-req', 20));
  runner.step(320, 'alpha.replayReturns()', 'replay durable generation-1 return');
  const queuedReplay = runner.track(alpha.node.replayReturns(alpha.client));
  await runner.runTo(330);
  if (queuedBorrow.done || queuedReplay.done) {
    throw new Error('partitioned requests delivered before healing');
  }

  runner.step(340, 'network.heal(alpha)', 'link restored: pending requests re-sent automatically');
  runner.network.heal('alpha');

  // No caller retry here: the transport's reconnect hook re-sends everything
  // still awaiting a reply, reusing the original ids.
  const gen2Grant = await runner.awaitReply(queuedBorrow, 'alpha generation-2 borrow');
  if (!gen2Grant.ok) throw new Error(`alpha generation-2 borrow rejected: ${gen2Grant.reason}`);

  const returnConfirms = await runner.awaitReply(queuedReplay, 'alpha recovered return');
  if (returnConfirms.length !== 1 || !returnConfirms[0].accepted) {
    throw new Error('durable return was not accepted after recovery');
  }

  runner.step(365, 'alpha.admit(5)', 'generation 2 local admission');
  if (!alpha.node.tryAdmit(5).ok) throw new Error('alpha gen-2 admission failed');

  // Let the late duplicate borrow response arrive; it must not reset quota.
  await runner.runTo(405);
  const alphaGen2RemainingAfterDuplicate = alpha.node.localRemaining();
  if (alphaGen2RemainingAfterDuplicate !== 15) {
    throw new Error(`duplicate grant changed local quota: ${alphaGen2RemainingAfterDuplicate} != 15`);
  }

  // ---- Second outage: local admission must continue ---------------------

  runner.step(410, 'network.partition(alpha)', 'second outage');
  runner.network.partition('alpha');
  runner.step(420, 'alpha.admit(5)', 'admitted with the coordinator unreachable');
  if (!alpha.node.tryAdmit(5).ok) throw new Error('offline admission 1 failed');
  runner.step(425, 'alpha.admit(5)', 'admitted with the coordinator unreachable');
  if (!alpha.node.tryAdmit(5).ok) throw new Error('offline admission 2 failed');
  const alphaGen2RemainingAfterAdmits = alpha.node.localRemaining();
  runner.step(440, 'network.heal(alpha)', 'link restored again');
  runner.network.heal('alpha');

  // Duplicate return id must be answered as a replay and never re-credit.
  runner.step(450, 'alpha.submitReturn(same id)', 'duplicate return must be a replay');
  const duplicateSubmit = runner.track(alpha.node.submitReturn(alpha.client, alphaIntent));
  const duplicateConfirm = await runner.awaitReply(duplicateSubmit, 'duplicate return');
  const duplicateConfirmIds: string[] = [];
  if (duplicateConfirm.duplicate) duplicateConfirmIds.push(duplicateConfirm.returnId);

  // A duplicate return under a *new* id must be refused: the same units cannot
  // be handed back twice.
  runner.step(455, 'alpha.submitReturn(new id, same units)', 'must be refused as exceeds_lease');
  const repeatUnits = runner.track(
    alpha.node.submitReturn(alpha.client, { ...alphaIntent, returnId: 'alpha-ret-dup' }),
  );
  const repeatConfirm = await runner.awaitReply(repeatUnits, 'duplicate units return');
  if (repeatConfirm.accepted || repeatConfirm.credited !== 0) {
    throw new Error('the same units were returned twice');
  }

  const availableAAfterReturn = runner.coordinator.available('A').tenant ?? 0;

  runner.step(480, 'gamma.borrow(20)', 'tenant A uses the quota alpha returned');
  const gammaBorrow = runner.track(gamma.node.borrow(gamma.client, 'gamma-req-1', 20));
  const gammaGrant = await runner.awaitReply(gammaBorrow, 'gamma borrow');
  if (!gammaGrant.ok) throw new Error(`gamma borrow rejected: ${gammaGrant.reason}`);
  runner.step(500, 'gamma.admit(10)', 'gamma consumes half its lease');
  if (!gamma.node.tryAdmit(10).ok) throw new Error('gamma admission failed');

  const availableAAfterRedistribution = runner.coordinator.available('A').tenant ?? 0;

  runner.step(600, 'gamma.prepareReturn(10)', 'frozen now, deliberately sent in the next window');
  const gammaIntent = gamma.node.prepareReturn('gamma-ret-1');
  if (!gammaIntent || gammaIntent.amount !== 10) throw new Error('gamma return intent wrong');

  // ---- Report live generations before the window ends ------------------

  runner.step(620, 'reports sent', 'alpha gen1+gen2, beta, gamma gen1');
  const reportAlphaG1 = runner.track(alpha.node.reportGeneration(alpha.client, 1, 'alpha-g1-report'));
  const reportAlphaG2 = runner.track(alpha.node.reportConsumption(alpha.client, 'alpha-g2-report'));
  const reportBeta = runner.track(beta.node.reportConsumption(beta.client, 'beta-report-1'));
  const reportGammaG1 = runner.track(gamma.node.reportGeneration(gamma.client, 1, 'gamma-g1-report'));
  for (const [tracked, label] of [
    [reportAlphaG1, 'alpha gen1 report'],
    [reportAlphaG2, 'alpha gen2 report'],
    [reportBeta, 'beta report'],
    [reportGammaG1, 'gamma gen1 report'],
  ] as const) {
    const ack = await runner.awaitReply<ConsumeAck>(tracked, label);
    if (ack.rejected.length > 0) throw new Error(`${label} had rejections`);
  }

  // ---- Window switch ----------------------------------------------------

  runner.step(1050, 'window 0 -> 1', 'new window, fresh budgets; old-window quota void');
  await runner.runTo(1050);

  runner.step(1052, 'late borrow from generation 1', 'retired generation must not reserve quota');
  const lateRequest: BorrowRequest = {
    type: 'borrow.request',
    requestId: 'alpha-g1-late',
    nodeId: 'alpha',
    generation: 1,
    tenantId: 'A',
    amount: 5,
    sentAt: 900,
  };
  runner.network.sendFromNode('alpha', lateRequest);
  await runner.runTo(1080);

  const availableABeforeStaleReturn = runner.coordinator.available('A').tenant ?? 0;

  runner.step(1090, 'gamma.submitReturn(old window)', 'old-window quota must not be credited');
  const gammaSubmit = runner.track(gamma.node.submitReturn(gamma.client, gammaIntent));
  const gammaConfirm: ReturnConfirm = await runner.awaitReply(gammaSubmit, 'stale return');
  if (gammaConfirm.accepted || gammaConfirm.credited !== 0) {
    throw new Error('stale old-window return was credited');
  }

  const availableAWindow1AfterStaleReturn = runner.coordinator.available('A').tenant ?? 0;

  // Delta's successor generation reports the dead generation's ledger late.
  runner.step(1095, 'delta.reboot()', 'generation 1 -> 2 while still unreachable');
  delta.node.reboot();
  runner.step(1130, 'network.heal(delta)', 'delta comes back');
  runner.network.heal('delta');
  runner.step(1140, 'delta.reportGeneration(1)', 'old generation reported late, in window 1');
  const deltaLateReport = runner.track(delta.node.reportGeneration(delta.client, 1, 'delta-g1-report'));
  await runner.awaitReply(deltaLateReport, 'delta late report');

  runner.step(1170, 'delta.borrow(15)', 'new generation borrows in the new window');
  const deltaGen2 = runner.track(delta.node.borrow(delta.client, 'delta-g2-req', 15));
  const deltaGen2Grant = await runner.awaitReply(deltaGen2, 'delta generation-2 borrow');
  if (!deltaGen2Grant.ok) throw new Error(`delta gen-2 borrow rejected: ${deltaGen2Grant.reason}`);
  runner.step(1190, 'delta.admit(12)', 'new-generation local admission');
  if (!delta.node.tryAdmit(12).ok) throw new Error('delta gen-2 admission failed');

  runner.step(1210, 'gamma.borrow(50)', 'fresh window budget');
  const gammaWindow1 = runner.track(gamma.node.borrow(gamma.client, 'gamma-req-w1', 50));
  const gammaW1Grant = await runner.awaitReply(gammaWindow1, 'gamma window-1 borrow');
  if (!gammaW1Grant.ok) throw new Error(`gamma window-1 borrow rejected: ${gammaW1Grant.reason}`);
  runner.step(1230, 'gamma.admit(40)', 'window 1 local admission');
  if (!gamma.node.tryAdmit(40).ok) throw new Error('gamma window-1 admission failed');

  runner.step(1260, 'gamma.report(window 1)', 'report current-generation consumption');
  const reportGammaW1 = runner.track(gamma.node.reportConsumption(gamma.client, 'gamma-w1-report'));
  const reportDeltaG2 = runner.track(delta.node.reportConsumption(delta.client, 'delta-g2-report'));
  await runner.awaitReply(reportGammaW1, 'gamma window-1 report');
  await runner.awaitReply(reportDeltaG2, 'delta window-1 report');

  // ---- Collect ----------------------------------------------------------

  const admissions = runner.allAdmissions();
  const realConsumption = summariseConsumption(admissions);
  const budget: BudgetReport = { admissions, windows: realConsumption };
  const budgetViolations = checkBudget(budget, SCENARIO_LIMITS);

  const windows = runner.coordinator.knownWindows().map((index) => runner.coordinator.windowSnapshot(index));
  const coordinatedConsumption = windows.map((snapshot) => ({
    windowIndex: snapshot.windowIndex,
    tenants: snapshot.tenantConsumed,
  }));

  const alphaG1LeaseSummary = runner.coordinator.leaseSummary(alphaIntent.leaseId);
  if (!alphaG1LeaseSummary) throw new Error('alpha generation-1 lease missing');

  const alphaReturnCredits = runner.coordinator
    .recordsOfKind('return_accepted')
    .filter((record) => record.returnId === 'alpha-ret-1')
    .map((record) => record.credited);

  const lateBorrowReasons = runner.coordinator
    .recordsOfKind('borrow_rejected')
    .filter((record) => record.requestId === 'alpha-g1-late')
    .map((record) => ({ requestId: record.requestId, reason: record.reason }));

  const staleReturnReasons = runner.coordinator
    .recordsOfKind('return_rejected')
    .filter((record) => record.returnId === gammaConfirm.returnId)
    .map((record) => ({
      returnId: record.returnId,
      reason: record.reason,
      credited: record.credited,
    }));

  const window0 = runner.coordinator.windowSnapshot(0);
  const window1 = runner.coordinator.windowSnapshot(1);
  const reportedGenerations = [
    ...new Set(runner.coordinator.recordsOfKind('consume').map((record) => record.generation)),
  ].sort((a, b) => a - b);

  const deltaG1LeaseSummary = runner.coordinator.leaseSummary(deltaIntentLeaseId);
  if (!deltaG1LeaseSummary) throw new Error('delta generation-1 lease missing');

  const hasAllRecordKinds =
    runner.coordinator.recordsOfKind('borrow_granted').length > 0 &&
    runner.coordinator.recordsOfKind('borrow_rejected').length > 0 &&
    runner.coordinator.recordsOfKind('consume').length > 0 &&
    runner.coordinator.recordsOfKind('return_accepted').length > 0 &&
    runner.coordinator.recordsOfKind('return_rejected').length > 0;

  return {
    steps: runner.steps,
    networkLog: runner.network.log.map((entry) => ({
      at: entry.at,
      direction: entry.direction,
      type: entry.message.type,
      outcome: entry.outcome,
      copy: entry.copy,
    })),
    coordinatorRecords: runner.coordinator.records().map((record) => ({ ...record })),
    admissions,
    budget,
    budgetViolations,
    windows,
    facts: {
      availableAAfterReturn,
      availableAAfterRedistribution,
      availableABeforeStaleReturn,
      availableAWindow1AfterStaleReturn,
      alphaReturnCredits,
      alphaG1Lease: {
        amount: alphaG1LeaseSummary.amount,
        reportedConsumed: alphaG1LeaseSummary.reportedConsumed,
        creditedReturns: alphaG1LeaseSummary.creditedReturns,
        outstanding: alphaG1LeaseSummary.outstanding,
      },
      alphaReturnBoundary: {
        amount: alphaIntent.amount,
        frozenFromSeq: alphaIntent.frozenFromSeq,
        consumedAtBoundary: alphaIntent.consumedAtBoundary,
      },
      alphaGen2RemainingAfterDuplicate,
      alphaGen2RemainingAfterAdmits,
      duplicateConfirmIds,
      repeatedUnitsReason: repeatConfirm.reason ?? null,
      lateBorrowReasons,
      staleReturnReasons,
      window0BReserved: window0.tenantReserved.B ?? 0,
      window0BReportedConsumed: window0.tenantConsumed.B ?? 0,
      deltaG1Lease: {
        amount: deltaG1LeaseSummary.amount,
        reportedConsumed: deltaG1LeaseSummary.reportedConsumed,
        creditedReturns: deltaG1LeaseSummary.creditedReturns,
        outstanding: deltaG1LeaseSummary.outstanding,
      },
      window1BReserved: window1.tenantReserved.B ?? 0,
      realConsumption,
      coordinatedConsumption,
      reportedGenerations,
      hasAllRecordKinds,
    },
  };
}
