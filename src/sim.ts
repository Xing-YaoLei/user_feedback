/**
 * Deterministic end-to-end harness.
 *
 * Wires a coordinator, a set of edge nodes, their transports, and one shared
 * true clock together.  All asynchronous work is driven by advancing simulated
 * time, so scenarios run without wall-clock timers and are exactly repeatable.
 */

import { ManualClock, OffsetClock } from './clock.ts';
import { Coordinator, type CoordinatorConfig } from './coordinator.ts';
import { SimulatedClient } from './client.ts';
import { QuotaNode } from './node.ts';
import { SimulatedNetwork, type DeliveryPolicy } from './network.ts';
import type { AdmissionRecord } from './node.ts';

export interface SimulationConfig {
  windowMs: number;
  skewMs: number;
  globalLimitPerWindow: number;
  tenantLimitsPerWindow: Readonly<Record<string, number>>;
  leaseTtlMs?: number;
  /** Offset of the coordinator's own clock from true time. */
  coordinatorOffsetMs?: number;
  policy: DeliveryPolicy;
  startMs?: number;
}

export interface NodeHandle {
  node: QuotaNode;
  client: SimulatedClient;
  /** Declared offset of this node's clock from true time. */
  clockOffsetMs: number;
}

export interface Timed<T> {
  done: boolean;
  value?: T;
  error?: unknown;
}

/** Let every already-resolved promise's continuation run. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class Simulation {
  readonly network: SimulatedNetwork;
  readonly coordinator: Coordinator;
  readonly trueClock: ManualClock;
  readonly skewMs: number;
  private readonly nodes = new Map<string, NodeHandle>();

  constructor(config: SimulationConfig) {
    this.trueClock = new ManualClock(config.startMs ?? 0);
    this.skewMs = config.skewMs;
    const coordinatorClock = new OffsetClock(this.trueClock, config.coordinatorOffsetMs ?? 0);
    const coordinatorConfig: CoordinatorConfig = {
      clock: coordinatorClock,
      windowMs: config.windowMs,
      skewMs: config.skewMs,
      globalLimitPerWindow: config.globalLimitPerWindow,
      tenantLimitsPerWindow: config.tenantLimitsPerWindow,
      leaseTtlMs: config.leaseTtlMs,
    };
    this.coordinator = new Coordinator(coordinatorConfig);
    this.network = new SimulatedNetwork({
      coordinator: this.coordinator,
      policy: config.policy,
      trueClock: this.trueClock,
    });  }

  get now(): number {
    return this.trueClock.now();
  }

  addNode(config: {
    nodeId: string;
    tenantId: string;
    borrowAmount: number;
    clockOffsetMs?: number;
    skewMs?: number;
  }): NodeHandle {
    const existing = this.nodes.get(config.nodeId);
    if (existing) throw new Error(`node ${config.nodeId} already exists`);
    const clockOffsetMs = config.clockOffsetMs ?? 0;
    const node = new QuotaNode({
      nodeId: config.nodeId,
      clock: this.network.clockFor(config.nodeId, clockOffsetMs),
      skewMs: config.skewMs ?? this.skewMs,
      borrowAmount: config.borrowAmount,
      tenantId: config.tenantId,
    });
    const client = new SimulatedClient(this.network, node);
    this.network.registerNode(client);
    const handle: NodeHandle = { node, client, clockOffsetMs };
    this.nodes.set(config.nodeId, handle);
    return handle;
  }

  node(nodeId: string): NodeHandle {
    const handle = this.nodes.get(nodeId);
    if (!handle) throw new Error(`unknown node ${nodeId}`);
    return handle;
  }

  /** Start tracking a promise without blocking. */
  track<T>(promise: Promise<T>): Timed<T> {
    const state: Timed<T> = { done: false };
    promise.then(
      (value) => {
        state.done = true;
        state.value = value;
      },
      (error) => {
        state.done = true;
        state.error = error;
      },
    );
    return state;
  }

  /**
   * Advance simulated time until `tracked` settles or `budgetMs` of true time
   * elapses.  Returns the tracked state; `done === false` means the reply never
   * arrived (dropped or partitioned).
   */
  async settle<T>(tracked: Timed<T>, budgetMs = 2_000): Promise<Timed<T>> {
    const deadline = this.now + budgetMs;
    await drainMicrotasks();
    while (!tracked.done && this.now < deadline) {
      this.network.advanceBy(1);
      await drainMicrotasks();
    }
    if (tracked.error) throw tracked.error;
    return tracked;
  }

  async advance(ms: number): Promise<void> {
    this.network.advanceBy(ms);
    await drainMicrotasks();
  }

  /** Advance to an absolute true-time instant, draining every due delivery. */
  async advanceTo(at: number): Promise<void> {
    this.network.advanceTo(at);
    await drainMicrotasks();
  }

  /**
   * Every real admission recorded by any node in any generation, tagged with
   * the window the lease belonged to.
   */
  allAdmissions(): Array<AdmissionRecord & { nodeId: string }> {
    const result: Array<AdmissionRecord & { nodeId: string }> = [];
    for (const [nodeId, handle] of this.nodes) {
      for (const record of handle.node.allAdmissions()) result.push({ ...record, nodeId });
    }
    return result;
  }

  /**
   * Assert the core budget invariant over *real* admission records:
   * for every window, total admission cost is within the global budget, and
   * every tenant's admission cost is within that tenant's budget.
   *
   * This inspects what nodes actually admitted, not what the coordinator
   * reserved, so it independently catches over-granting or double spending.
   */
  budgetReport(): BudgetReport {
    const admissions = this.allAdmissions();
    const perWindow = new Map<
      number,
      { total: number; tenants: Map<string, number>; entries: number }
    >();
    for (const admission of admissions) {
      let bucket = perWindow.get(admission.windowIndex);
      if (!bucket) {
        bucket = { total: 0, tenants: new Map(), entries: 0 };
        perWindow.set(admission.windowIndex, bucket);
      }
      bucket.total += admission.cost;
      bucket.entries += 1;
      bucket.tenants.set(admission.tenantId, (bucket.tenants.get(admission.tenantId) ?? 0) + admission.cost);
    }
    const windows = [...perWindow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([windowIndex, bucket]) => ({
        windowIndex,
        total: bucket.total,
        tenants: Object.fromEntries(bucket.tenants),
        entries: bucket.entries,
      }));
    return { admissions, windows };
  }
}

export interface BudgetReport {
  admissions: Array<AdmissionRecord & { nodeId: string }>;
  windows: Array<{
    windowIndex: number;
    total: number;
    tenants: Record<string, number>;
    entries: number;
  }>;
}

/** Verify a `BudgetReport` against limits; empty means everything stayed in budget. */
export function checkBudget(
  report: BudgetReport,
  limits: { globalLimitPerWindow: number; tenantLimitsPerWindow: Readonly<Record<string, number>> },
): string[] {
  const violations: string[] = [];
  for (const window of report.windows) {
    if (window.total > limits.globalLimitPerWindow) {
      violations.push(
        `window ${window.windowIndex}: global consumption ${window.total} > ${limits.globalLimitPerWindow}`,
      );
    }
    for (const [tenant, consumed] of Object.entries(window.tenants)) {
      const limit = limits.tenantLimitsPerWindow[tenant];
      if (limit === undefined) {
        violations.push(`window ${window.windowIndex}: unknown tenant ${tenant}`);
      } else if (consumed > limit) {
        violations.push(`window ${window.windowIndex}: tenant ${tenant} consumption ${consumed} > ${limit}`);
      }
    }
  }
  return violations;
}
