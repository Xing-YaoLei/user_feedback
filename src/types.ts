/**
 * Public types for the lease-based lock coordinator.
 */

export type LockMode = 'shared' | 'exclusive';

/** A single resource request inside an acquire batch. */
export interface LockRequest {
  resource: string;
  mode: LockMode;
}

/** Result returned for a successfully acquired resource lock. */
export interface AcquiredLock {
  resource: string;
  mode: LockMode;
  /**
   * Strictly increasing per-resource fencing token. Present only when the
   * resulting held mode on that resource is exclusive (new exclusive grant or
   * a shared -> exclusive upgrade).
   */
  fencingToken?: number;
}

/** Why a transaction was aborted / ended. */
export type AbortReason =
  | 'cancelled'
  | 'deadline-exceeded'
  | 'session-expired'
  | 'deadlock-victim';

/** How a transaction ended (commit/rollback are normal completion). */
export type EndReason = AbortReason | 'committed' | 'rolled-back';

/** Error code carried by {@link CoordinatorError}. */
export type CoordinatorErrorCode =
  | 'TRANSACTION_ENDED'
  | 'SESSION_EXPIRED'
  | 'DEADLOCK'
  | 'CANCELLED'
  | 'DEADLINE_EXCEEDED'
  | 'INVALID_REQUEST';

/** Injected clock. The coordinator never reads the wall clock directly. */
export interface Clock {
  now(): number;
}

/** Options for creating a session. */
export interface CreateSessionOptions {
  /** Logical lease length. Session expires at createdAt + leaseLength. */
  leaseLength: number;
  sessionId?: string;
}

/** Options for starting a transaction. */
export interface StartTransactionOptions {
  /** Absolute logical time after which the transaction is aborted. */
  deadline?: number;
  transactionId?: string;
}

/** A snapshot row of a resource's wait queue (head first). */
export interface QueueEntrySnapshot {
  transactionId: string;
  mode: LockMode;
  /** True when this entry upgrades a shared lock the transaction already holds. */
  isUpgrade: boolean;
}

/** A snapshot row of a currently held lock. */
export interface HeldLockSnapshot {
  resource: string;
  mode: LockMode;
  /** Fencing token of the current exclusive holding, when mode is exclusive. */
  fencingToken?: number;
}

/** Emitted whenever a batch (or part of one) is granted. */
export interface GrantEvent {
  type: 'grant';
  transactionId: string;
  locks: ReadonlyArray<AcquiredLock>;
  at: number;
}

/** Emitted exactly once when a transaction ends. */
export interface TransactionEndEvent {
  type: 'transaction-end';
  transactionId: string;
  reason: EndReason;
  at: number;
}

export type CoordinatorEvent = GrantEvent | TransactionEndEvent;
