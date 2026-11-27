/**
 * Edge-node admission controller.
 *
 * Lifecycle
 * ---------
 *   borrow(...)        -> ask the coordinator for a lease (I/O, may fail)
 *   tryAdmit(cost)     -> synchronously decide a request locally
 *   prepareReturn(...) -> synchronously freeze the unconsumed part
 *   submitReturn(...)  -> send the frozen part back (retryable, idempotent)
 *   reboot()           -> start a new generation; old leases are abandoned
 *
 * Once a lease is in hand, `tryAdmit` performs no I/O whatsoever, so local
 * admission keeps working while coordinator messages are delayed, duplicated,
 * lost, or reordered.  Consumption is recorded in a local ledger keyed by
 * `(generation, seq)`; the ledger of every past generation is retained so late
 * reports for a dead generation can still be submitted and are accounted
 * separately from the current generation.
 *
 * Clock and lease boundaries
 * --------------------------
 * `skewMs` is the caller-declared upper bound on `|node reading - coordinator
 * reading|` at the same instant.  A node reading `r` is therefore consistent
 * with coordinator time in `[r - skew, r + skew]`.  An admission is only
 * allowed when that whole interval is inside both the window and the lease:
 *
 *     r - skew >= windowStart
 *     r + skew <= expiresAt        (and expiresAt <= windowEnd - skew)
 *
 * which proves the real admission happened strictly inside the fixed window.
 *
 * Stop boundary for returns
 * -------------------------
 * `prepareReturn` runs in the same synchronous step as `tryAdmit`, so no
 * admission can interleave.  At that instant it:
 *
 *   1. records `frozenFromSeq` (the ledger length at the boundary),
 *   2. sets local remaining to zero so the frozen units become inadmissible,
 *   3. persists the exact intent (surviving `reboot`) for replay.
 *
 * Everything with `seq <= frozenFromSeq` was consumed; the returned amount is
 * disjoint from it and can never be admitted later.  A rejected return never
 * re-opens the frozen units — they stay frozen rather than risking a double
 * spend.  The persisted intent is what makes a return "trustworthy" after a
 * crash: a successor generation replays it verbatim, and the coordinator
 * recognises the lease generation it names.
 */

import { insideConservativeInterval } from './clock.ts';
import {
  isBorrowResponse,
  isConsumeAck,
  isNonEmptyString,
  isPositiveInteger,
  isReturnConfirm,
  type BorrowRequest,
  type BorrowResponse,
  type ConsumeEntry,
  type ConsumeReport,
  type CoordinatorToNodeMessage,
  type LeaseGrant,
  type ReturnConfirm,
  type ReturnIntent,
} from './protocol.ts';

/** Minimal structural clock type to avoid a circular import. */
export interface ClockLike {
  now(): number;
}

export interface NodeConfig {
  nodeId: string;
  clock: ClockLike;
  /** Upper bound on |node reading - coordinator reading|. */
  skewMs: number;
  /** Preferred amount per borrow. */
  borrowAmount: number;
  tenantId: string;
}

export type AdmitRejectReason =
  | 'no_lease'
  | 'lease_expired'
  | 'wrong_window'
  | 'insufficient_local_lease'
  | 'return_frozen'
  | 'invalid_cost';

export interface AdmissionRecord {
  /** Per-generation ledger sequence, starting at 1. */
  seq: number;
  generation: number;
  leaseId: string;
  tenantId: string;
  windowIndex: number;
  cost: number;
  /** Node reading at admission. */
  at: number;
}

export type AdmitResult =
  | { ok: true; record: AdmissionRecord; remaining: number }
  | { ok: false; reason: AdmitRejectReason; remaining: number };

export type BorrowOutcome =
  | { ok: true; lease: LeaseGrant; duplicate: boolean }
  | { ok: false; reason: string; duplicate: boolean };

/** The coordinator as seen from a node; may be backed by an unreliable network. */
export interface CoordinatorClient {
  borrow(request: BorrowRequest): Promise<BorrowResponse>;
  returnQuota(intent: ReturnIntent): Promise<ReturnConfirm>;
  reportConsumption(report: ConsumeReport): Promise<unknown>;
}

interface LeaseTracker {
  grant: LeaseGrant;
  /** Amount still admissible locally (frozen part already subtracted). */
  localRemaining: number;
  /** Ledger length at the moment the remainder was frozen, or null. */
  frozenFromSeq: number | null;
  consumedSeqs: number[];
  /** True after an accepted confirmation. */
  returnConfirmed: boolean;
  /** Amount the coordinator confirmed crediting. */
  confirmedCredit: number;
}

