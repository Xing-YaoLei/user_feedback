import { Readable, pipeline } from 'node:stream';
import type { Duplex } from 'node:stream';
import zlib from 'node:zlib';
import { BodyAbortedError, InvalidResponseError, NotAcceptableError, toError } from './errors.ts';
import { ResponseHeaders, weakenEtag } from './headers.ts';
import {
  normalizePreferences,
  qualityFor,
  selectCoding,
  type AcceptEncodingInput,
  type ParsedPreferences,
} from './preferences.ts';

/** A single chunk of a response body. */
export type BodyChunk = Uint8Array | string;

/**
 * Anything the encoder can stream. Node `Readable`s are used directly; other
 * iterables are wrapped in a `Readable` with the configured high-water mark,
 * which is what bounds how far ahead the upstream may run.
 */
export type BodySource =
  | Readable
  | AsyncIterable<BodyChunk>
  | Iterable<BodyChunk>
  | Uint8Array
  | string
  | null
  | undefined;

export interface ResponseDescription {
  /** Only `200` and `206` are supported. */
  status: number;
  headers?: ResponseHeaders | ReadonlyArray<readonly [string, string]> | Record<string, string | number | readonly string[] | undefined> | null;
}

export interface CompressorContext {
  coding: string;
  highWaterMark: number;
}

/**
 * Hook used to build the transform that applies a content coding. The
 * default implementation is zlib with a flush after every chunk, which is
 * what makes the encoder stream incrementally instead of buffering.
 */
export type CompressorFactory = (coding: string, context: CompressorContext) => Duplex;

export interface EncoderOptions {
  /** Codings the gateway can produce, in preference order. Default: `['gzip', 'br']`. */
  codings?: readonly string[];
  /** Buffer cap for the source and compressor streams. Default: 64 KiB. */
  highWaterMark?: number;
  gzipOptions?: zlib.ZlibOptions;
  brotliOptions?: zlib.BrotliOptions;
  /** Aborts the response the same way {@link EncodedResponse.cancel} does. */
  signal?: AbortSignal;
  /** Advanced hook, mostly for tests and for gateways with custom dictionaries. */
  compressorFactory?: CompressorFactory;
}

export interface NegotiatedResponse {
  status: number;
  /** Headers to send, already carrying the merged `Vary` and, when the bytes change, the new length/validator rules. */
  headers: ResponseHeaders;
  /** Coding of the **output** representation. `identity` when bytes are unchanged. */
  coding: string;
  /** True only when this module applies a content coding. */
  compressed: boolean;
  /** Codings that were already present on the response (empty for a plain response). */
  existingCodings: readonly string[];
}

/** A body stream that can be cancelled and whose final state is observable. */
export interface ResponseBody extends AsyncIterable<Uint8Array> {
  /**
   * Settles after the very last body byte (including the compressor trailer)
   * has been handed to the consumer. Rejects with the upstream/compressor
   * error, or with `BodyAbortedError` when the body was cancelled.
   */
  readonly completion: Promise<void>;
  /** Bytes handed to the consumer so far. `0` means nothing is on the wire yet. */
  readonly bytesEmitted: number;
  /** True once at least one body byte has been handed to the consumer. */
  readonly started: boolean;
  /** Stops the upstream and closes the compressor. Never throws. */
  cancel(reason?: unknown): Promise<void>;
}

export interface EncodedResponse {
  status: number;
  headers: ResponseHeaders;
  coding: string;
  compressed: boolean;
  body: ResponseBody;
  completion: Promise<void>;
  /** Bytes handed to the consumer so far; `0` means the wire is still clean. */
  readonly bytesEmitted: number;
  /** True once at least one body byte has been handed to the consumer. */
  readonly started: boolean;
  cancel(reason?: unknown): Promise<void>;
}

export interface EncodeRequest {
  /** Parsed `Accept-Encoding` preferences (or the raw header). */
  preferences: AcceptEncodingInput;
  response: ResponseDescription;
  body?: BodySource;
  options?: EncoderOptions;
}

