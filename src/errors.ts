/**
 * Error types exposed by the gateway.
 *
 * `BusinessError` is special: it is a *completed* business outcome produced
 * by the adapter. The gateway persists it as a terminal result instead of
 * surfacing it as a transport failure. Every other error here is a
 * gateway-level rejection and is never stored as a result.
 */

export type GatewayErrorCode =
  | 'INVALID_INPUT'
  | 'KEY_CONFLICT'
  | 'INDETERMINATE'
  | 'RESULT_EXPIRED'
  | 'TICKET_NOT_FOUND'
  | 'TICKET_NOT_INDETERMINATE'
  | 'TICKET_NOT_TERMINAL'
  | 'PROOF_MISMATCH'
  | 'PROOF_REPLAYED'
  | 'STORE_CORRUPT'
  | 'STORE_LOCKED'
  | 'WAITER_CANCELLED'
  | 'INTERNAL';

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly details: unknown;

  constructor(code: GatewayErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.details = details ?? null;
  }

  toJSON(): { name: string; code: GatewayErrorCode; message: string; details: unknown } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class InvalidInputError extends GatewayError {
  constructor(message: string, details?: unknown) {
    super('INVALID_INPUT', message, details);
    this.name = 'InvalidInputError';
  }
}

/**
 * Same idempotency key, different raw request bytes. Never executes, never
 * returns a cached result.
 */
export class KeyConflictError extends GatewayError {
  readonly existingDigest: string;
  readonly incomingDigest: string;

  constructor(
    tenant: string,
    method: string,
    idempotencyKey: string,
    existingDigest: string,
    incomingDigest: string,
  ) {
    super(
      'KEY_CONFLICT',
      `idempotency key (${tenant}/${method}/${idempotencyKey}) was already used with different request bytes`,
      { tenant, method, idempotencyKey, existingDigest, incomingDigest },
    );
    this.name = 'KeyConflictError';
    this.existingDigest = existingDigest;
    this.incomingDigest = incomingDigest;
  }
}

/** The ticket may have executed; automatic retry is refused. */
export class IndeterminateError extends GatewayError {
  readonly ticketId: string;

  constructor(ticketId: string, message: string) {
    super('INDETERMINATE', message, { ticketId });
    this.name = 'IndeterminateError';
    this.ticketId = ticketId;
  }
}

/** The terminal payload was reclaimed; the effect must not be repeated. */
export class ResultExpiredError extends GatewayError {
  constructor(ticketId: string, reclaimedAt: string | null, reason: string | null) {
    super(
      'RESULT_EXPIRED',
      `result payload for ticket ${ticketId} was reclaimed (${reason ?? 'unknown reason'}) and cannot be produced or re-executed`,
      { ticketId, reclaimedAt, reason },
    );
    this.name = 'ResultExpiredError';
  }
}

export class TicketNotFoundError extends GatewayError {
  constructor(ticketId: string) {
    super('TICKET_NOT_FOUND', `ticket ${ticketId} does not exist`, { ticketId });
    this.name = 'TicketNotFoundError';
  }
}

export class TicketNotIndeterminateError extends GatewayError {
  constructor(ticketId: string, status: string) {
    super(
      'TICKET_NOT_INDETERMINATE',
      `ticket ${ticketId} is '${status}'; only 'indeterminate' tickets can be reconciled`,
      { ticketId, status },
    );
    this.name = 'TicketNotIndeterminateError';
  }
}

export class TicketNotTerminalError extends GatewayError {
  constructor(ticketId: string, status: string) {
    super('TICKET_NOT_TERMINAL', `ticket ${ticketId} is '${status}' and has no stored result payload to reclaim`, {
      ticketId,
      status,
    });
    this.name = 'TicketNotTerminalError';
  }
}

export class ProofMismatchError extends GatewayError {
  constructor(ticketId: string, message: string, details?: Record<string, unknown>) {
    super('PROOF_MISMATCH', message, { ticketId, ...(details ?? {}) });
    this.name = 'ProofMismatchError';
  }
}

export class ProofReplayedError extends GatewayError {
  constructor(ticketId: string, proofId: string) {
    super('PROOF_REPLAYED', `proof '${proofId}' was already used for another attestation`, {
      ticketId,
      proofId,
    });
    this.name = 'ProofReplayedError';
  }
}

export class StoreCorruptError extends GatewayError {
  constructor(path: string, message: string) {
    super('STORE_CORRUPT', `store file ${path} is corrupt: ${message}`, { path });
    this.name = 'StoreCorruptError';
  }
}

export class StoreLockedError extends GatewayError {
  constructor(dir: string, owner: string) {
    super('STORE_LOCKED', `state directory ${dir} is already owned by ${owner}`, { dir, owner });
    this.name = 'StoreLockedError';
  }
}

export class WaiterCancelledError extends GatewayError {
  constructor(tenant: string, method: string, idempotencyKey: string) {
    super(
      'WAITER_CANCELLED',
      `waiter for (${tenant}/${method}/${idempotencyKey}) was cancelled; shared execution continues and its result stays recorded`,
      { tenant, method, idempotencyKey },
    );
    this.name = 'WaiterCancelledError';
  }
}

const BUSINESS_ERROR_BRAND = Symbol.for('pro117.business_error.v1');

/**
 * A deterministic, completed business rejection produced by the adapter.
 * Persisted as a terminal result, never thrown back to callers.
 *
 * The brand symbol is global so an adapter loaded from another module graph
 * is still recognised.
 */
export class BusinessError extends Error {
  readonly [BUSINESS_ERROR_BRAND] = true;
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.details = details ?? null;
  }

  toOutcome(): {
    type: 'business_error';
    error: { code: string; message: string; details?: unknown };
  } {
    const error: { code: string; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== null) error.details = this.details;
    return { type: 'business_error', error };
  }
}

export function isBusinessError(value: unknown): value is BusinessError {
  if (value instanceof BusinessError) return true;
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<symbol, unknown>)[BUSINESS_ERROR_BRAND] === true &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

export function toErrorShape(value: unknown): { name: string; message: string } {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return { name: 'NonErrorThrown', message: String(value) };
}

/** Normalizes arbitrary thrown values into a GatewayError. */
export function asGatewayError(value: unknown): GatewayError {
  if (value instanceof GatewayError) return value;
  const shape = toErrorShape(value);
  return new GatewayError('INTERNAL', `${shape.name}: ${shape.message}`);
}