export interface DurableReturn {
  intent: ReturnIntent;
  accepted: boolean;
  credited: number;
}

export class QuotaNode {
  readonly nodeId: string;
  private readonly clock: ClockLike;
  private readonly skewMs: number;
  private readonly tenantId: string;
  private readonly borrowAmount: number;

  private generationValue = 1;
  private current: LeaseTracker | null = null;
  private ledger: AdmissionRecord[] = [];
  /** Retained ledgers of past generations, keyed by generation. */
  private readonly pastLedgers = new Map<number, AdmissionRecord[]>();
  /** Return intents that survive a reboot until confirmed accepted. */
  private readonly durableReturns = new Map<string, DurableReturn>();
  private msgSeq = 0;
  private rebootCount = 0;

  constructor(config: NodeConfig) {
    if (!isNonEmptyString(config.nodeId)) throw new Error('nodeId is required');
    if (!isPositiveInteger(config.borrowAmount)) throw new Error('borrowAmount must be a positive integer');
    if (!Number.isSafeInteger(config.skewMs) || config.skewMs < 0) {
      throw new Error('skewMs must be a non-negative integer');
    }
    if (!isNonEmptyString(config.tenantId)) throw new Error('tenantId is required');
    this.nodeId = config.nodeId;
    this.clock = config.clock;
    this.skewMs = config.skewMs;
    this.tenantId = config.tenantId;
    this.borrowAmount = config.borrowAmount;
  }

  get generation(): number {
    return this.generationValue;
  }

  get tenant(): string {
    return this.tenantId;
  }

  get restarts(): number {
    return this.rebootCount;
  }

  currentLease(): LeaseGrant | null {
    return this.current?.grant ?? null;
  }

  localRemaining(): number {
    return this.current?.localRemaining ?? 0;
  }

  /** True once the remainder of the current lease was frozen for return. */
  isFrozen(): boolean {
    return this.current !== null && this.current.frozenFromSeq !== null;
  }

  ledgerLength(): number {
    return this.ledger.length;
  }

  admissions(): readonly AdmissionRecord[] {
    return this.ledger.slice();
  }

  /** Ledger of a given generation (current or retired), for late reporting. */
  admissionsOf(generation: number): readonly AdmissionRecord[] {
    if (generation === this.generationValue) return this.admissions();
    return (this.pastLedgers.get(generation) ?? []).slice();
  }

  /** All generations this node has run, oldest first (1..current). */
  generations(): number[] {
    const result: number[] = [];
    for (let g = 1; g <= this.generationValue; g += 1) result.push(g);
    return result;
  }

  /** Admissions across every generation this node ever recorded. */
  allAdmissions(): readonly AdmissionRecord[] {
    const result: AdmissionRecord[] = [];
    for (const archived of this.pastLedgers.values()) result.push(...archived);
    result.push(...this.ledger);
    return result;
  }

  consumedInWindow(windowIndex: number): number {
    return this.ledger
      .filter((entry) => entry.windowIndex === windowIndex)
      .reduce((sum, entry) => sum + entry.cost, 0);
  }

  durableReturnIntents(): ReturnIntent[] {
    return [...this.durableReturns.values()]
      .filter((record) => !record.accepted)
      .map((record) => record.intent);
  }

  nextMessageId(kind: string): string {
    this.msgSeq += 1;
    return `${this.nodeId}-g${this.generationValue}-${kind}-${this.msgSeq}`;
  }

  /**
   * Start a new generation after a restart.  The in-memory lease vanishes and
   * its unreturned remainder is NOT recovered locally: the coordinator keeps it
   * reserved for its window.  The current ledger is archived under its own
   * generation, so consumption from before and after the restart is accounted
   * separately and can never be conflated.  Durable return intents survive.
   */
  reboot(): number {
    if (this.ledger.length > 0) {
      this.pastLedgers.set(this.generationValue, this.ledger);
    }
    this.generationValue += 1;
    this.rebootCount += 1;
    this.current = null;
    this.ledger = [];
    return this.generationValue;
  }

  makeBorrowRequest(requestId: string, amount = this.borrowAmount): BorrowRequest {
    return {
      type: 'borrow.request',
      requestId,
      nodeId: this.nodeId,
      generation: this.generationValue,
      tenantId: this.tenantId,
      amount,
      sentAt: this.clock.now(),
    };
  }

  async borrow(
    client: CoordinatorClient,
    requestId: string,
    amount = this.borrowAmount,
  ): Promise<BorrowOutcome> {
    const response = await client.borrow(this.makeBorrowRequest(requestId, amount));
    return this.acceptBorrowResponse(response);
  }

