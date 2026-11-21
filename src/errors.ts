/**
 * Error type for all coordinator rejections.
 * `code` is machine-readable; `reason` carries the abort cause when applicable.
 */
import type { AbortReason, CoordinatorErrorCode } from './types.ts';

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;
  readonly reason?: AbortReason;

  constructor(code: CoordinatorErrorCode, message: string, reason?: AbortReason) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

export function abortCode(reason: AbortReason): CoordinatorErrorCode {
  switch (reason) {
    case 'cancelled':
      return 'CANCELLED';
    case 'deadline-exceeded':
      return 'DEADLINE_EXCEEDED';
    case 'session-expired':
      return 'SESSION_EXPIRED';
    case 'deadlock-victim':
      return 'DEADLOCK';
  }
}
