/**
 * Shared domain types for the idempotent RPC entry point.
 *
 * Everything that reaches disk is JSON-only. These shapes are the durable
 * contract between the manager, the reconciler and the recovery path.
 */

export type TicketStatus =
  | 'pending'
  | 'succeeded'
  | 'business_error'
  | 'indeterminate'
  | 'not_executed';

export interface TerminalSuccess {
  type: 'success';
  value: unknown;
}

export interface TerminalBusinessError {
  type: 'business_error';
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** A result that is safe to return to every caller of the same key. */
export type TerminalOutcome = TerminalSuccess | TerminalBusinessError;

export function isTerminalOutcome(value: unknown): value is TerminalOutcome {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'success' || type === 'business_error';
}

export interface ReconciliationRecord {
  proofId: string;
  kind: 'completed' | 'not_executed';
  attestedAt: string;
  recordedAt: string;
  note: string | null;
}

/**
 * One execution attempt for one idempotency key.
 *
 * The ticket is written (and fsynced) before the adapter is invoked. A
 * ticket still `pending` after a manager restart becomes `indeterminate`:
 * execution may have happened, so it is never executed again automatically.
 */
export interface TicketRecord {
  schemaVersion: 1;
  ticketId: string;
  keyHash: string;
  tenant: string;
  method: string;
  idempotencyKey: string;
  /** sha256 of the exact request bytes. */
  requestDigest: string;
  requestSize: number;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  ownerPid: number;
  ownerHostname: string;
  status: TicketStatus;
  outcome: TerminalOutcome | null;
  outcomeStoredAt: string | null;
  outcomeExpiresAt: string | null;
  outcomeReclaimedAt: string | null;
  /** Digest of the dropped payload; retained as evidence of what was stored. */
  reclaimedOutcomeDigest: string | null;
  reclaimReason: 'ttl' | 'admin' | null;
  indeterminateReason: string | null;
  lastError: { name: string; message: string } | null;
  reconciliation: ReconciliationRecord | null;
}

/**
 * The per-key ledger. It outlives every payload lifecycle event: it holds
 * the idempotency identity and the digest of the accepted request bytes.
 */
export interface EntryRecord {
  schemaVersion: 1;
  keyHash: string;
  tenant: string;
  method: string;
  idempotencyKey: string;
  requestDigest: string;
  requestSize: number;
  createdAt: string;
  updatedAt: string;
  ticketIds: string[];
  headTicketId: string | null;
}

/**
 * The durable "execution may have started" fact, written and fsynced after
 * the ticket and ledger, immediately before the adapter is called. Its
 * absence/presence explains the crash window in recovery notes.
 */
export interface ExecutionIntentRecord {
  schemaVersion: 1;
  ticketId: string;
  keyHash: string;
  sequence: number;
  requestDigest: string;
  createdAt: string;
}

/**
 * Executor-supplied reconciliation proof, stored once and globally bound to
 * a single proof id so the same attestation cannot be replayed elsewhere.
 */
export interface ProofRecord {
  schemaVersion: 1;
  proofId: string;
  /** sha256 of the proof id; the file name. */
  proofIdHash: string;
  /** sha256 of the canonical proof body; detects contradictory replays. */
  contentHash: string;
  keyHash: string;
  ticketId: string;
  kind: ReconciliationProof['kind'];
  recordedAt: string;
  proof: ReconciliationProof;
}

/**
 * First-attestation binding for one ticket.
 *
 * Reconciliation is irreversible: once an executor has attested anything
 * about a ticket, no *different* attestation may be applied to it, even if a
 * crash left the ticket indeterminate before the proof was applied. Without
 * this, a crash between the proof write and the ticket write could be
 * "resolved" by a contradictory proof and unlock a second execution.
 */
export interface AttestationRecord {
  schemaVersion: 1;
  ticketId: string;
  keyHash: string;
  proofId: string;
  contentHash: string;
  kind: ReconciliationProof['kind'];
  recordedAt: string;
}

export interface IdempotencyIdentity {
  tenant: string;
  method: string;
  idempotencyKey: string;
}

export interface InvokeInput extends IdempotencyIdentity {
  /** Exact request bytes; the digest is computed over this buffer. */
  body: Uint8Array | ArrayBuffer | string;
  /** Cancels only this waiter. It never cancels the shared execution. */
  signal?: AbortSignal;
}

export interface InvokeResult extends IdempotencyIdentity {
  ticketId: string;
  outcome: TerminalOutcome;
}

export interface AdapterExecutionInput extends IdempotencyIdentity {
  ticketId: string;
  sequence: number;
  /** The accepted request bytes for this execution. */
  body: Uint8Array;
}

export interface ExecutionAdapter {
  /**
   * Perform the side effect.
   *
   * Throw {@link BusinessError} only for a deterministic, completed business
   * rejection. Any other error is treated as "execution state unknown": the
   * ticket becomes indeterminate and is never retried automatically.
   */
  execute(input: AdapterExecutionInput): Promise<unknown>;
}

export interface ReconciliationCompletedProof {
  kind: 'completed';
  /** Executor-side non-reversible reference for this attestation. */
  proofId: string;
  outcome: TerminalOutcome;
  attestedAt?: string;
  note?: string;
}

export interface ReconciliationNotExecutedProof {
  kind: 'not_executed';
  /** The only proof kind that permits a fresh ticket and a retry. */
  proofId: string;
  attestedAt?: string;
  note?: string;
}

export type ReconciliationProof =
  | ReconciliationCompletedProof
  | ReconciliationNotExecutedProof;

export interface ReconcileInput {
  ticketId: string;
  proof: ReconciliationProof;
  /**
   * Optional identity of the key. When supplied it is checked against the
   * ticket, so a proof cannot be applied to a ticket of another key.
   */
  tenant?: string;
  method?: string;
  idempotencyKey?: string;
}

export type DerivedStatus =
  | 'pending'
  | 'indeterminate'
  | 'not_executed'
  | 'completed'
  | 'expired'
  | 'corrupt';

export interface TicketView {
  ticketId: string;
  keyHash: string;
  tenant: string;
  method: string;
  idempotencyKey: string;
  requestDigest: string;
  sequence: number;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  hasOutcome: boolean;
  outcomeType: TerminalOutcome['type'] | null;
  outcomeStoredAt: string | null;
  outcomeExpiresAt: string | null;
  outcomeReclaimedAt: string | null;
  reclaimedOutcomeDigest: string | null;
  reclaimReason: 'ttl' | 'admin' | null;
  indeterminateReason: string | null;
  reconciliation: ReconciliationRecord | null;
  ownerPid: number;
}

export interface KeyView extends IdempotencyIdentity {
  keyHash: string;
  requestDigest: string;
  requestSize: number;
  headTicketId: string | null;
  ticketIds: string[];
  derivedStatus: DerivedStatus;
  tickets: TicketView[];
}

export interface ReclaimResult {
  ticketId: string;
  reclaimed: boolean;
  alreadyReclaimed: boolean;
  ticket: TicketView;
}

export interface ReclaimExpiredResult {
  reclaimed: ReclaimResult[];
  checkedAt: string;
}

export interface RecoveryReport {
  recoveredAt: string;
  indeterminateTicketIds: string[];
  sweptTempFiles: string[];
}
