/**
 * Error types shared by the frame codec, streams and channels.
 *
 * Every error carries a stable machine readable `code` so callers can
 * distinguish protocol faults from local cancellation and transport loss
 * without parsing messages.
 */

export type MuxErrorCode =
  | 'PROTOCOL_ERROR'
  | 'CONNECTION_CLOSED'
  | 'STREAM_CANCELLED'
  | 'STREAM_CLOSED'
  | 'TOO_MANY_STREAMS'
  | 'SEND_BUFFER_FULL'
  | 'INVALID_ARGUMENT';

export class MuxError extends Error {
  readonly code: MuxErrorCode;

  constructor(code: MuxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The peer violated the wire protocol. The whole connection is unusable. */
export class ProtocolError extends MuxError {
  constructor(message: string, options?: ErrorOptions) {
    super('PROTOCOL_ERROR', message, options);
  }
}

/** The underlying byte transport failed, ended unexpectedly or was closed. */
export class ConnectionClosedError extends MuxError {
  constructor(message = 'connection closed', options?: ErrorOptions) {
    super('CONNECTION_CLOSED', message, options);
  }
}

/** A call was cancelled locally or by the peer. */
export class StreamCancelledError extends MuxError {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super('STREAM_CANCELLED', `stream cancelled: ${reason}`, options);
    this.reason = reason;
  }
}

/** An operation was attempted on a stream that already terminated. */
export class StreamClosedError extends MuxError {
  constructor(message = 'stream is closed', options?: ErrorOptions) {
    super('STREAM_CLOSED', message, options);
  }
}

export class TooManyStreamsError extends MuxError {
  constructor(limit: number) {
    super('TOO_MANY_STREAMS', `concurrent stream limit (${limit}) reached`);
  }
}

export class SendBufferFullError extends MuxError {
  constructor(limit: number) {
    super('SEND_BUFFER_FULL', `pending send buffer limit (${limit} bytes) exceeded`);
  }
}

export class InvalidArgumentError extends MuxError {
  constructor(message: string) {
    super('INVALID_ARGUMENT', message);
  }
}
