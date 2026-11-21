import type { CursorExpiredInfo } from './types.ts';

export type RegistryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'CURSOR_EXPIRED'
  | 'CURSOR_CLOSED'
  | 'CURSOR_CAPACITY'
  | 'LEASE_EXPIRED'
  | 'LEASE_NOT_FOUND'
  | 'LEASE_SESSION_MISMATCH'
  | 'DIRECTORY_CLOSED'
  | 'NOT_FOUND';

/** Base class for every expected registry failure. */
export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

export class InvalidArgumentError extends RegistryError {
  constructor(message: string) {
    super('INVALID_ARGUMENT', message);
    this.name = 'InvalidArgumentError';
  }
}

/** A pagination token is malformed, tampered with, or belongs to another directory. */
export class InvalidTokenError extends RegistryError {
  constructor(message: string) {
    super('INVALID_TOKEN', message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * A pagination token is authentic but its snapshot revision has left retained
 * history. The caller must restart pagination from the current directory.
 */
export class SnapshotUnavailableError extends RegistryError {
  readonly tokenRevision: number;
  readonly oldestRetainedRevision: number | null;
  readonly currentRevision: number;
  readonly rebuild: { reason: 'history-compacted'; sinceRevision: number };

  constructor(tokenRevision: number, oldestRetainedRevision: number | null, currentRevision: number) {
    super(
      'SNAPSHOT_UNAVAILABLE',
      `pagination snapshot at revision ${tokenRevision} is no longer available ` +
        `(oldest retained ${oldestRetainedRevision ?? 'none'}, current ${currentRevision}); restart pagination`,
    );
    this.name = 'SnapshotUnavailableError';
    this.tokenRevision = tokenRevision;
    this.oldestRetainedRevision = oldestRetainedRevision;
    this.currentRevision = currentRevision;
    this.rebuild = { reason: 'history-compacted', sinceRevision: currentRevision };
  }
}

/** A subscription cursor cannot resume; rebuild from `info.rebuild.sinceRevision`. */
export class CursorExpiredError extends RegistryError {
  readonly info: CursorExpiredInfo;

  constructor(info: CursorExpiredInfo) {
    super('CURSOR_EXPIRED', info.message);
    this.name = 'CursorExpiredError';
    this.info = info;
  }
}

/** The cursor was explicitly closed by the caller, completed, or retired by capacity. */
export class CursorClosedError extends RegistryError {
  readonly cursorId: string;
  readonly kind: 'page' | 'subscription';
  readonly reason: string;

  constructor(kind: 'page' | 'subscription', cursorId: string, reason: string) {
    super('CURSOR_CLOSED', `${kind} cursor ${cursorId} is closed (${reason})`);
    this.name = 'CursorClosedError';
    this.kind = kind;
    this.cursorId = cursorId;
    this.reason = reason;
  }
}

/** A lease was already expired/closed, so late renew/release must not mutate state. */
export class LeaseExpiredError extends RegistryError {
  readonly leaseId: string;

  constructor(leaseId: string, sessionId: string, detail: string) {
    super('LEASE_EXPIRED', `lease ${leaseId} for session ${sessionId} is not active: ${detail}`);
    this.name = 'LeaseExpiredError';
    this.leaseId = leaseId;
  }
}

/** A lease id is unknown to this directory. */
export class LeaseNotFoundError extends RegistryError {
  readonly leaseId: string;

  constructor(leaseId: string) {
    super('LEASE_NOT_FOUND', `lease ${leaseId} is unknown`);
    this.name = 'LeaseNotFoundError';
    this.leaseId = leaseId;
  }
}

/** A lease id exists but belongs to a different session or generation. */
export class LeaseSessionMismatchError extends RegistryError {
  readonly leaseId: string;

  constructor(leaseId: string, message: string) {
    super('LEASE_SESSION_MISMATCH', message);
    this.name = 'LeaseSessionMismatchError';
    this.leaseId = leaseId;
  }
}

export class DirectoryClosedError extends RegistryError {
  constructor() {
    super('DIRECTORY_CLOSED', 'directory is closed');
    this.name = 'DirectoryClosedError';
  }
}
