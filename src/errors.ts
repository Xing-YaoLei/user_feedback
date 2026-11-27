/**
 * Errors raised by the connection lease pool.
 *
 * Every error carries a stable `code` string so callers can branch on the
 * failure category without relying on message text.
 */

export type PoolErrorOptions = {
  cause?: unknown;
};

export class PoolError extends Error {
  code: string;

  constructor(message: string, code: string, options?: PoolErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The pool has been closed and no longer accepts new borrows. */
export class PoolClosedError extends PoolError {
  constructor(message = 'The pool is closed and no longer accepts borrows.') {
    super(message, 'POOL_CLOSED');
  }
}

/** A borrower waited longer than its allowed deadline. */
export class BorrowTimeoutError extends PoolError {
  timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`No connection became available within the ${timeoutMs}ms borrow deadline.`, 'BORROW_TIMEOUT');
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's AbortSignal cancelled a pending borrow. */
export class BorrowAbortedError extends PoolError {
  reason: unknown;

  constructor(reason?: unknown) {
    super(
      'The borrow request was cancelled by its AbortSignal.',
      'BORROW_ABORTED',
      reason === undefined ? undefined : { cause: reason },
    );
    this.reason = reason;
  }
}

/** The adapter failed while creating a connection for the requesting waiter. */
export class ConnectionCreateError extends PoolError {
  constructor(cause: unknown) {
    super('The connection adapter failed to create a connection.', 'CREATE_FAILED', { cause });
  }
}

/** A token that does not identify the current lease of any borrowed slot. */
export class LeaseInvalidError extends PoolError {
  leaseId: string;

  constructor(leaseId: string, code = 'LEASE_INVALID', message?: string) {
    super(message ?? `Lease ${leaseId} is not the active lease for its connection.`, code);
    this.leaseId = leaseId;
  }
}

/**
 * The same lease credential was returned more than once. This also covers an
 * old token used after the same underlying connection has been leased again.
 */
export class LeaseAlreadyReleasedError extends LeaseInvalidError {
  constructor(leaseId: string) {
    super(
      leaseId,
      'LEASE_ALREADY_RELEASED',
      `Lease ${leaseId} has already been returned and is no longer a valid credential.`,
    );
  }
}

/** Pool construction received an invalid configuration value. */
export class PoolConfigurationError extends PoolError {
  constructor(message: string) {
    super(message, 'INVALID_CONFIGURATION');
  }
}
