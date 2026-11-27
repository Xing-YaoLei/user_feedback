/**
 * Content-Type negotiation for gRPC-Web responses.
 *
 * The gRPC-Web spec defines four media types:
 *
 *     application/grpc-web          binary
 *     application/grpc-web+proto    binary
 *     application/grpc-web-text     base64
 *     application/grpc-web-text+proto base64
 *
 * Parameters such as `; charset=utf-8` are ignored.  Anything else is rejected
 * explicitly rather than guessed at.
 */

import { UnsupportedContentTypeError } from './errors.ts';
import type { GrpcWebMode } from './decoder.ts';

export interface ParsedContentType {
  /** The declared media type, lower-cased and trimmed (parameters removed). */
  readonly mediaType: string;
  /** Body encoding implied by the media type. */
  readonly mode: GrpcWebMode;
}

const BINARY_TYPES = new Set(['application/grpc-web', 'application/grpc-web+proto']);
const TEXT_TYPES = new Set(['application/grpc-web-text', 'application/grpc-web-text+proto']);

/** Parse a Content-Type header value, or throw `UnsupportedContentTypeError`. */
export function parseContentType(value: string): ParsedContentType {
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  if (BINARY_TYPES.has(mediaType)) return { mediaType, mode: 'binary' };
  if (TEXT_TYPES.has(mediaType)) return { mediaType, mode: 'text' };
  throw new UnsupportedContentTypeError(value);
}

/**
 * Pick the decoding mode for a response, preferring the explicit Content-Type
 * and falling back to the caller's default when the header is absent.
 */
export function resolveMode(contentType: string | undefined, fallback: GrpcWebMode): GrpcWebMode {
  if (contentType === undefined) return fallback;
  return parseContentType(contentType).mode;
}