export interface ResponseEncoder {
  (request: EncodeRequest): EncodedResponse;
  negotiate(request: Pick<EncodeRequest, 'preferences' | 'response' | 'options'> & { body?: BodySource }): NegotiatedResponse;
}

const DEFAULT_CODINGS: readonly string[] = ['gzip', 'br'];
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;
const SUPPORTED_CODINGS = new Set(['gzip', 'br']);

interface ResolvedOptions {
  codings: string[];
  highWaterMark: number;
  gzipOptions: zlib.ZlibOptions;
  brotliOptions: zlib.BrotliOptions;
  compressorFactory: CompressorFactory | undefined;
  signal: AbortSignal | undefined;
}

interface PlanInput {
  prefs: ParsedPreferences;
  response: ResponseDescription;
  options: ResolvedOptions;
  hasBody: boolean;
}

/**
 * Negotiate only, without touching the body. Throws {@link NotAcceptableError}
 * when the representation cannot satisfy the request; the error carries the
 * headers (including `Vary`) to use for the 406 response.
 *
 * This assumes a body will be supplied. Use `encodeResponse(..., body: null)`
 * when the response is known to have no body.
 */
export function negotiateResponse(
  preferences: AcceptEncodingInput,
  response: ResponseDescription,
  options: EncoderOptions = {},
): NegotiatedResponse {
  return buildPlan({
    prefs: normalizePreferences(preferences),
    response,
    options: resolveOptions(options),
    hasBody: true,
  });
}

/**
 * Encode a response body according to the request's encoding preferences.
 *
 * Negotiation is eager: a 406 is thrown (and no body byte is read) before the
 * returned object exists. Everything else is lazy — the upstream is not read
 * until the caller starts iterating `body`.
 */
export function encodeResponse(request: EncodeRequest): EncodedResponse {
  if (request === null || typeof request !== 'object' || request.response === undefined) {
    throw new TypeError('encodeResponse expects { preferences, response, body }');
  }
  const options = resolveOptions(request.options ?? {});
  if (options.signal?.aborted === true) {
    // Refuse to start a response the caller has already given up on. Doing so
    // lazily would read the upstream for nothing.
    throw new BodyAbortedError('response body was aborted by the caller');
  }
  const prefs = normalizePreferences(request.preferences);
  const hasBody = request.body !== null && request.body !== undefined;
  const plan = buildPlan({ prefs, response: request.response, options, hasBody });

  const source = toNodeReadable(request.body, options.highWaterMark);
  const coding = plan.compressed ? plan.coding : 'identity';
  const body = new EncodedBodyStream(source, coding, options);
  if (options.signal !== undefined) body.attachSignal(options.signal);

  return {
    status: plan.status,
    headers: plan.headers,
    coding: plan.coding,
    compressed: plan.compressed,
    body,
    completion: body.completion,
    get bytesEmitted() {
      return body.bytesEmitted;
    },
    get started() {
      return body.started;
    },
    cancel: (reason?: unknown) => body.cancel(reason),
  };
}

/** Builds a reusable encoder with shared gateway configuration. */
export function createResponseEncoder(defaults: EncoderOptions = {}): ResponseEncoder {
  const encode = (request: EncodeRequest): EncodedResponse =>
    encodeResponse({
      ...request,
      options: mergeOptions(defaults, request.options),
    });
  const negotiate = (request: Parameters<ResponseEncoder['negotiate']>[0]): NegotiatedResponse => {
    const options = mergeOptions(defaults, request.options);
    return buildPlan({
      prefs: normalizePreferences(request.preferences),
      response: request.response,
      options: resolveOptions(options),
      // Preview semantics: unless the caller explicitly says "no body", assume
      // the response will have one. This matches `negotiateResponse`.
      hasBody: request.body !== null,
    });
  };
  return Object.assign(encode, { negotiate }) as ResponseEncoder;
}

function mergeOptions(
  a: EncoderOptions | undefined,
  b: EncoderOptions | undefined,
): EncoderOptions {
  return { ...(a ?? {}), ...(b ?? {}) };
}

