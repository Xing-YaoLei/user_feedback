/**
 * gRPC-Web response decoder — public module entry.
 *
 * ```ts
 * import { createDecoderStream } from './src/index.ts';
 *
 * const decoder = createDecoderStream({ mode: 'text' });
 * httpResponse.on('data', (chunk) => decoder.write(chunk));
 * httpResponse.on('end', () => decoder.end());
 * for await (const item of decoder) {
 *   if (item.type === 'message') handle(item.data);
 * }
 * const { trailer } = await decoder.completion; // rejects if the call failed
 * ```
 */

export {
  GrpcWebResponseDecoder,
  decodeChunks,
  decodeResponse,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_MAX_TRAILER_SIZE,
  DEFAULT_MAX_UNPARSED_BYTES,
} from './decoder.ts';
export type {
  DecodeOptions,
  DecodedItem,
  DecodedResponse,
  DecoderOptions,
  GrpcWebMode,
  MessageItem,
  TrailerItem,
} from './decoder.ts';

export { GrpcWebDecoderStream, createDecoderStream } from './stream.ts';
export type { DecoderStreamOptions, DecoderStreamResult } from './stream.ts';

export {
  createDecoderForResponse,
  decodeHttpResponseBody,
} from './http.ts';
export type {
  DecodedHttpItem,
  DecodedHttpResponse,
  HttpResponseHead,
  ResponseHeadOptions,
} from './http.ts';

export {
  CancelledError,
  GRPC_STATUS_MAX,
  GrpcStatusError,
  GrpcWebError,
  HttpStatusError,
  LimitError,
  ProtocolError,
  UnsupportedCompressionError,
  UnsupportedContentTypeError,
  grpcStatusName,
} from './errors.ts';
export type { GrpcWebErrorCode } from './errors.ts';

export {
  Base64StreamDecoder,
  encodeBase64Segment,
} from './base64.ts';
export { parseContentType, resolveMode } from './content-type.ts';
export type { ParsedContentType } from './content-type.ts';
export {
  encodeFrame,
  FLAG_COMPRESSED,
  FLAG_DATA,
  FLAG_TRAILER,
  FrameReader,
  HEADER_SIZE,
} from './frame.ts';
export type { FrameEvent } from './frame.ts';
export { decodeGrpcMessage, parseTrailer, validateTrailer } from './trailer.ts';
export type { Trailer, TrailerField, ValidatedTrailer } from './trailer.ts';
