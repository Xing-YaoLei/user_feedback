/**
 * HTTP-level glue for the gRPC-Web decoder.
 *
 * A gRPC-Web response is only meaningful when the HTTP layer reports 200 (the
 * server encodes call status in the trailer, not in the HTTP status) and the
 * body encoding matches the Content-Type.  This module turns a response head
 * into a correctly configured decoder stream, and rejects anything else
 * explicitly.
 *
 * Note what this does *not* do: returning 200 here is not success.  Success is
 * decided only by `stream.completion`, after the whole body (including the
 * terminal trailer) has been validated.
 */

import type { TrailerItem } from './decoder.ts';
import { HttpStatusError } from './errors.ts';
import { parseContentType } from './content-type.ts';
import { createDecoderStream, GrpcWebDecoderStream } from './stream.ts';
import type { DecoderStreamOptions } from './stream.ts';

export interface HttpResponseHead {
  readonly status: number;
  /** The response's Content-Type header, if present. */
  readonly contentType?: string | undefined;
}

export type ResponseHeadOptions = Omit<DecoderStreamOptions, 'mode'>;

/**
 * Validate an HTTP response head and create a decoder stream for its body.
 *
 * @throws {HttpStatusError} when `status` is not 200.
 * @throws {UnsupportedContentTypeError} when a Content-Type is present but is
 *   neither `application/grpc-web` nor `application/grpc-web-text`.
 */
export function createDecoderForResponse(
  head: HttpResponseHead,
  options: ResponseHeadOptions = {},
): GrpcWebDecoderStream {
  if (head.status !== 200) {
    throw new HttpStatusError(head.status);
  }
  if (head.contentType === undefined) {
    // Without a Content-Type, assume the binary wire format.
    return createDecoderStream({ ...options, mode: 'binary' });
  }
  const { mode } = parseContentType(head.contentType);
  return createDecoderStream({ ...options, mode });
}

/** A decoded body item, flattened for callers that want a simple list. */
export type DecodedHttpItem =
  | { readonly type: 'message'; readonly data: Buffer }
  | { readonly type: 'trailer'; readonly status: number };

export interface DecodedHttpResponse {
  readonly messages: Buffer[];
  readonly trailer: TrailerItem;
  readonly items: readonly DecodedHttpItem[];
}

/**
 * Decode a complete response delivered as an async byte source.
 *
 * Rejects with the decoder's protocol error for a malformed body, and with
 * `GrpcStatusError` when the (well-formed) trailer carries a non-zero status.
 */
export async function decodeHttpResponseBody(
  source: AsyncIterable<Uint8Array>,
  head: HttpResponseHead,
  options: ResponseHeadOptions & { readonly signal?: AbortSignal } = {},
): Promise<DecodedHttpResponse> {
  const stream = createDecoderForResponse(head, options);
  const items: DecodedHttpItem[] = [];
  const drained = (async (): Promise<void> => {
    for await (const item of stream) {
      items.push(
        item.type === 'message'
          ? { type: 'message', data: item.data }
          : { type: 'trailer', status: item.status },
      );
    }
  })();
  // The consumer loop rejects on stream error; observe it so the rejection is
  // reported from the loop, not as an unhandled rejection.
  drained.catch(() => {});

  try {
    for await (const chunk of source) {
      if (!stream.write(chunk)) {
        await new Promise<void>((resolve) => stream.once('drain', resolve));
      }
    }
    stream.end();
    const result = await stream.completion;
    await drained;
    return {
      messages: items.flatMap((i) => (i.type === 'message' ? [i.data] : [])),
      trailer: result.trailer,
      items,
    };
  } catch (error) {
    stream.destroy();
    await drained.catch(() => {});
    throw error;
  }
}