function buildPlan(input: PlanInput): NegotiatedResponse {
  const { prefs, response, options, hasBody } = input;
  validateStatus(response);
  const headers = ResponseHeaders.from(response.headers ?? undefined);
  headers.mergeVary('Accept-Encoding');

  const existingCodings = headers.getList('Content-Encoding').map((coding) => coding.toLowerCase());

  // A range response or a response that already carries a coding is forwarded
  // untouched. We may only do that when the client accepts the coding that is
  // actually applied to the representation.
  if (response.status === 206 || existingCodings.length > 0) {
    const representation = existingCodings.length > 0 ? existingCodings : ['identity'];
    for (const coding of representation) {
      if (qualityFor(prefs, coding) <= 0) {
        throw notAcceptable(response.status, coding, prefs, headers, options);
      }
    }
    return {
      status: response.status,
      headers,
      coding: representation.join(', '),
      compressed: false,
      existingCodings,
    };
  }

  // A response with no body can only ever be the identity representation.
  if (!hasBody) {
    if (qualityFor(prefs, 'identity') <= 0) {
      throw notAcceptable(response.status, 'identity', prefs, headers, options);
    }
    return {
      status: response.status,
      headers,
      coding: 'identity',
      compressed: false,
      existingCodings,
    };
  }

  const choice = selectCoding(prefs, options.codings);
  if (choice === undefined) {
    throw notAcceptable(response.status, 'identity', prefs, headers, options);
  }
  if (choice.coding === 'identity') {
    return {
      status: response.status,
      headers,
      coding: 'identity',
      compressed: false,
      existingCodings,
    };
  }

  // The bytes change, so metadata that describes the bytes must change too.
  headers.set('Content-Encoding', choice.coding);
  headers.delete('Content-Length');
  headers.transformValues('ETag', weakenEtag);
  return {
    status: response.status,
    headers,
    coding: choice.coding,
    compressed: true,
    existingCodings,
  };
}

function notAcceptable(
  status: number,
  coding: string,
  prefs: ParsedPreferences,
  headers: ResponseHeaders,
  options: ResolvedOptions,
): NotAcceptableError {
  // The 406 is a different response than the one we could not produce: it has
  // no body of its own here, so metadata describing the rejected
  // representation must not leak into it. `Vary` is kept intentionally — it
  // already describes the negotiation.
  for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified', 'Content-Range']) {
    headers.delete(name);
  }
  const offered = describeOffered(prefs, options);
  const message = coding === 'identity'
    ? `no acceptable content coding for this ${status} response; offered: ${offered}`
    : `response uses content coding "${coding}", which the request rejected; offered: ${offered}`;
  return new NotAcceptableError(message, headers);
}

function describeOffered(prefs: ParsedPreferences, options: ResolvedOptions): string {
  const parts: string[] = [];
  for (const coding of options.codings) {
    parts.push(`${coding}=${formatQ(qualityFor(prefs, coding))}`);
  }
  parts.push(`identity=${formatQ(qualityFor(prefs, 'identity'))}`);
  return parts.join(', ');
}

function formatQ(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(3)));
}

function validateStatus(response: ResponseDescription): void {
  if (response === null || typeof response !== 'object') {
    throw new InvalidResponseError('response description must be an object with a status');
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new InvalidResponseError(
      `unsupported status ${String(response.status)}: only 200 and 206 responses can be encoded`,
    );
  }
}

function resolveOptions(options: EncoderOptions): ResolvedOptions {
  const rawCodings = options.codings ?? DEFAULT_CODINGS;
  if (!Array.isArray(rawCodings)) {
    throw new TypeError('options.codings must be an array of coding names');
  }
  const codings: string[] = [];
  for (const raw of rawCodings) {
    const coding = String(raw).trim().toLowerCase();
    if (coding.length === 0 || coding === 'identity') continue;
    if (!SUPPORTED_CODINGS.has(coding)) {
      throw new TypeError(`unsupported content coding in configuration: ${String(raw)}`);
    }
    if (!codings.includes(coding)) codings.push(coding);
  }

  const hwm = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
  if (!Number.isInteger(hwm) || hwm <= 0) {
    throw new TypeError(`options.highWaterMark must be a positive integer, got ${String(options.highWaterMark)}`);
  }

  return {
    codings,
    highWaterMark: hwm,
    gzipOptions: options.gzipOptions ?? {},
    brotliOptions: options.brotliOptions ?? {},
    compressorFactory: options.compressorFactory,
    signal: options.signal,
  };
}

