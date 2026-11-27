/**
 * Coordinator-side quota accounting.
 *
 * Budget model
 * ------------
 * Time is split into fixed, non-overlapping windows of `windowMs`.  Every
 * window has one global budget and one budget per tenant.  A borrow atomically
 * reserves both the global and the tenant portion of the *current* window.  An
 * accepted return credits the lease's own window back.
 *
 * Invariants:
 *
 *   1. For every window, sum of granted leases <= global limit.
 *   2. For every window and tenant, sum of granted leases <= tenant limit.
 *   3. For every lease, consumption + credited returns <= lease amount.
 *   4. Reservations whose remainder cannot be confirmed keep occupying their
 *      window until the window ends.  They are never carried forward.
 *
 * Message handling is idempotent by request id, so duplicated and replayed
 * messages never reserve or credit twice.
 */

import { windowEndAt, windowIndexAt, type Clock } from './clock.ts';
import {
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  type BorrowRejectReason,
  type BorrowRequest,
  type BorrowResponse,
  type ConsumeAck,
  type ConsumeEntry,
  type ConsumeRejectReason,
  type ConsumeReport,
  type LeaseGrant,
  type NodeToCoordinatorMessage,
  type ReturnConfirm,
  type ReturnIntent,
  type ReturnRejectReason,
} from './protocol.ts';

export interface CoordinatorConfig {
  clock: Clock;
  windowMs: number;
  /** Caller-supplied upper bound on any node-clock vs coordinator-clock deviation. */
  skewMs: number;
  globalLimitPerWindow: number;
  tenantLimitsPerWindow: Readonly<Record<string, number>>;
  /** Default lease lifetime.  Defaults to half a window. */
  leaseTtlMs?: number;
}

export type BorrowRecord =
  | {
      kind: 'borrow_granted';
      at: number;
      windowIndex: number;
      requestId: string;
      leaseId: string;
      fence: number;
      nodeId: string;
      generation: number;
      tenantId: string;
      amount: number;
      issuedAt: number;
      expiresAt: number;
      globalReservedAfter: number;
      tenantReservedAfter: number;
    }
  | {
      kind: 'borrow_rejected';
      at: number;
      windowIndex: number;
      requestId: string;
      nodeId: string;
      generation: number;
      tenantId: string;
      amount: number;
      reason: BorrowRejectReason;
      availableGlobal: number;
      availableTenant: number | null;
    };

export type ReturnRecord =
  | {
      kind: 'return_accepted';
      at: number;
      windowIndex: number;
      returnId: string;
      leaseId: string;
      nodeId: string;
      /** Generation that sent the intent. */
      generation: number;
      /** Generation that originally received the lease. */
      leaseGeneration: number;
      /** True when the sending generation was already known to be retired. */
      retiredGeneration: boolean;
      amount: number;
      credited: number;
      /** Lease amount not yet returned, after this credit. */
      leaseOutstandingAfter: number;
      globalReservedAfter: number;
      tenantReservedAfter: number;
    }
  | {
      kind: 'return_rejected';
      at: number;
      windowIndex: number;
      returnId: string;
      leaseId: string;
      nodeId: string;
      generation: number;
      amount: number;
      reason: ReturnRejectReason;
      credited: 0;
    };

export interface ConsumeRecord {
  kind: 'consume';
  at: number;
  /** Window of the lease; never re-derived from the report arrival time. */
  windowIndex: number;
  reportId: string;
  nodeId: string;
  generation: number;
  seq: number;
  leaseId: string;
  tenantId: string;
  cost: number;
  /** Node reading at local admission time. */
  consumedAt: number;
  status: 'accounted' | 'orphan' | 'lease_exhausted' | 'invalid';
}

export type CoordinatorRecord = BorrowRecord | ReturnRecord | ConsumeRecord;

export interface WindowSnapshot {
  windowIndex: number;
  globalLimit: number;
  /**
   * Total quota committed for this window: every granted amount that has not
   * been credited back by an accepted return.  Equals `globalConsumed +`
   * the still-outstanding part of live leases, so it is the number that must
   * stay within `globalLimit`.
   */
  globalReserved: number;
  /** The portion of the committed quota already confirmed as consumed. */
  globalConsumed: number;
  /** `globalReserved - globalConsumed`: granted but neither consumed nor returned. */
  globalOutstanding: number;
  /** `globalLimit - globalReserved`: quota still grantable this window. */
  globalAvailable: number;
  tenantLimits: Record<string, number>;
  tenantReserved: Record<string, number>;
  tenantConsumed: Record<string, number>;
  tenantOutstanding: Record<string, number>;
  tenantAvailable: Record<string, number>;
}

