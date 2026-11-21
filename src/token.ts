import { createHmac, randomBytes } from 'node:crypto';
import { InvalidArgumentError, InvalidTokenError } from './errors.ts';
import type { Revision } from './types.ts';

/** Payload carried by a pagination continuation token. */
export interface PageTokenPayload {
  /** Directory identity: tokens cannot cross directories. */
  d: string;
  /** Cursor id owning the pinned snapshot. */
  c: string;
  /** Snapshot revision. */
  r: Revision;
  /** Offset into the snapshot's ordered matching names. */
  o: number;
  /** Prefix used to build the snapshot. */
  p: string;
}

const TOKEN_VERSION = 1;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Buffer {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

/**
 * Signs and verifies pagination tokens. Tokens are self-describing and
 * tamper-evident: changing the cursor, revision or offset invalidates the
 * signature. Replay is harmless because every field is verified onto an
 * existing cursor.
 */
export class TokenCodec {
  private readonly key: Buffer;

  constructor(secret?: string | Uint8Array) {
    if (secret === undefined) {
      this.key = randomBytes(32);
    } else if (typeof secret === 'string') {
      if (secret.length < 8) {
        throw new InvalidArgumentError('secret must contain at least 8 characters');
      }
      this.key = Buffer.from(secret, 'utf8');
    } else {
      if (secret.byteLength < 8) {
        throw new InvalidArgumentError('secret must contain at least 8 bytes');
      }
      this.key = Buffer.from(secret);
    }
  }

  encode(payload: PageTokenPayload): string {
    const body = base64url(Buffer.from(JSON.stringify({ v: TOKEN_VERSION, ...payload }), 'utf8'));
    return body + '.' + this.sign(body);
  }

  decode(token: string): PageTokenPayload {
    if (typeof token !== 'string' || token.length === 0) {
      throw new InvalidTokenError('token must be a non-empty string');
    }
    const dot = token.lastIndexOf('.');
    if (dot <= 0 || dot === token.length - 1) {
      throw new InvalidTokenError('token is not in <body>.<signature> form');
    }
    const body = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = this.sign(body);
    if (!timingSafeEqualHex(signature, expected)) {
      throw new InvalidTokenError('token signature mismatch');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fromBase64url(body).toString('utf8'));
    } catch {
      throw new InvalidTokenError('token body is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new InvalidTokenError('token body is not an object');
    }
    const rec = parsed as Record<string, unknown>;
    if (rec.v !== TOKEN_VERSION) {
      throw new InvalidTokenError(`unsupported token version ${String(rec.v)}`);
    }
    const { d, c, r, o, p } = rec;
    if (typeof d !== 'string' || typeof c !== 'string' || typeof p !== 'string') {
      throw new InvalidTokenError('token body has malformed fields');
    }
    if (typeof r !== 'number' || !Number.isSafeInteger(r) || r < 0) {
      throw new InvalidTokenError('token revision is malformed');
    }
    if (typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) {
      throw new InvalidTokenError('token offset is malformed');
    }
    return { d, c, r, o, p };
  }

  private sign(body: string): string {
    return base64url(createHmac('sha256', this.key).update(body).digest());
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