function toNodeReadable(source: BodySource, highWaterMark: number): Readable | null {
  if (source === null || source === undefined) return null;
  if (isNodeReadable(source)) return source;
  if (typeof source === 'string' || source instanceof Uint8Array) {
    return Readable.from([source], { objectMode: false, highWaterMark });
  }
  if (isAsyncIterable(source) || isIterable(source)) {
    return Readable.from(source as AsyncIterable<BodyChunk>, { objectMode: false, highWaterMark });
  }
  throw new InvalidResponseError(
    'body must be a Readable, an (async) iterable of bytes, a string, a Uint8Array, or null',
  );
}

function isNodeReadable(value: unknown): value is Readable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Readable).pipe === 'function' &&
    typeof (value as Readable).read === 'function' &&
    typeof (value as Readable).on === 'function'
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function';
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  throw new InvalidResponseError(
    `body chunks must be Buffers, Uint8Arrays or strings; received ${typeof chunk}`,
  );
}

/**
 * A pull-driven body stream.
 *
 *  - `identity`: chunks are forwarded one at a time as the consumer asks for
 *    them, so the upstream is read at the consumer's pace.
 *  - `gzip`/`br`: a bounded `pipeline(source, compressor)` supplies the
 *    compressor, and the consumer reads the compressor's output. Backpressure
 *    propagates all the way to the source; the compressor is flushed after
 *    every chunk so the first bytes are available without ending the body.
 */
class EncodedBodyStream implements ResponseBody {
  readonly #source: Readable | null;
  readonly #coding: string;
  readonly #options: ResolvedOptions;
  readonly #completion: Promise<void>;
  #resolveCompletion!: () => void;
  #rejectCompletion!: (error: Error) => void;
  #settled = false;
  #cancelled = false;
  #started = false;
  #bytesEmitted = 0;
  #compressor: Duplex | null = null;
  #iterator: AsyncGenerator<Uint8Array> | null = null;
  #abortReason: Error | null = null;
  #signal: AbortSignal | null = null;
  #onAbort: (() => void) | null = null;

  constructor(source: Readable | null, coding: string, options: ResolvedOptions) {
    this.#source = source;
    this.#coding = coding;
    this.#options = options;
    this.#completion = new Promise<void>((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
    // Callers that only inspect the headers must not trigger an unhandled
    // rejection for a body they never consumed.
    this.#completion.catch(() => {});
  }

  get completion(): Promise<void> {
    return this.#completion;
  }

  get coding(): string {
    return this.#coding;
  }

  get started(): boolean {
    return this.#started;
  }

  get bytesEmitted(): number {
    return this.#bytesEmitted;
  }

