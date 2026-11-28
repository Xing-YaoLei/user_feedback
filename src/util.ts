import { createHash } from 'node:crypto';
import { InvalidInputError } from './errors.ts';
import type { IdempotencyIdentity } from './types.ts';

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Stable, filesystem-safe identity hash. Every component is length-prefixed
 * before hashing so that `("a","bc")` and `("ab","c")` cannot collide.
 */
export function keyHashFor(identity: IdempotencyIdentity): string {
  const parts = [identity.tenant, identity.method, identity.idempotencyKey];
  const h = createHash('sha256');
  h.update('pro117-idempotency-key-v1');
  for (const part of parts) {
    const buf = Buffer.from(part, 'utf8');
    h.update(Buffer.from([buf.length >>> 24, (buf.length >>> 16) & 0xff, (buf.length >>> 8) & 0xff, buf.length & 0xff]));
    h.update(buf);
  }
  return h.digest('hex');
}

export function assertPlainString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidInputError(`${field} must be a string`, { field, received: typeof value });
  }
  if (value.length === 0) {
    throw new InvalidInputError(`${field} must not be empty`, { field });
  }
  return value;
}

export function assertIdentity(identity: IdempotencyIdentity): IdempotencyIdentity {
  return {
    tenant: assertPlainString(identity.tenant, 'tenant'),
    method: assertPlainString(identity.method, 'method'),
    idempotencyKey: assertPlainString(identity.idempotencyKey, 'idempotencyKey'),
  };
}

export function normalizeBody(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw new InvalidInputError('body must be a Uint8Array, ArrayBuffer or string');
}

/** JSON with recursively sorted object keys, for deterministic digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Short, human-debuggable identifier for a ticket. */
export function makeTicketId(keyHash: string, sequence: number, nonce: string): string {
  const h = createHash('sha256');
  h.update(keyHash);
  h.update(':');
  h.update(String(sequence));
  h.update(':');
  h.update(nonce);
  return `tkt_${h.digest('hex').slice(0, 32)}`;
}

export function nowIso(clock?: () => Date): string {
  return (clock ? clock() : new Date()).toISOString();
}
