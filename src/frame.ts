/**
 * Wire format for the multiplexing channel.
 *
 * A frame is a fixed 12 byte header followed by an optional payload:
 *
 *   0       1       2       3       4       5       6       7
 *   +-------+-------+-------+-------+-------+-------+-------+-------+
 *   | type (u8)     | flags (u8)    |        streamId (u32, BE)      |
 *   +-------+-------+-------+-------+-------+-------+-------+-------+
 *   |                    payloadLength (u32, BE)                     |
 *   +---------------------------------------------------------------+
 *   | payload ... (exactly payloadLength bytes)                      |
 *   +---------------------------------------------------------------+
 *
 * `payloadLength` is validated against `MAX_PAYLOAD_LENGTH` *before* a
 * single payload byte is buffered, so an attacker cannot make the receiver
 * accumulate an unbounded body just by claiming a huge length.
 *
 * Frame types:
 *   DATA         stream payload, no extra semantics
 *   HEADERS      request metadata, JSON encoded
 *   END          sender will send no more DATA on this stream (half close)
 *   CANCEL       sender aborts this stream; payload is a UTF-8 reason
 *   WINDOW       credit return; payload is the number of bytes (u32 BE)
 *   PING         liveness probe, payload echoed verbatim
 *   PONG         reply to PING
 *   GOAWAY       connection level failure; payload is a UTF-8 reason
 *
 * Stream ids are odd for calls initiated by the channel that allocated
 * them and even for peer initiated calls. Stream 0 is reserved for
 * connection level control frames (WINDOW, PING, PONG, GOAWAY).
 */

export const FRAME_HEADER_LENGTH = 12;
export const MAX_PAYLOAD_LENGTH = 64 * 1024;

export const FrameType = {
  DATA: 0x01,
  HEADERS: 0x02,
  END: 0x03,
  CANCEL: 0x04,
  WINDOW: 0x05,
  PING: 0x06,
  PONG: 0x07,
  GOAWAY: 0x08,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPE_NAMES = new Map<number, string>(
  Object.entries(FrameType).map(([name, value]) => [value, name]),
);

export function frameTypeName(type: number): string {
  return FRAME_TYPE_NAMES.get(type) ?? `UNKNOWN(0x${type.toString(16)})`;
}

export const PROTOCOL_VERSION = 1;

/**
 * The frame header. `payloadLength` is the declared length; a decoder only
 * hands out a `Frame` once that many payload bytes have actually arrived.
 */
export interface FrameHeader {
  readonly type: FrameTypeValue;
  readonly flags: number;
  readonly streamId: number;
  readonly payloadLength: number;
}

export interface Frame extends FrameHeader {
  readonly payload: Uint8Array;
}

/** Returned by incremental decoders while more bytes are still needed. */
export interface NeedMoreData {
  readonly needed: number;
}

export function isNeedMoreData(value: Frame | NeedMoreData): value is NeedMoreData {
  return typeof (value as NeedMoreData).needed === 'number';
}

export class FrameEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameEncodeError';
  }
}

export interface EncodeFrameOptions {
  type: FrameTypeValue;
  streamId: number;
  payload?: Uint8Array;
  flags?: number;
}

const U32_MAX = 0xffff_ffff;

function checkU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new FrameEncodeError(`${name} must be an unsigned 32 bit integer, got ${value}`);
  }
}

/**
 * Encode one frame into a freshly allocated, exactly sized buffer so callers
 * can hand it straight to a transport without slicing.
 */
export function encodeFrame(options: EncodeFrameOptions): Uint8Array {
  const { type, streamId, payload = EMPTY, flags = 0 } = options;
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new FrameEncodeError(`frame type must be a byte, got ${type}`);
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new FrameEncodeError(`flags must be a byte, got ${flags}`);
  }
  checkU32('streamId', streamId);
  if (payload.byteLength > MAX_PAYLOAD_LENGTH) {
    throw new FrameEncodeError(
      `payload of ${payload.byteLength} bytes exceeds the ${MAX_PAYLOAD_LENGTH} byte frame limit`,
    );
  }
  const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint8(1, flags);
  view.setUint32(2, streamId, false);
  view.setUint32(6, payload.byteLength, false);
  frame.set(payload, FRAME_HEADER_LENGTH);
  return frame;
}