  /** Records a chunk right before it is yielded to the consumer. */
  #track(bytes: Buffer): Buffer {
    this.#started = true;
    this.#bytesEmitted += bytes.length;
    return bytes;
  }

  [Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    if (this.#iterator === null) {
      this.#iterator = this.#coding === 'identity' ? this.#runIdentity() : this.#runCompressed();
    }
    return this.#iterator;
  }

  /** Wire an {@link AbortSignal} to {@link cancel}; ignores the signal's reason. */
  attachSignal(signal: AbortSignal): void {
    if (this.#signal !== null) return;
    this.#signal = signal;
    const onAbort = (): void => {
      void this.cancel(new BodyAbortedError('response body was aborted by the caller'));
    };
    this.#onAbort = onAbort;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  async cancel(reason?: unknown): Promise<void> {
    if (!this.#cancelled) {
      this.#cancelled = true;
      this.#abortReason = reason instanceof Error ? reason : new BodyAbortedError();
      this.#detachSignal();
    }
    this.#teardown();
    this.#fail(this.#abortReason ?? new BodyAbortedError());
  }

  #succeed(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveCompletion();
  }

  #fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#rejectCompletion(error);
  }

  #detachSignal(): void {
    if (this.#signal !== null && this.#onAbort !== null) {
      this.#signal.removeEventListener('abort', this.#onAbort);
    }
    this.#signal = null;
    this.#onAbort = null;
  }

  #teardown(): void {
    this.#detachSignal();
    const compressor = this.#compressor;
    if (compressor !== null && !compressor.destroyed) compressor.destroy();
    const source = this.#source;
    if (source !== null && !source.destroyed) source.destroy();
  }

  async *#runIdentity(): AsyncGenerator<Uint8Array> {
    if (this.#cancelled) {
      this.#fail(this.#abortReason!);
      throw this.#abortReason;
    }
    this.#started = true;
    try {
      const source = this.#source;
      if (source !== null) {
        for await (const chunk of source) {
          if (this.#cancelled) throw this.#abortReason!;
          const bytes = toBuffer(chunk);
          if (bytes.length > 0) yield this.#track(bytes);
        }
      }
      if (this.#cancelled) throw this.#abortReason!;
      this.#succeed();
    } catch (error) {
      this.#settleFailure(error);
      throw this.#cancelled ? this.#abortReason! : toError(error);
    } finally {
      this.#teardown();
      if (!this.#settled) {
        this.#fail(
          this.#cancelled
            ? this.#abortReason!
            : new BodyAbortedError('response body was not fully consumed'),
        );
      }
    }
  }

  async *#runCompressed(): AsyncGenerator<Uint8Array> {
    if (this.#cancelled) {
      this.#fail(this.#abortReason!);
      throw this.#abortReason;
    }
    this.#started = true;

    const compressor = this.#createCompressor();
    this.#compressor = compressor;
    // Pipeline installs its own error handling; this listener only prevents an
    // uncaught 'error' if one arrives after the pipeline has detached.
    compressor.on('error', () => {});

    const source = this.#source ?? Readable.from([], { objectMode: false });
    const piped = new Promise<void>((resolve, reject) => {
      pipeline(source, compressor, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    piped.catch(() => {});

    try {
      for await (const chunk of compressor) {
        if (this.#cancelled) throw this.#abortReason!;
        const bytes = toBuffer(chunk);
        if (bytes.length > 0) yield this.#track(bytes);
      }
      // The readable side is drained, but the success terminal state must
      // wait for the compressor to have written its trailer.
      await piped;
      if (this.#cancelled) throw this.#abortReason!;
      this.#succeed();
    } catch (error) {
      this.#settleFailure(error);
      throw this.#cancelled ? this.#abortReason! : toError(error);
    } finally {
      this.#teardown();
      if (!this.#settled) {
        this.#fail(
          this.#cancelled
            ? this.#abortReason!
            : new BodyAbortedError('response body was not fully consumed'),
        );
      }
    }
  }

  #settleFailure(error: unknown): void {
    this.#fail(this.#cancelled ? this.#abortReason! : toError(error));
  }

  #createCompressor(): Duplex {
    const options = this.#options;
    if (options.compressorFactory !== undefined) {
      return options.compressorFactory(this.#coding, { coding: this.#coding, highWaterMark: options.highWaterMark });
    }
    const hwm = options.highWaterMark;
    // `readableHighWaterMark`/`writableHighWaterMark` are accepted by zlib at
    // runtime (they are honoured by the underlying Duplex) but are absent from
    // the published `ZlibOptions`/`BrotliOptions` types.
    if (this.#coding === 'gzip') {
      return zlib.createGzip({
        ...options.gzipOptions,
        flush: zlib.constants.Z_SYNC_FLUSH,
        readableHighWaterMark: hwm,
        writableHighWaterMark: hwm,
      } as zlib.ZlibOptions);
    }
    if (this.#coding === 'br') {
      const brotli = options.brotliOptions;
      return zlib.createBrotliCompress({
        ...brotli,
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          ...(brotli.params ?? {}),
        },
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        readableHighWaterMark: hwm,
        writableHighWaterMark: hwm,
      } as zlib.BrotliOptions);
    }
    throw new InvalidResponseError(`no compressor for content coding "${this.#coding}"`);
  }
}