  /** Apply a borrow response that may arrive long after the request (replay-safe). */
  acceptBorrowResponse(response: BorrowResponse): BorrowOutcome {
    const duplicate = response.duplicate === true;
    if (response.nodeId !== this.nodeId) return { ok: false, reason: 'wrong_node', duplicate };
    if (!response.lease) {
      return { ok: false, reason: response.rejectionReason ?? 'rejected', duplicate };
    }
    return this.acceptGrant(response.lease, duplicate);
  }

  /**
   * Receive one coordinator message delivered by the transport.
   *
   * Returns what the node did with it so a caller can assert on delivery.
   * Unknown/unsolicited messages are ignored rather than throwing, because a
   * delayed message may legitimately arrive after the state it referred to has
   * changed.
   */
  receive(message: CoordinatorToNodeMessage): { kind: 'borrow' | 'return' | 'consume' | 'ignored'; outcome?: unknown } {
    if (isBorrowResponse(message)) {
      return { kind: 'borrow', outcome: this.acceptBorrowResponse(message) };
    }
    if (isReturnConfirm(message)) {
      this.applyReturnConfirm(message);
      return { kind: 'return', outcome: message };
    }
    if (isConsumeAck(message)) {
      return { kind: 'consume', outcome: message };
    }
    return { kind: 'ignored' };
  }

  /** Install a grant received out of band. Grants for other generations are ignored. */
  acceptGrant(lease: LeaseGrant, duplicate = false): BorrowOutcome {
    if (lease.nodeId !== this.nodeId) return { ok: false, reason: 'wrong_node', duplicate };
    if (lease.generation !== this.generationValue) {
      return { ok: false, reason: 'stale_generation', duplicate };
    }
    if (lease.tenantId !== this.tenantId) return { ok: false, reason: 'wrong_tenant', duplicate };
    const current = this.current;
    if (current && current.grant.leaseId === lease.leaseId) {
      // Idempotent reinstall of the lease we already hold: never reset the
      // local balance, otherwise a duplicate delivery would hand out quota
      // twice.  `duplicate` here describes the coordinator's decision, so it
      // is passed through unchanged.
      return { ok: true, lease, duplicate };
    }
    if (current && current.grant.fence > lease.fence) {
      return { ok: false, reason: 'older_lease', duplicate };
    }
    this.current = {
      grant: lease,
      localRemaining: lease.amount,
      frozenFromSeq: null,
      consumedSeqs: [],
      returnConfirmed: false,
      confirmedCredit: 0,
    };
    return { ok: true, lease, duplicate };
  }

  /**
   * Synchronously attempt to admit a request of `cost` units.
   *
   * No I/O, no coordinator round trip: this keeps serving traffic during a
   * coordinator outage.  Boundary checks are conservative under the skew bound.
   */
  tryAdmit(cost: number, opts: { at?: number } = {}): AdmitResult {
    const tracker = this.current;
    if (!isPositiveInteger(cost)) {
      return { ok: false, reason: 'invalid_cost', remaining: tracker?.localRemaining ?? 0 };
    }
    if (!tracker) return { ok: false, reason: 'no_lease', remaining: 0 };
    if (tracker.frozenFromSeq !== null) {
      return { ok: false, reason: 'return_frozen', remaining: tracker.localRemaining };
    }

    const reading = opts.at ?? this.clock.now();
    const grant = tracker.grant;

    if (!insideConservativeInterval(reading, grant.windowStart, grant.windowEnd, this.skewMs)) {
      return { ok: false, reason: 'wrong_window', remaining: tracker.localRemaining };
    }
    if (!insideConservativeInterval(reading, grant.windowStart, grant.expiresAt, this.skewMs)) {
      return { ok: false, reason: 'lease_expired', remaining: tracker.localRemaining };
    }
    if (cost > tracker.localRemaining) {
      return { ok: false, reason: 'insufficient_local_lease', remaining: tracker.localRemaining };
    }

    const seq = this.ledger.length + 1;
    const record: AdmissionRecord = {
      seq,
      generation: this.generationValue,
      leaseId: grant.leaseId,
      tenantId: grant.tenantId,
      windowIndex: grant.windowIndex,
      cost,
      at: reading,
    };
    tracker.localRemaining -= cost;
    tracker.consumedSeqs.push(seq);
    this.ledger.push(record);
    return { ok: true, record, remaining: tracker.localRemaining };
  }

