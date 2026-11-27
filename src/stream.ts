/**
 * Node stream adapter around {@link GrpcWebResponseDecoder}.
 *
 * The writable side accepts raw gRPC-Web response-body bytes; the readable
 * side (object mode) emits one object per decoded item:
 *
 *     { type: 'message', data: Buffer }
 *     ...
 *     { type: 'trailer', status: 0, statusText: 'OK', ... }   // always last
 *
 * Outcome model — a complete response whose *call* failed is not a decoding
 * failure, and the two are reported through different channels:
 *
 *  - **Wire-format failure** (bad flag, compressed frame, malformed trailer,
 *    duplicate or missing grpc-status, truncated input, missing trailer, frame
 *    after trailer, limit exceeded): the stream emits `error` with a
 *    `ProtocolError` / `UnsupportedCompressionError` / `LimitError`, **no
 *    trailer item is emitted**, and `completion` rejects with the same error.
 *  - **Non-zero gRPC status** (fully received, well-formed trailer): messages
 *    and the trailer item are emitted, the readable side ends normally with no
 *    `error` event, and `completion` rejects with `GrpcStatusError`.  The
 *    trailer item's non-zero `status` is what a pure item consumer sees.
 *  - **Cancellation** (`cancel()` or an aborted AbortSignal): message output
 *    stops at once, no trailer is emitted, the stream is destroyed without an
 *    `error` event, and `completion` rejects with `CancelledError`.
 *
 * `completion` is the authoritative terminal promise.  It settles only after
 * the entire body has been validated: writable end reached, every byte
 * consumed, trailer present and well-formed, no bytes left over.
 *
 * Ordering note: `completion` settles when the *outcome* is known.  The
 * readable side delivers the trailer item and the `end` event on the usual
 * stream schedule, which may be a subsequent tick.  Code that inspects items
 * collected from `data` events should await `end` (or use `for await`) before
 * reading them; `completion` alone answers "did the call succeed?".
 *
 * Backpressure
 * ------------
 * Incoming chunks are fed to the decoder in slices, and decoded messages are
 * pushed to the readable side one at a time.  When `push()` returns false
 * (downstream paused, or the readable high-water mark reached), decoding stops
 * immediately, the write callback is withheld, and the rest of the current
 * chunk stays pending.  Node therefore stops calling `_write`; the writable
 * buffer fills and upstream `write()` returns false / `drain` waits.  No
 * internal queue of decoded messages exists, so a paused consumer halts
 * message production at the source.
 */

import { Duplex } from 'node:stream';
import { CancelledError, GrpcStatusError } from './errors.ts';
import { GrpcWebResponseDecoder } from './decoder.ts';
import type { GrpcWebMode, MessageItem, TrailerItem } from './decoder.ts';

/** How much input is handed to the decoder between backpressure checks. */
const INPUT_SLICE_BYTES = 16 * 1024;

export interface DecoderStreamOptions {
  /** Body encoding. Default `binary`. */
  readonly mode?: GrpcWebMode;
  /** Maximum payload of one data frame. Default 4 MiB. */
  readonly maxMessageSize?: number;
  /** Maximum bytes buffered that have not yet formed a complete frame. Default 8 MiB. */
  readonly maxUnparsedBytes?: number;
  /** Maximum trailer frame payload. Default 64 KiB. */
  readonly maxTrailerSize?: number;
  /** Readable object-mode high-water mark, in items. Default 16. */
  readonly readableHighWaterMark?: number;
  /** Writable high-water mark, in bytes. Default 64 KiB. */
  readonly writableHighWaterMark?: number;
  /** Aborting this signal cancels decoding. */
  readonly signal?: AbortSignal;
}

/** Resolved terminal result of a successful (grpc-status 0) call. */
export interface DecoderStreamResult {
  readonly status: 0;
  readonly trailer: TrailerItem;
  readonly messages: number;
}

function assertPositiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export class GrpcWebDecoderStream extends Duplex {
  readonly #decoder: GrpcWebResponseDecoder;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort: () => void;

  /** The chunk currently being fed, and how much of it was already fed. */
  #chunk: Uint8Array | null = null;
  #chunkOffset = 0;

  #writeCallback: ((error?: Error | null) => void) | null = null;
  #finalCallback: ((error?: Error | null) => void) | null = null;
  #waitingForRead = false;
  #pumping = false;
  #cancelled = false;
  #settled = false;

  #resolve!: (result: DecoderStreamResult) => void;
  #reject!: (error: unknown) => void;

  /** Authoritative terminal promise for the whole response. */
  readonly completion: Promise<DecoderStreamResult>;

  constructor(options: DecoderStreamOptions = {}) {
    super({
      readableObjectMode: true,
      writableObjectMode: false,
      readableHighWaterMark: assertPositiveInteger(
        'readableHighWaterMark',
        options.readableHighWaterMark,
        16,
      ),
      writableHighWaterMark: assertPositiveInteger(
        'writableHighWaterMark',
        options.writableHighWaterMark,
        64 * 1024,
      ),
      autoDestroy: true,
    });

    this.#decoder = new GrpcWebResponseDecoder({
      mode: options.mode,
      maxMessageSize: options.maxMessageSize,
      maxUnparsedBytes: options.maxUnparsedBytes,
      maxTrailerSize: options.maxTrailerSize,
    });

    this.completion = new Promise<DecoderStreamResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // `completion` is often awaited after it settles; an unobserved rejection
    // must never crash the process.
    this.completion.catch(() => {});

    this.#signal = options.signal;
    this.#onAbort = () => this.cancel(this.#signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) {
        queueMicrotask(this.#onAbort);
      } else {
        options.signal.addEventListener('abort', this.#onAbort, { once: true });
      }
    }
  }

  get mode(): GrpcWebMode {
    return this.#decoder.mode;
  }

  /** Body bytes written so far. */
  get bytesReceived(): number {
    return this.#decoder.bytesReceived;
  }

  /** Data messages emitted so far. */
  get messagesEmitted(): number {
    return this.#decoder.messagesEmitted;
  }

  /** True once a validated trailer frame was parsed from the input. */
  get trailerSeen(): boolean {
    return this.#decoder.trailerSeen;
  }

  /** True while decoding is stopped waiting for the consumer to read. */
  get isWaitingForRead(): boolean {
    return this.#waitingForRead;
  }

  /**
   * Cancel decoding: stop emitting messages immediately, never emit a trailer,
   * and reject `completion` with `CancelledError`.  The stream is failed with
   * the same error so `pipeline()` users see the cancellation rather than a
   * silent end.  Any in-flight `write()` / `end()` callback is released, so
   * upstream never hangs.  Idempotent; safe at any time, including before any
   * input arrives.
   */
  cancel(reason?: unknown): void {
    if (this.#cancelled || this.#settled) return;
    this.#cancelled = true;
    const error = reason instanceof CancelledError ? reason : new CancelledError(reason);
    this.#settleFailure(error);

    this.#chunk = null;
    this.#chunkOffset = 0;
    this.#waitingForRead = false;

    // Release an in-flight write callback so upstream is not left waiting for
    // a write that will never finish.  The cancellation is surfaced through
    // the stream's error and `completion`, not through this callback.
    const writeCallback = this.#writeCallback;
    this.#writeCallback = null;
    this.#finalCallback = null;
    writeCallback?.(null);

    if (!this.destroyed) this.destroy(error);
  }

  override _write(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#cancelled) {
      callback(null);
      return;
    }
    this.#chunk = chunk;
    this.#chunkOffset = 0;
    this.#writeCallback = callback;
    this.#pump();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.#cancelled) {
      callback(null);
      return;
    }
    this.#finalCallback = callback;
    this.#pump();
  }

  override _read(): void {
    if (this.#waitingForRead) {
      this.#waitingForRead = false;
      this.#pump();
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#chunk = null;
    this.#chunkOffset = 0;
    this.#writeCallback = null;
    this.#finalCallback = null;
    this.#waitingForRead = false;
    this.#signal?.removeEventListener('abort', this.#onAbort);
    if (error) {
      this.#settleFailure(error);
    } else if (!this.#settled) {
      // Destroyed before the exchange completed (an upstream socket close, or
      // an explicit destroy()): the response is incomplete, so `completion`
      // must not be left pending and must not resolve as success.
      this.#settleFailure(new CancelledError());
    }
    callback(error);
  }

  /**
   * Feed pending input and push decoded messages until the readable side is
   * full; then complete the pending write callback, or — when `end()` has
   * arrived and all input is consumed — validate the exchange and finish.
   */
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        if (this.#cancelled || this.destroyed || this.#settled) return;

        // 1. Feed a bounded slice of the pending chunk, if any.
        if (this.#chunk !== null) {
          const end = Math.min(this.#chunkOffset + INPUT_SLICE_BYTES, this.#chunk.length);
          const slice = this.#chunk.subarray(this.#chunkOffset, end);
          this.#chunkOffset = end;
          const exhausted = this.#chunkOffset >= this.#chunk.length;
          try {
            if (slice.length > 0) this.#decoder.write(slice);
          } catch (error) {
            this.#fail(error);
            return;
          }
          if (exhausted) {
            this.#chunk = null;
            this.#chunkOffset = 0;
          }
        }

        // 2. Push every message the decoder has ready.
        for (;;) {
          let item: MessageItem | null;
          try {
            item = this.#decoder.next();
          } catch (error) {
            this.#fail(error);
            return;
          }
          if (item === null) break;
          if (!this.push(item)) {
            // Downstream is full: withhold the write callback and wait.
            this.#waitingForRead = true;
            return;
          }
        }

        // 3. No pending input: release the write callback, then finish if the
        //    writable side has ended.
        if (this.#chunk === null) {
          const writeCallback = this.#writeCallback;
          if (writeCallback !== null) {
            this.#writeCallback = null;
            writeCallback(null);
            // Node may synchronously start the next _write; loop re-checks.
            continue;
          }
          if (this.#finalCallback !== null) {
            this.#finishExchange();
            return;
          }
          return;
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /**
   * End of input with every message pushed: validate the complete exchange,
   * publish the trailer, end the readable side and settle `completion`.
   */
  #finishExchange(): void {
    const finalCallback = this.#finalCallback;
    this.#finalCallback = null;

    let trailer: TrailerItem;
    try {
      trailer = this.#decoder.finish();
    } catch (error) {
      finalCallback?.(null);
      this.#fail(error);
      return;
    }

    // Validation is complete, so the terminal state is now known.
    this.#settled = true;
    this.push(trailer);
    this.push(null);
    finalCallback?.(null);

    if (trailer.status !== 0) {
      this.#reject(
        new GrpcStatusError(
          trailer.status,
          trailer.statusText,
          trailer.message,
          trailer.rawMessage,
          trailer.trailer,
        ),
      );
      return;
    }
    this.#resolve({ status: 0, trailer, messages: this.#decoder.messagesEmitted });
  }

  #fail(error: unknown): void {
    if (this.#settled) return;
    const err = error instanceof Error ? error : new Error(String(error));
    this.#settleFailure(err);
    this.#chunk = null;
    this.#chunkOffset = 0;
    this.#waitingForRead = false;
    this.#writeCallback = null;
    this.#finalCallback = null;
    if (!this.destroyed) this.destroy(err);
  }

  #settleFailure(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(error);
  }
}

/** Create a decoder stream; shorthand for `new GrpcWebDecoderStream(options)`. */
export function createDecoderStream(options: DecoderStreamOptions = {}): GrpcWebDecoderStream {
  return new GrpcWebDecoderStream(options);
}

export type { MessageItem, TrailerItem };