/** Encode only the header; handy for tests that synthesise bad lengths. */
export function encodeFrameHeader(header: FrameHeader): Uint8Array {
  checkU32('streamId', header.streamId);
  checkU32('payloadLength', header.payloadLength);
  const out = new Uint8Array(FRAME_HEADER_LENGTH);
  const view = new DataView(out.buffer);
  view.setUint8(0, header.type);
  view.setUint8(1, header.flags);
  view.setUint32(2, header.streamId, false);
  view.setUint32(6, header.payloadLength, false);
  return out;
}

const EMPTY = new Uint8Array(0);

/** Decode a header from exactly `FRAME_HEADER_LENGTH` bytes. */
export function decodeFrameHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.byteLength !== FRAME_HEADER_LENGTH) {
    throw new FrameEncodeError(
      `frame header needs ${FRAME_HEADER_LENGTH} bytes, got ${bytes.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: view.getUint8(0) as FrameTypeValue,
    flags: view.getUint8(1),
    streamId: view.getUint32(2, false),
    payloadLength: view.getUint32(6, false),
  };
}

/** A `Frame` plus the exact number of bytes it occupied on the wire. */
export interface DecodedFrame {
  readonly frame: Frame;
  readonly size: number;
}

/**
 * Incremental frame decoder.
 *
 * Bytes can be pushed in arbitrarily small or large chunks. The decoder
 * never scans past the end of a complete frame, so several frames glued
 * together are returned one at a time. The declared payload length is
 * validated as soon as the header is available; on violation it throws a
 * `ProtocolError` and the connection must be torn down.
 */
export class FrameDecoder {
  #buffer: Uint8Array = EMPTY;
  #start = 0;
  #end = 0;

  /** Bytes currently retained but not yet decoded. */
  get bufferedBytes(): number {
    return this.#end - this.#start;
  }

  /**
   * Append `chunk` and decode as many frames as are complete.
   * Throws `ProtocolError` for an invalid declaration or unknown frame type.
   */
  push(chunk: Uint8Array): Frame[] {
    if (chunk.byteLength > 0) this.#append(chunk);
    const frames: Frame[] = [];
    for (;;) {
      const next = this.#tryDecodeOne();
      if (next === null) break;
      frames.push(next);
    }
    return frames;
  }

  /** Decode at most one complete frame, or return null if more bytes are needed. */
  next(): Frame | null {
    return this.#tryDecodeOne();
  }

  #tryDecodeOne(): Frame | null {
    const available = this.#end - this.#start;
    if (available < FRAME_HEADER_LENGTH) return null;
    const header = decodeFrameHeader(
      this.#buffer.subarray(this.#start, this.#start + FRAME_HEADER_LENGTH),
    );
    validateFrameHeader(header);
    const total = FRAME_HEADER_LENGTH + header.payloadLength;
    if (available < total) return null;
    const payloadStart = this.#start + FRAME_HEADER_LENGTH;
    const payload = this.#buffer.slice(payloadStart, payloadStart + header.payloadLength);
    this.#start += total;
    if (this.#start === this.#end) {
      this.#start = 0;
      this.#end = 0;
    }
    return {
      type: header.type,
      flags: header.flags,
      streamId: header.streamId,
      payloadLength: header.payloadLength,
      payload,
    };
  }

  #append(chunk: Uint8Array): void {
    const live = this.#end - this.#start;
    const required = live + chunk.byteLength;
    if (this.#start > 0 && (this.#end + chunk.byteLength > this.#buffer.byteLength)) {
      // Compact before growing so the retained window stays small.
      this.#buffer.copyWithin(0, this.#start, this.#end);
      this.#start = 0;
      this.#end = live;
    }
    if (this.#end + chunk.byteLength > this.#buffer.byteLength) {
      let capacity = Math.max(this.#buffer.byteLength * 2, FRAME_HEADER_LENGTH);
      while (capacity < required) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#buffer.subarray(this.#start, this.#end));
      this.#buffer = grown;
      this.#start = 0;
      this.#end = live;
    }
    this.#buffer.set(chunk, this.#end);
    this.#end += chunk.byteLength;
  }

  /** Drop any partially decoded data, e.g. after a fatal protocol error. */
  reset(): void {
    this.#buffer = EMPTY;
    this.#start = 0;
    this.#end = 0;
  }
}

/**
 * Validate the semantic constraints of a header. Length is checked here so
 * an oversized declaration is rejected before its body is buffered.
 */
export function validateFrameHeader(header: FrameHeader): void {
  if (FRAME_TYPE_NAMES.get(header.type) === undefined) {
    throw new ProtocolError(`unknown frame type 0x${header.type.toString(16)}`);
  }
  if (header.payloadLength > MAX_PAYLOAD_LENGTH) {
    throw new ProtocolError(
      `declared payload length ${header.payloadLength} exceeds limit ${MAX_PAYLOAD_LENGTH}`,
    );
  }
  if (header.streamId > U32_MAX) {
    throw new ProtocolError(`stream id ${header.streamId} out of range`);
  }
  switch (header.type) {
    case FrameType.WINDOW:
      if (header.payloadLength !== 4) {
        throw new ProtocolError(
          `WINDOW frame requires a 4 byte payload, declared ${header.payloadLength}`,
        );
      }
      if (header.streamId !== 0) {
        throw new ProtocolError('WINDOW frame must use stream id 0');
      }
      break;
    case FrameType.PING:
    case FrameType.PONG:
      if (header.streamId !== 0) {
        throw new ProtocolError(`${frameTypeName(header.type)} frame must use stream id 0`);
      }
      break;
    case FrameType.GOAWAY:
      if (header.streamId !== 0) {
        throw new ProtocolError('GOAWAY frame must use stream id 0');
      }
      break;
    case FrameType.HEADERS:
    case FrameType.DATA:
    case FrameType.END:
    case FrameType.CANCEL:
      if (header.streamId === 0) {
        throw new ProtocolError(`${frameTypeName(header.type)} frame must not use stream id 0`);
      }
      if (header.type === FrameType.END && header.payloadLength !== 0) {
        throw new ProtocolError('END frame must not carry a payload');
      }
      break;
    default:
      break;
  }
}

/** Convenience wrapper around a fresh `FrameDecoder` for one complete buffer. */
export function decodeFrames(chunk: Uint8Array): Frame[] {
  return new FrameDecoder().push(chunk);
}

export function encodeDataFrame(streamId: number, payload: Uint8Array): Uint8Array {
  return encodeFrame({ type: FrameType.DATA, streamId, payload });
}

export function encodeHeadersFrame(streamId: number, metadata: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(metadata ?? null));
  return encodeFrame({ type: FrameType.HEADERS, streamId, payload: body });
}

export function encodeEndFrame(streamId: number): Uint8Array {
  return encodeFrame({ type: FrameType.END, streamId });
}

export function encodeCancelFrame(streamId: number, reason: string): Uint8Array {
  return encodeFrame({
    type: FrameType.CANCEL,
    streamId,
    payload: new TextEncoder().encode(reason),
  });
}

export function encodeWindowFrame(credit: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, credit, false);
  return encodeFrame({ type: FrameType.WINDOW, streamId: 0, payload });
}

export function encodePingFrame(payload: Uint8Array = EMPTY): Uint8Array {
  return encodeFrame({ type: FrameType.PING, streamId: 0, payload });
}

export function encodePongFrame(payload: Uint8Array = EMPTY): Uint8Array {
  return encodeFrame({ type: FrameType.PONG, streamId: 0, payload });
}

export function encodeGoawayFrame(reason: string): Uint8Array {
  return encodeFrame({
    type: FrameType.GOAWAY,
    streamId: 0,
    payload: new TextEncoder().encode(reason),
  });
}

export function readWindowCredit(frame: Frame): number {
  if (frame.payload.byteLength !== 4) {
    throw new ProtocolError('WINDOW frame requires a 4 byte payload');
  }
  return new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength,
  ).getUint32(0, false);
}