  /**
   * Freeze the unconsumed remainder of the current lease and build the return
   * intent.  Synchronous with `tryAdmit`, so no admission can slip in between.
   *
   * Returns null when there is nothing returnable or no currently usable lease.
   * The intent is persisted immediately and survives `reboot`.
   */
  prepareReturn(returnId: string, opts: { at?: number } = {}): ReturnIntent | null {
    const tracker = this.current;
    if (!tracker) return null;
    if (tracker.frozenFromSeq !== null) return null;
    if (tracker.localRemaining <= 0) return null;

    const reading = opts.at ?? this.clock.now();
    const grant = tracker.grant;
    // Only offer back quota that is still conservatively inside the window;
    // otherwise the coordinator must reject it as stale and nothing is gained.
    if (!insideConservativeInterval(reading, grant.windowStart, grant.windowEnd, this.skewMs)) {
      return null;
    }

    const amount = tracker.localRemaining;
    const frozenFromSeq = this.ledger.length;
    const consumedAtBoundary = tracker.grant.amount - amount;
    tracker.localRemaining = 0;
    tracker.frozenFromSeq = frozenFromSeq;

    const intent: ReturnIntent = {
      type: 'return.intent',
      returnId,
      leaseId: grant.leaseId,
      nodeId: this.nodeId,
      generation: this.generationValue,
      amount,
      frozenFromSeq,
      consumedAtBoundary,
      sentAt: reading,
    };
    this.durableReturns.set(returnId, { intent, accepted: false, credited: 0 });
    return intent;
  }

  /** Prepare (if needed) and send the frozen remainder. */
  async returnRemainder(
    client: CoordinatorClient,
    returnId: string,
    opts: { at?: number } = {},
  ): Promise<ReturnConfirm | null> {
    const intent = this.prepareReturn(returnId, opts);
    if (!intent) return null;
    return this.submitReturn(client, intent);
  }

  /** Submit an already-prepared intent.  Retries must reuse the same intent/id. */
  async submitReturn(client: CoordinatorClient, intent: ReturnIntent): Promise<ReturnConfirm> {
    const confirm = await client.returnQuota(intent);
    this.applyReturnConfirm(confirm);
    return confirm;
  }

  /**
   * Replay every unconfirmed durable return intent.  Called after a restart or
   * network recovery; ids are reused, so this can never double-credit.
   */
  async replayReturns(client: CoordinatorClient): Promise<ReturnConfirm[]> {
    const results: ReturnConfirm[] = [];
    for (const record of this.durableReturns.values()) {
      if (record.accepted) continue;
      results.push(await this.submitReturn(client, record.intent));
    }
    return results;
  }

  /**
   * Apply a return confirmation.  A confirm is matched by return id against the
   * durable record, not the live lease, so a confirmation that arrives after a
   * reboot is still recorded.  Accepted confirms never add quota back locally:
   * the units were removed at freeze time.
   */
  applyReturnConfirm(confirm: ReturnConfirm): void {
    const record = this.durableReturns.get(confirm.returnId);
    if (!record) return;
    if (confirm.leaseId !== record.intent.leaseId) return;
    if (!confirm.accepted) return;
    record.accepted = true;
    record.credited = confirm.credited;
    const tracker = this.current;
    if (tracker && tracker.grant.leaseId === confirm.leaseId) {
      tracker.returnConfirmed = true;
      tracker.confirmedCredit = confirm.credited;
    }
  }

  makeConsumeReport(reportId: string, entries?: readonly AdmissionRecord[]): ConsumeReport {
    const source = entries ?? this.ledger;
    const wireEntries: ConsumeEntry[] = source.map((record) => ({
      seq: record.seq,
      nodeId: this.nodeId,
      generation: record.generation,
      leaseId: record.leaseId,
      tenantId: record.tenantId,
      windowIndex: record.windowIndex,
      cost: record.cost,
      at: record.at,
    }));
    return {
      type: 'consume.report',
      reportId,
      nodeId: this.nodeId,
      generation: this.generationValue,
      entries: wireEntries,
      sentAt: this.clock.now(),
    };
  }

  /** Report the current generation's ledger. */
  async reportConsumption(client: CoordinatorClient, reportId: string): Promise<unknown> {
    return client.reportConsumption(this.makeConsumeReport(reportId));
  }

  /** Report a retired generation's ledger (late report after a restart). */
  async reportGeneration(
    client: CoordinatorClient,
    generation: number,
    reportId: string,
  ): Promise<unknown> {
    return client.reportConsumption(this.makeConsumeReport(reportId, this.admissionsOf(generation)));
  }

  /** Conservative remaining lease lifetime as this node sees it. */
  conservativeRemainingMs(opts: { at?: number } = {}): number {
    const tracker = this.current;
    if (!tracker) return 0;
    const reading = opts.at ?? this.clock.now();
    return Math.max(0, tracker.grant.expiresAt - reading - this.skewMs);
  }
}
