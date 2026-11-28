/**
 * Wire protocol shared by the multicast source and its receivers.
 *
 * Every packet is a plain, JSON-serialisable object so a caller-provided
 * datagram adapter can encode/decode it (JSON, MessagePack, UDP payload, ...).
 * All sequence numbers are 1-based and monotonic within one
 * (sourceId, generation) pair.
 */

export type Range = {
  readonly start: number;
  readonly end: number;
};

export type SourceId = string;
export type EndpointId = string;

export interface DataPacket {
  readonly kind: 'data';
  readonly sourceId: SourceId;
  readonly generation: number;
  readonly seq: number;
  readonly payload: unknown;
}

export interface RepairPacket {
  readonly kind: 'repair';
  readonly sourceId: SourceId;
  readonly generation: number;
  readonly seq: number;
  readonly payload: unknown;
}

/**
 * Periodic source announcement. `upperBound` is the highest sequence number
 * ever emitted for this generation, `floor` is the oldest sequence number
 * still held in the repair window. A receiver whose next expected sequence is
 * below `floor` can no longer repair the gap and must resynchronise.
 */
export interface AnnouncePacket {
  readonly kind: 'announce';
  readonly sourceId: SourceId;
  readonly generation: number;
  readonly upperBound: number;
  readonly floor: number;
}

/**
 * Negative acknowledgement. NACKs are emitted on the multicast feedback
 * channel (not unicast) on purpose: peers observe them and can defer their own
 * request for an overlapping gap.
 */
export interface NackPacket {
  readonly kind: 'nack';
  readonly sourceId: SourceId;
  readonly generation: number;
  readonly receiverId: EndpointId;
  readonly ranges: readonly Range[];
  /** Source repair floor as observed by the receiver when the NACK was made. */
  readonly floor: number;
  /** Highest sequence the receiver had observed when the NACK was made. */
  readonly upperBound: number;
}

export type Packet = DataPacket | RepairPacket | AnnouncePacket | NackPacket;

export type PacketHandler = (packet: Packet, from: EndpointId) => void;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

/**
 * Delivery adapter. `broadcast` is the multicast channel for data, repairs and
 * announcements; receivers also use it for NACK feedback. `unicast` is
 * available for point-to-point repair delivery. Both may drop, duplicate,
 * delay or reorder packets. `subscribe` returns an unsubscribe function.
 */
export interface DatagramNetwork {
  broadcast(from: EndpointId, packet: Packet): void;
  unicast(from: EndpointId, to: EndpointId, packet: Packet): void;
  subscribe(endpointId: EndpointId, handler: PacketHandler): () => void;
}

/** Injectable random source; must return a number in [0, 1). */
export type RandomSource = () => number;