interface LeaseState {
  grant: LeaseGrant;
  creditedReturns: number;
  reportedConsumed: number;
  fullyReturned: boolean;
}

interface WindowState {
  index: number;
  /**
   * Committed quota: grants not yet credited back.  Confirmed consumption stays
   * in here (it really was used) and does not free budget; only an accepted
   * return lowers it.
   */
  globalReserved: number;
  tenantReserved: Map<string, number>;
  globalConsumed: number;
  tenantConsumed: Map<string, number>;
}

export interface HandleOptions {
  /** Override the coordinator reading used for this decision. */
  at?: number;
}

export class Coordinator {
  private readonly clock: Clock;
  private readonly windowMs: number;
  private readonly skewMs: number;
  private readonly leaseTtlMs: number;
  private readonly globalLimit: number;
  private readonly tenantLimits: Map<string, number>;
  /** Minimum guaranteed usable lease life, in coordinator milliseconds. */
  private readonly closingMarginMs: number;

  private readonly windows = new Map<number, WindowState>();
  private readonly leases = new Map<string, LeaseState>();
  private readonly borrowDecisions = new Map<string, BorrowResponse>();
  private readonly returnDecisions = new Map<string, ReturnConfirm>();
  private readonly seenConsumeKeys = new Set<string>();
  private readonly knownGeneration = new Map<string, number>();
  private readonly log: CoordinatorRecord[] = [];

  private nextFence = 0;
  private nextLeaseNumber = 0;

