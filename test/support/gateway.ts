/**
 * Test-side caller adapter.
 *
 * This is deliberately *outside* the module: it is a small stand-in for the
 * gateway integration. It takes a request/response pair the way a proxy would
 * see it, runs it through the encoder, and materialises the result the way an
 * HTTP server would — status line, headers, and the raw body bytes.
 *
 * Keeping the adapter here (rather than in `src/`) keeps the library
 * transport-agnostic while still exercising the exact call shape a caller
 * uses.
 */

import zlib from 'node:zlib';
import { encodeResponse, NotAcceptableError, type EncoderOptions } from '../../src/index.ts';

export interface IncomingRequest {
  method?: string;
  headers: Record<string, string>;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** Decoded with the negotiated coding; throws when the body is truncated. */
  decode(): Buffer;
  /** True when the module actually applied a content coding. */
  compressed: boolean;
  /** Resolves when the encoder has finished writing the trailer, rejects on abort/failure. */
  completion: Promise<void>;
  /** Cancel the body the way a dropped client connection would. */
  cancel(reason?: unknown): Promise<void>;
}

export interface CallOptions extends EncoderOptions {
  /** Stop consuming after this many body chunks (simulates a slow/absent client). */
  stopAfterChunks?: number;
}

export interface GatewayCallResult {
  response: WireResponse;
  /** Number of body chunks handed to the client, in order. */
  chunks: Buffer[];
  /** True when the module decided the response is not acceptable. */
  notAcceptable: boolean;
  /** The 406 response when `notAcceptable` is true. */
  rejection?: { status: number; headers: Record<string, string> };
}

/**
 * Run one request/response pair. Mirrors what a gateway handler does:
 * negotiate, write headers, then stream the body to the client.
 */
export async function callGateway(
  request: IncomingRequest,
  upstream: UpstreamResponse,
  options: CallOptions = {},
): Promise<GatewayCallResult> {
  const { stopAfterChunks, ...encoderOptions } = options;
  let encoded;
  try {
    encoded = encodeResponse({
      preferences: request.headers['accept-encoding'] ?? '',
      response: { status: upstream.status, headers: upstream.headers },
      body: upstream.body as never,
      options: encoderOptions,
    });
  } catch (error) {
    if (error instanceof NotAcceptableError) {
      return {
        response: {
          status: error.status,
          headers: error.headers.toObject(),
          body: Buffer.alloc(0),
          decode: () => Buffer.alloc(0),
          compressed: false,
          completion: Promise.resolve(),
          cancel: async () => {},
        },
        chunks: [],
        notAcceptable: true,
        rejection: { status: error.status, headers: error.headers.toObject() },
      };
    }
    throw error;
  }

  const chunks: Buffer[] = [];
  let index = 0;
  for await (const chunk of encoded.body) {
    chunks.push(Buffer.from(chunk));
    index += 1;
    if (stopAfterChunks !== undefined && index >= stopAfterChunks) {
      await encoded.cancel();
      break;
    }
  }

  const body = Buffer.concat(chunks);
  const headers = encoded.headers.toObject();
  return {
    response: {
      status: encoded.status,
      headers,
      body,
      compressed: encoded.compressed,
      completion: encoded.completion,
      cancel: (reason?: unknown) => encoded.cancel(reason),
      decode: () => decodeBody(body, headers),
    },
    chunks,
    notAcceptable: false,
  };
}

/** Decode a body according to the response's `Content-Encoding`. */
export function decodeBody(body: Buffer, headers: Record<string, string>): Buffer {
  const codings = (headers['content-encoding'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  let result = body;
  for (const coding of codings.reverse()) {
    if (coding === 'identity') continue;
    if (coding === 'gzip') result = zlib.gunzipSync(result);
    else if (coding === 'br') result = zlib.brotliDecompressSync(result);
    else if (coding === 'deflate') result = zlib.inflateSync(result);
    else throw new Error(`adapter cannot decode coding ${coding}`);
  }
  return result;
}

/** A body source that fails after emitting `head`, which is what an upstream error looks like. */
export function failingSource(options: {
  head: Buffer[];
  error?: Error;
  /** Called once the module has pulled every head chunk. */
  onDrained?: () => void;
}): AsyncIterable<Buffer> {
  const error = options.error ?? new Error('upstream failed');
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of options.head) {
        yield chunk;
        await new Promise((resolve) => setImmediate(resolve));
      }
      options.onDrained?.();
      throw error;
    },
  };
}

/** Deterministic, poorly compressible bytes so tests can reason about sizes. */
export function syntheticBytes(length: number, seed = 1): Buffer {
  const buffer = Buffer.alloc(length);
  let state = (seed * 2654435761) >>> 0;
  for (let offset = 0; offset < length; offset += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer.writeUInt32LE(state, offset);
  }
  return buffer;
}

/** Resolve/reject a promise with a timeout so a hung stream fails the test fast. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}
