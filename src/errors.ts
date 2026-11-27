/**
 * Error hierarchy for the gRPC-Web response decoder.
 *
 * Every error carries a stable machine-readable `code`.  A non-zero gRPC
 * status (`GrpcStatusError`, code `GRPC_STATUS`) is a *completed call with a
 * failed outcome*; it is deliberately distinct from wire-format errors
 * (`ProtocolError` and its subclasses), which mean the response could not be
 * decoded at all.
 */

import type { Trailer } from './trailer.ts';

export type GrpcWebErrorCode =
  | 'UNSUPPORTED_COMPRESSION'
  | 'MALFORMED_FRAME'
  | 'FRAME_AFTER_TRAILER'
  | 'TRUNCATED_INPUT'
  | 'MALFORMED_BASE64'
  | 'MALFORMED_TRAILER'
  | 'MISSING_TRAILER'
  | 'MISSING_GRPC_STATUS'
  | 'DUPLICATE_GRPC_STATUS'
  | 'INVALID_GRPC_STATUS'
  | 'MESSAGE_TOO_LARGE'
  | 'TRAILER_TOO_LARGE'
  | 'BUFFER_LIMIT_EXCEEDED'
  | 'GRPC_STATUS'
  | 'CANCELLED'
  | 'HTTP_STATUS'
  | 'UNSUPPORTED_CONTENT_TYPE';

export class GrpcWebError extends Error {
  readonly code: GrpcWebErrorCode;

  constructor(message: string, code: GrpcWebErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Structural / wire-format problem in the response body. */
export class ProtocolError extends GrpcWebError {}

/** A frame carried a compression flag; compressed payloads are unsupported. */
export class UnsupportedCompressionError extends GrpcWebError {
  constructor(message = 'compressed gRPC-Web frames are not supported') {
    super(message, 'UNSUPPORTED_COMPRESSION');
  }
}

/** A configured size / buffering limit was exceeded. */
export class LimitError extends GrpcWebError {}

/**
 * The response ended with a well-formed trailer whose `grpc-status` was not 0.
 *
 * This is a valid, fully-received response whose *call* failed.  It is
 * distinct from `ProtocolError`, so callers can tell "the server answered
 * FAILED_PRECONDITION" apart from "the bytes on the wire were unreadable".
 */
export class GrpcStatusError extends GrpcWebError {
  readonly status: number;
  readonly statusText: string;
  /** Percent-decoded `grpc-message`, or undefined when the field was absent. */
  readonly grpcMessage: string | undefined;
  /** Raw on-the-wire `grpc-message`, or undefined when absent. */
  readonly rawGrpcMessage: string | undefined;
  readonly trailer: Trailer;

  constructor(
    status: number,
    statusText: string,
    grpcMessage: string | undefined,
    rawGrpcMessage: string | undefined,
    trailer: Trailer,
  ) {
    let message = `gRPC status ${status} (${statusText})`;
    if (grpcMessage) message += `: ${grpcMessage}`;
    super(message, 'GRPC_STATUS');
    this.status = status;
    this.statusText = statusText;
    this.grpcMessage = grpcMessage;
    this.rawGrpcMessage = rawGrpcMessage;
    this.trailer = trailer;
  }
}

/** Decoding was cancelled through `cancel()`, an AbortSignal or destroy(). */
export class CancelledError extends GrpcWebError {
  constructor(cause?: unknown) {
    super('gRPC-Web decoding was cancelled', 'CANCELLED', { cause });
  }
}

/** The HTTP layer returned a non-200 status. */
export class HttpStatusError extends GrpcWebError {
  readonly status: number;

  constructor(status: number) {
    super(`gRPC-Web responses require HTTP 200, received HTTP ${status}`, 'HTTP_STATUS');
    this.status = status;
  }
}

/** The Content-Type is neither grpc-web nor grpc-web-text. */
export class UnsupportedContentTypeError extends GrpcWebError {
  readonly contentType: string;

  constructor(contentType: string) {
    super(
      `unsupported gRPC-Web Content-Type ${JSON.stringify(contentType)}; ` +
        'expected application/grpc-web[...] or application/grpc-web-text[...]',
      'UNSUPPORTED_CONTENT_TYPE',
    );
    this.contentType = contentType;
  }
}

const GRPC_STATUS_NAMES: readonly string[] = Object.freeze([
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
]);

/** Highest defined gRPC status code. */
export const GRPC_STATUS_MAX = GRPC_STATUS_NAMES.length - 1;

/** Human-readable name for a gRPC status code. */
export function grpcStatusName(status: number): string {
  return GRPC_STATUS_NAMES[status] ?? 'UNKNOWN_STATUS';
}