  constructor(config: CoordinatorConfig) {
    if (!Number.isSafeInteger(config.windowMs) || config.windowMs <= 0) {
      throw new Error('windowMs must be a positive integer');
    }
    if (!Number.isSafeInteger(config.skewMs) || config.skewMs < 0) {
      throw new Error('skewMs must be a non-negative integer');
    }
    if (!isPositiveInteger(config.globalLimitPerWindow)) {
      throw new Error('globalLimitPerWindow must be a positive integer');
    }
    for (const [tenant, limit] of Object.entries(config.tenantLimitsPerWindow)) {
      if (!isPositiveInteger(limit)) {
        throw new Error(`tenant limit for "${tenant}" must be a positive integer`);
      }
    }
    // A node must be able to find a reading whose whole skew interval lies
    // inside both the window and the lease.
    if (config.windowMs <= 4 * config.skewMs + 2) {
      throw new Error('windowMs must be greater than 4*skewMs+2');
    }
    this.clock = config.clock;
    this.windowMs = config.windowMs;
    this.skewMs = config.skewMs;
    this.globalLimit = config.globalLimitPerWindow;
    this.tenantLimits = new Map(Object.entries(config.tenantLimitsPerWindow));
    this.leaseTtlMs = config.leaseTtlMs ?? Math.floor(config.windowMs / 2);
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new Error('leaseTtlMs must be a positive integer');
    }
    this.closingMarginMs = 2 * this.skewMs + 2;
  }

  get skew(): number {
    return this.skewMs;
  }

  get windowLength(): number {
    return this.windowMs;
  }

  now(at?: number): number {
    return at ?? this.clock.now();
  }

  currentWindow(at?: number): number {
    return windowIndexAt(this.now(at), this.windowMs);
  }

  /** Route one node->coordinator message. */
  handle(
    msg: NodeToCoordinatorMessage,
    opts: HandleOptions = {},
  ): BorrowResponse | ReturnConfirm | ConsumeAck {
    switch (msg.type) {
      case 'borrow.request':
        return this.handleBorrow(msg, opts);
      case 'return.intent':
        return this.handleReturn(msg, opts);
      case 'consume.report':
        return this.handleConsumeReport(msg, opts);
    }
  }

  // ------------------------------------------------------------------ borrow

  handleBorrow(msg: BorrowRequest, opts: HandleOptions = {}): BorrowResponse {
    if (!isNonEmptyString(msg.requestId) || !isNonEmptyString(msg.nodeId)) {
      throw new Error('borrow request requires requestId and nodeId');
    }
    // Idempotence is scoped to (node, generation, request).  A restarted node
    // may legitimately reuse a request id within its new generation; that must
    // be a fresh decision, never a replay of the dead generation's grant.
    const decisionKey = `${msg.nodeId}|${msg.generation}|${msg.requestId}`;
    const prior = this.borrowDecisions.get(decisionKey);
    if (prior) return { ...prior, duplicate: true };

    const at = this.now(opts.at);
    const windowIndex = windowIndexAt(at, this.windowMs);
    const window = this.windowFor(windowIndex);
    const tenantLimit = this.tenantLimits.get(msg.tenantId);
    const availableGlobal = this.globalLimit - window.globalReserved;
    const availableTenant =
      tenantLimit === undefined ? null : tenantLimit - (window.tenantReserved.get(msg.tenantId) ?? 0);

    const reject = (reason: BorrowRejectReason): BorrowResponse => {
      const response: BorrowResponse = {
        type: 'borrow.response',
        requestId: msg.requestId,
        nodeId: msg.nodeId,
        generation: msg.generation,
        windowIndex,
        lease: null,
        rejectionReason: reason,
        at,
      };
      this.borrowDecisions.set(decisionKey, response);
      this.log.push({
        kind: 'borrow_rejected',
        at,
        windowIndex,
        requestId: msg.requestId,
        nodeId: msg.nodeId,
        generation: msg.generation,
        tenantId: msg.tenantId,
        amount: msg.amount,
        reason,
        availableGlobal,
        availableTenant,
      });
      return response;
    };

    if (!isNonNegativeInteger(msg.generation)) return reject('invalid_request');
    if (!isNonEmptyString(msg.tenantId)) return reject('invalid_tenant');
    if (!isPositiveInteger(msg.amount)) return reject('invalid_amount');
    if (tenantLimit === undefined) return reject('unknown_tenant');

    // A generation already known to be superseded must not reserve fresh
    // budget; its late requests are accounted as rejections.
    const known = this.knownGeneration.get(msg.nodeId) ?? 0;
    if (msg.generation < known) return reject('stale_generation');
    if (msg.generation > known) this.knownGeneration.set(msg.nodeId, msg.generation);

    const windowEnd = windowEndAt(windowIndex, this.windowMs);
    // Even a node with a worst-case clock offset needs time to receive the
    // grant and still find a safely usable reading.
    if (at + this.closingMarginMs >= windowEnd) return reject('window_closing');

    if (msg.amount > availableGlobal) return reject('insufficient_global');
    if (availableTenant === null || msg.amount > availableTenant) return reject('insufficient_tenant');

    const expiresAt = Math.min(at + this.leaseTtlMs, windowEnd - this.skewMs);
    if (expiresAt - at < this.skewMs + 1) return reject('window_closing');

    this.nextLeaseNumber += 1;
    this.nextFence += 1;
    const lease: LeaseGrant = {
      leaseId: `lease-${this.nextLeaseNumber}-${msg.nodeId}-g${msg.generation}`,
      fence: this.nextFence,
      nodeId: msg.nodeId,
      generation: msg.generation,
      tenantId: msg.tenantId,
      amount: msg.amount,
      windowIndex,
      windowStart: windowIndex * this.windowMs,
      windowEnd,
      issuedAt: at,
      expiresAt,
    };
    window.globalReserved += msg.amount;
    window.tenantReserved.set(msg.tenantId, (window.tenantReserved.get(msg.tenantId) ?? 0) + msg.amount);
    this.leases.set(lease.leaseId, {
      grant: lease,
      creditedReturns: 0,
      reportedConsumed: 0,
      fullyReturned: false,
    });

    const response: BorrowResponse = {
      type: 'borrow.response',
      requestId: msg.requestId,
      nodeId: msg.nodeId,
      generation: msg.generation,
      windowIndex,
      lease,
      at,
    };
    this.borrowDecisions.set(decisionKey, response);
    this.log.push({
      kind: 'borrow_granted',
      at,
      windowIndex,
      requestId: msg.requestId,
      leaseId: lease.leaseId,
      fence: lease.fence,
      nodeId: msg.nodeId,
      generation: msg.generation,
      tenantId: msg.tenantId,
      amount: msg.amount,
      issuedAt: at,
      expiresAt,
      globalReservedAfter: window.globalReserved,
      tenantReservedAfter: window.tenantReserved.get(msg.tenantId) ?? 0,
    });
    return response;
  }

  // ------------------------------------------------------------------ return

  handleReturn(msg: ReturnIntent, opts: HandleOptions = {}): ReturnConfirm {
    if (!isNonEmptyString(msg.returnId) || !isNonEmptyString(msg.leaseId)) {
      throw new Error('return intent requires returnId and leaseId');
    }
    const prior = this.returnDecisions.get(msg.returnId);
    if (prior) return { ...prior, duplicate: true };

    const at = this.now(opts.at);
    const decisionWindow = windowIndexAt(at, this.windowMs);

    const reject = (reason: ReturnRejectReason): ReturnConfirm => {
      const confirm: ReturnConfirm = {
        type: 'return.confirm',
        returnId: msg.returnId,
        leaseId: msg.leaseId,
        nodeId: msg.nodeId,
        generation: msg.generation,
        accepted: false,
        credited: 0,
        windowIndex: null,
        reason,
        at,
      };
      this.returnDecisions.set(msg.returnId, confirm);
      this.log.push({
        kind: 'return_rejected',
        at,
        windowIndex: decisionWindow,
        returnId: msg.returnId,
        leaseId: msg.leaseId,
        nodeId: msg.nodeId,
        generation: msg.generation,
        amount: msg.amount,
        reason,
        credited: 0,
      });
      return confirm;
    };

    if (!isPositiveInteger(msg.amount)) return reject('invalid_amount');
    if (!isNonNegativeInteger(msg.generation)) return reject('invalid_request');
    if (!isNonNegativeInteger(msg.frozenFromSeq) || !isNonNegativeInteger(msg.consumedAtBoundary)) {
      return reject('invalid_boundary');
    }

    const state = this.leases.get(msg.leaseId);
    if (!state) return reject('unknown_lease');
    const lease = state.grant;

    // Only the node and generation that received the lease know where the stop
    // boundary sits.  A successor generation cannot honestly claim the old
    // lease's remainder, so it is fenced out and the reservation keeps
    // occupying its window until the window ends.  (A successor *may* replay a
    // persisted intent naming the original generation — that is a trustworthy
    // final account and is accepted below.)
    if (msg.nodeId !== lease.nodeId) return reject('fence_mismatch');
    if (msg.generation !== lease.generation) return reject('generation_mismatch');

    // Quota from an earlier window is void.  Crediting it would wrongly
    // enlarge the current window's budget, which is forbidden.
    if (lease.windowIndex !== decisionWindow) return reject('stale_window');

    const outstanding = lease.amount - state.creditedReturns;
    if (msg.amount > outstanding) return reject('exceeds_lease');

    // Exactly-once accounting for returns.
    //
    // The node declares its stop boundary (`consumedAtBoundary`) and the
    // unconsumed slice it is handing back (`amount`).  Together with anything
    // already returned, that must account for the whole lease: every unit is
    // either consumed or returned, never both, never neither.  This refuses
    // re-offering the same units under a fresh return id, and refuses a node
    // that under-declares consumption to inflate the returned slice.
    if (msg.consumedAtBoundary + msg.amount + state.creditedReturns !== lease.amount) {
      return reject('exceeds_lease');
    }
    // The boundary must not contradict consumption already reported.
    if (state.reportedConsumed > msg.consumedAtBoundary) {
      return reject('invalid_boundary');
    }
    // The boundary must be consistent with the ledger position it names: the
    // node cannot claim fewer ledger entries than it already reported.
    if (msg.frozenFromSeq === 0 && msg.consumedAtBoundary !== 0) {
      return reject('invalid_boundary');
    }

    const window = this.windowFor(lease.windowIndex);
    const tenantReservedNow = window.tenantReserved.get(lease.tenantId) ?? 0;
    if (msg.amount > window.globalReserved || msg.amount > tenantReservedNow) {
      return reject('exceeds_lease');
    }

    state.creditedReturns += msg.amount;
    if (state.creditedReturns === lease.amount) state.fullyReturned = true;
    window.globalReserved -= msg.amount;
    window.tenantReserved.set(lease.tenantId, tenantReservedNow - msg.amount);

    const senderKnownGeneration = this.knownGeneration.get(msg.nodeId) ?? 0;
    this.log.push({
      kind: 'return_accepted',
      at,
      windowIndex: lease.windowIndex,
      returnId: msg.returnId,
      leaseId: lease.leaseId,
      nodeId: msg.nodeId,
      generation: msg.generation,
      leaseGeneration: lease.generation,
      retiredGeneration: senderKnownGeneration > lease.generation,
      amount: msg.amount,
      credited: msg.amount,
      leaseOutstandingAfter: lease.amount - state.creditedReturns,
      globalReservedAfter: window.globalReserved,
      tenantReservedAfter: window.tenantReserved.get(lease.tenantId) ?? 0,
    });

    const confirm: ReturnConfirm = {
      type: 'return.confirm',
      returnId: msg.returnId,
      leaseId: msg.leaseId,
      nodeId: msg.nodeId,
      generation: msg.generation,
      accepted: true,
      credited: msg.amount,
      windowIndex: lease.windowIndex,
      at,
    };
    this.returnDecisions.set(msg.returnId, confirm);
    return confirm;
  }

  // ------------------------------------------------------------- consumption

  handleConsumeReport(msg: ConsumeReport, opts: HandleOptions = {}): ConsumeAck {
    const ack: ConsumeAck = {
      type: 'consume.ack',
      reportId: msg.reportId,
      nodeId: msg.nodeId,
      generation: msg.generation,
      accepted: [],
      duplicates: [],
      rejected: [],
    };
    const at = this.now(opts.at);
    if (!isNonEmptyString(msg.nodeId) || !Array.isArray(msg.entries)) return ack;

    for (const entry of msg.entries) {
      const outcome = this.classifyEntry(msg.nodeId, entry);
      if (outcome.duplicate) {
        ack.duplicates.push(entry.seq);
        continue;
      }
      if (outcome.status === 'invalid') {
        ack.rejected.push({ seq: entry.seq, reason: outcome.reason });
        continue;
      }
      this.log.push({
        kind: 'consume',
        at,
        windowIndex: outcome.windowIndex,
        reportId: msg.reportId,
        nodeId: entry.nodeId,
        generation: entry.generation,
        seq: entry.seq,
        leaseId: entry.leaseId,
        tenantId: entry.tenantId,
        cost: entry.cost,
        consumedAt: entry.at,
        status: outcome.status,
      });
      if (outcome.status === 'lease_exhausted') {
        ack.rejected.push({ seq: entry.seq, reason: 'lease_exhausted' });
      } else {
        ack.accepted.push(entry.seq);
      }
    }
    return ack;
  }

  private classifyEntry(
    reportNodeId: string,
    entry: ConsumeEntry,
  ):
    | { duplicate: true }
    | { status: 'invalid'; reason: ConsumeRejectReason }
    | { status: 'accounted' | 'orphan' | 'lease_exhausted'; windowIndex: number } {
    if (
      !entry ||
      !isNonNegativeInteger(entry.seq) ||
      !isPositiveInteger(entry.cost) ||
      !isNonEmptyString(entry.leaseId) ||
      !isNonEmptyString(entry.tenantId) ||
      entry.nodeId !== reportNodeId
    ) {
      return { status: 'invalid', reason: 'invalid_entry' };
    }
    const key = `${entry.nodeId}|${entry.generation}|${entry.seq}`;
    if (this.seenConsumeKeys.has(key)) return { duplicate: true };
    this.seenConsumeKeys.add(key);

    const state = this.leases.get(entry.leaseId);
    if (!state) {
      return { status: 'orphan', windowIndex: entry.windowIndex };
    }
    const lease = state.grant;
    // Consumption is only attributable to the lease holder of that generation.
    if (lease.nodeId !== entry.nodeId || lease.generation !== entry.generation) {
      return { status: 'orphan', windowIndex: lease.windowIndex };
    }
    // Returned and consumed portions must stay disjoint and within the lease.
    if (state.reportedConsumed + state.creditedReturns + entry.cost > lease.amount) {
      return { status: 'lease_exhausted', windowIndex: lease.windowIndex };
    }
    state.reportedConsumed += entry.cost;
    const window = this.windowFor(lease.windowIndex);
    window.globalConsumed += entry.cost;
    window.tenantConsumed.set(
      entry.tenantId,
      (window.tenantConsumed.get(entry.tenantId) ?? 0) + entry.cost,
    );
    return { status: 'accounted', windowIndex: lease.windowIndex };
  }

  // ---------------------------------------------------------------- queries

  records(): readonly CoordinatorRecord[] {
    return this.log.slice();
  }

  recordsOfKind<K extends CoordinatorRecord['kind']>(
    kind: K,
  ): Array<Extract<CoordinatorRecord, { kind: K }>> {
    return this.log.filter((r): r is Extract<CoordinatorRecord, { kind: K }> => r.kind === kind);
  }

  leaseGrant(leaseId: string): LeaseGrant | undefined {
    return this.leases.get(leaseId)?.grant;
  }

  leaseIds(): string[] {
    return [...this.leases.keys()];
  }

  leaseSummary(leaseId: string):
    | {
        leaseId: string;
        nodeId: string;
        generation: number;
        tenantId: string;
        windowIndex: number;
        amount: number;
        creditedReturns: number;
        reportedConsumed: number;
        outstanding: number;
        fullyReturned: boolean;
      }
    | null {
    const state = this.leases.get(leaseId);
    if (!state) return null;
    return {
      leaseId,
      nodeId: state.grant.nodeId,
      generation: state.grant.generation,
      tenantId: state.grant.tenantId,
      windowIndex: state.grant.windowIndex,
      amount: state.grant.amount,
      creditedReturns: state.creditedReturns,
      reportedConsumed: state.reportedConsumed,
      outstanding: state.grant.amount - state.creditedReturns - state.reportedConsumed,
      fullyReturned: state.fullyReturned,
    };
  }

  /** Lease amount neither returned nor reported consumed (may be stale). */
  leaseOutstanding(leaseId: string): number | null {
    const state = this.leases.get(leaseId);
    if (!state) return null;
    return state.grant.amount - state.creditedReturns - state.reportedConsumed;
  }

  /** Availability in the current (coordinator-time) window. */
  available(tenantId: string, at?: number): { global: number; tenant: number | null } {
    const window = this.windowFor(windowIndexAt(this.now(at), this.windowMs));
    const limit = this.tenantLimits.get(tenantId);
    return {
      global: this.globalLimit - window.globalReserved,
      tenant: limit === undefined ? null : limit - (window.tenantReserved.get(tenantId) ?? 0),
    };
  }

  windowSnapshot(windowIndex: number): WindowSnapshot {
    const window = this.windows.get(windowIndex);
    const tenantLimits: Record<string, number> = Object.fromEntries(this.tenantLimits);
    const tenantReserved: Record<string, number> = {};
    const tenantConsumed: Record<string, number> = {};
    const tenantOutstanding: Record<string, number> = {};
    const tenantAvailable: Record<string, number> = {};
    const tenants = new Set([
      ...this.tenantLimits.keys(),
      ...(window?.tenantReserved.keys() ?? []),
      ...(window?.tenantConsumed.keys() ?? []),
    ]);
    for (const tenant of tenants) {
      const reserved = window?.tenantReserved.get(tenant) ?? 0;
      const consumed = window?.tenantConsumed.get(tenant) ?? 0;
      const limit = this.tenantLimits.get(tenant);
      if (reserved !== 0) tenantReserved[tenant] = reserved;
      if (consumed !== 0) tenantConsumed[tenant] = consumed;
      if (reserved - consumed !== 0) tenantOutstanding[tenant] = reserved - consumed;
      if (limit !== undefined) tenantAvailable[tenant] = limit - reserved;
    }
    const globalReserved = window?.globalReserved ?? 0;
    const globalConsumed = window?.globalConsumed ?? 0;
    return {
      windowIndex,
      globalLimit: this.globalLimit,
      globalReserved,
      globalConsumed,
      globalOutstanding: globalReserved - globalConsumed,
      globalAvailable: this.globalLimit - globalReserved,
      tenantLimits,
      tenantReserved,
      tenantConsumed,
      tenantOutstanding,
      tenantAvailable,
    };
  }

  knownWindows(): number[] {
    return [...this.windows.keys()].sort((a, b) => a - b);
  }

  generationOf(nodeId: string): number {
    return this.knownGeneration.get(nodeId) ?? 0;
  }

  private windowFor(index: number): WindowState {
    let window = this.windows.get(index);
    if (!window) {
      window = {
        index,
        globalReserved: 0,
        tenantReserved: new Map(),
        globalConsumed: 0,
        tenantConsumed: new Map(),
      };
      this.windows.set(index, window);
    }
    return window;
  }
}
