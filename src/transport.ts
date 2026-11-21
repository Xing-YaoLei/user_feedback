/**
 * The byte transport a `MuxConnection` runs on.
 *
 * The connection owns framing, flow control and multiplexing; the transport
 * only moves opaque bytes. Both halves are independent: a transport may
 * continue to accept writes after its readable side has ended, which is what
 * makes per-direction half-close possible.
 *
 * `write` may accept fewer bytes than it was given. Returning `undefined`
 * means "all bytes accepted". A positive number means only that prefix was
 * accepted and the caller must retry with the remainder. This models a
 * transport that applies backpressure and lets cancellation land while a
 * frame is only partially on the wire.
 */
export interface DuplexTransport {
  /** Bytes arriving from the peer. Ending the iteration means peer EOF. */
  readonly readable: AsyncIterable<Uint8Array>;

  /** Accept bytes for the peer, possibly only a prefix. */
  write(chunk: Uint8Array): number | void | Promise<number | void>;

  /** Half-close the write side without discarding buffered bytes. */
  end?(): void | Promise<void>;

  /** Hard close the transport, discarding buffers. */
  destroy?(error?: Error): void;
}
