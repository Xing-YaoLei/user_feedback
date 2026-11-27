/**
 * Wire protocol shared by the coordinator and edge nodes.
 *
 * All timestamps are readings of the sender's local clock in milliseconds.
 * Because node and coordinator clocks may differ by up to the configured skew
 * bound, timestamps are never compared for equality against another clock;
 * they only feed the conservative interval arithmetic in `clock.ts`.
 *
 * Message delivery is modelled explicitly: anything can be dropped,
 * duplicated, reordered, or delayed.  Every state-changing request therefore
 * carries a caller-generated id so the coordinator can make its decision
 * idempotent.
 */

export interface LeaseGrant {
  /** Globally unique lease identifier. */
  leaseId: string;
  /** Monotonic fencing token, coordinator-assigned. */
  fence: number;
  nodeId: string;
  /** Node generation that requested and will hold the lease. */
  generation: number;
  tenantId: string;
  /** Positive integer amount of quota reserved by this lease. */
  amount: number;
  /** Fixed window the quota belongs to. */
  windowIndex: number;
  windowStart: number;
  windowEnd: number;
  /** Coordinator reading at grant time. */
  issuedAt: number;
  /**
   * Coordinator reading at which the lease stops being usable; always
   * `<= windowEnd - skew`.  Nodes subtract their own skew bound on top.
   */
  expiresAt: number;
}

export type BorrowRejectReason =
  | 'invalid_request'
  | 'invalid_amount'
  | 'invalid_tenant'
  | 'unknown_tenant'
  | 'stale_generation'
  | 'window_closing'
  | 'insufficient_global'
  | 'insufficient_tenant';

export interface BorrowRequest {
  type: 'borrow.request';
  requestId: string;
  nodeId: string;
  generation: number;
  tenantId: string;
  amount: number;
  /** Node reading when the request was created. */
  sentAt: number;
}

export interface BorrowResponse {
  type: 'borrow.response';
  requestId: string;
  nodeId: string;
  generation: number;
  /** Window in which the coordinator evaluated the request. */
  windowIndex: number;
  lease: LeaseGrant | null;
  rejectionReason?: BorrowRejectReason;
  /** Coordinator reading at decision time. */
  at: number;
  /** True when this is a replay of an earlier decision. */
  duplicate?: boolean;
}

export interface ReturnIntent {
  type: 'return.intent';
  returnId: string;
  leaseId: string;
  nodeId: string;
  /** Generation that received the lease and knows its stop boundary. */
  generation: number;
  /** Positive integer amount offered back. */
  amount: number;
  /**
   * Ledger sequence at the stop boundary.  Every local consumption with
   * `seq <= frozenFromSeq` happened before the freeze; entries after it can
   * never touch the returned units.
   */
  frozenFromSeq: number;
  /**
   * Total amount consumed from this lease up to the boundary.  Lets the
   * coordinator prove `consumedAtBoundary + amount <= lease.amount` without
   * waiting for consumption reports to arrive.
   */
  consumedAtBoundary: number;
  sentAt: number;
}

export type ReturnRejectReason =
  | 'invalid_request'
  | 'invalid_amount'
  | 'invalid_boundary'
  | 'unknown_lease'
  | 'fence_mismatch'
  | 'generation_mismatch'
  | 'stale_window'
  | 'exceeds_lease';

export interface ReturnConfirm {
  type: 'return.confirm';
  returnId: string;
  leaseId: string;
  nodeId: string;
  generation: number;
  accepted: boolean;
  /** Amount actually credited back to the lease's window budget. */
  credited: number;
  /** Window the credit applies to; null when nothing was credited. */
  windowIndex: number | null;
  reason?: ReturnRejectReason;
  /** Coordinator reading at decision time. */
  at: number;
  /** True when this is a replay of an earlier decision. */
  duplicate?: boolean;
}

export interface ConsumeEntry {
  /** Per-node-generation ledger sequence, starting at 1 and contiguous. */
  seq: number;
  nodeId: string;
  generation: number;
  leaseId: string;
  tenantId: string;
  windowIndex: number;
  cost: number;
  /** Node reading at admission time. */
  at: number;
}

export type ConsumeRejectReason = 'invalid_entry' | 'lease_exhausted';

export interface ConsumeReport {
  type: 'consume.report';
  reportId: string;
  nodeId: string;
  generation: number;
  entries: ConsumeEntry[];
  sentAt: number;
}

export interface ConsumeAck {
  type: 'consume.ack';
  reportId: string;
  nodeId: string;
  generation: number;
  accepted: number[];
  duplicates: number[];
  rejected: Array<{ seq: number; reason: ConsumeRejectReason }>;
}

export type NodeToCoordinatorMessage = BorrowRequest | ReturnIntent | ConsumeReport;
export type CoordinatorToNodeMessage = BorrowResponse | ReturnConfirm | ConsumeAck;
export type WireMessage = NodeToCoordinatorMessage | CoordinatorToNodeMessage;

export function isBorrowRequest(msg: WireMessage): msg is BorrowRequest {
  return msg.type === 'borrow.request';
}
export function isBorrowResponse(msg: WireMessage): msg is BorrowResponse {
  return msg.type === 'borrow.response';
}
export function isReturnIntent(msg: WireMessage): msg is ReturnIntent {
  return msg.type === 'return.intent';
}
export function isReturnConfirm(msg: WireMessage): msg is ReturnConfirm {
  return msg.type === 'return.confirm';
}
export function isConsumeReport(msg: WireMessage): msg is ConsumeReport {
  return msg.type === 'consume.report';
}
export function isConsumeAck(msg: WireMessage): msg is ConsumeAck {
  return msg.type === 'consume.ack';
}

/** Positive safe integer (rejects NaN, Infinity, fractions, zero, negatives). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Non-negative safe integer. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
