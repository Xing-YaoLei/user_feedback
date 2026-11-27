import type { ResponseHeaders } from './headers.ts';

/**
 * The request could not be satisfied with any representation the gateway is
 * able to produce. Callers should answer with `error.status` (406) and the
 * attached headers (which already carry the negotiated `Vary`).
 */
export class NotAcceptableError extends Error {
  readonly status = 406;
  readonly headers: ResponseHeaders;

  constructor(message: string, headers: ResponseHeaders) {
    super(message);
    this.name = 'NotAcceptableError';
    this.headers = headers;
  }
}

/**
 * The caller handed the encoder a response it cannot reason about, for
 * example a status other than 200/206 or a malformed body source.
 */
export class InvalidResponseError extends Error {
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidResponseError';
  }
}

/**
 * The body stream was cancelled (explicitly or because the consumer stopped
 * reading). `completion` rejects with this error so a truncated response can
 * never be mistaken for a successful one.
 */
export class BodyAbortedError extends Error {
  readonly code = 'ABORT_ERR';

  constructor(message = 'response body was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}
