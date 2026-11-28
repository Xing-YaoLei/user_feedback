import type {
  Clock,
  DatagramNetwork,
  EndpointId,
  Packet,
  PacketHandler,
  RandomSource,
} from './types.ts';

export interface LinkPolicy {
  /** Probability in [0, 1] that a packet is dropped. */
  drop?: number;
  /** Probability in [0, 1] that a packet is delivered twice. */
  duplicate?: number;
  /** Fixed one-way delay in virtual milliseconds. */
  delayMs?: number;
  /** Extra random delay in [0, jitterMs). */
  jitterMs?: number;
}

export interface InMemoryNetworkOptions {
  clock: Clock;
  random?: RandomSource;
  /** Policy used when no direction-specific policy matches. */
  defaultPolicy?: LinkPolicy;
}

export interface Envelope {
  readonly from: EndpointId;
  readonly to: EndpointId | null;
  readonly packet: Packet;
  /** Virtual time at which the packet was delivered (send time for `log`). */
  readonly at: number;
}

type DirectionFilter = (from: EndpointId, to: EndpointId | null, packet: Packet) => LinkPolicy | null;

const deliverable = (policy: LinkPolicy, random: RandomSource): boolean =>
  (policy.drop ?? 0) <= 0 || random() >= (policy.drop ?? 0);

/**
 * Deterministic in-memory transport implementing `DatagramNetwork`.
 *
 * Every send is subject to an injectable `LinkPolicy`, so tests can drop the
 * first NACK, lose a fraction of repairs, duplicate packets, and reorder them
 * via per-link delay. Packets are delivered through the manual clock, which
 * keeps simulations fully reproducible.
 */
export class InMemoryNetwork implements DatagramNetwork {
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly defaultPolicy: LinkPolicy;
  private readonly handlers = new Map<EndpointId, Set<PacketHandler>>();
  private readonly extraFilters: DirectionFilter[] = [];
  /** Every packet the transport was asked to carry, in send order. */
  readonly log: Envelope[] = [];
  /** Every packet actually delivered, in delivery order. */
  readonly delivered: Envelope[] = [];
  private closed = false;

  constructor(options: InMemoryNetworkOptions) {
    this.clock = options.clock;
    this.random = options.random ?? Math.random;
    this.defaultPolicy = options.defaultPolicy ?? {};
  }

  /** Add a policy filter; return `null` to fall through to the next filter. */
  addFilter(filter: DirectionFilter): void {
    this.extraFilters.push(filter);
  }

  /** Convenience: apply `policy` only to packets matching `predicate`. */
  when(
    predicate: (from: EndpointId, to: EndpointId | null, packet: Packet) => boolean,
    policy: LinkPolicy,
  ): void {
    this.addFilter((from, to, packet) => (predicate(from, to, packet) ? policy : null));
  }

  /** Convenience: apply per-receiver link loss on the broadcast channel. */
  setReceiverLoss(receiverId: EndpointId, policy: LinkPolicy): void {
    this.addFilter((_from, to, _packet) => (to === receiverId ? policy : null));
  }

  subscribe(endpointId: EndpointId, handler: PacketHandler): () => void {
    let set = this.handlers.get(endpointId);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(endpointId, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  broadcast(from: EndpointId, packet: Packet): void {
    this.dispatch(from, null, packet);
  }

  unicast(from: EndpointId, to: EndpointId, packet: Packet): void {
    this.dispatch(from, to, packet);
  }

  close(): void {
    this.closed = true;
    this.handlers.clear();
  }

  private dispatch(from: EndpointId, to: EndpointId | null, packet: Packet): void {
    if (this.closed) return;
    this.log.push({ from, to, packet, at: this.clock.now() });
    // Broadcasts are evaluated once per recipient so each link has its own
    // independent drop/duplicate/delay behaviour.
    const recipients = to !== null ? [to] : this.recipientsOf(from);
    for (const recipient of recipients) {
      this.transmit(from, recipient, packet);
    }
  }

  private recipientsOf(_from: EndpointId): EndpointId[] {
    // Every subscriber hears the broadcast, including the sender itself so a
    // source can receive feedback sent on the same channel.
    return [...this.handlers.keys()];
  }

  private transmit(from: EndpointId, to: EndpointId, packet: Packet): void {
    const policy = this.policyFor(from, to, packet);
    if (!deliverable(policy, this.random)) return;

    const baseDelay = Math.max(0, policy.delayMs ?? 0);
    const jitter = policy.jitterMs !== undefined && policy.jitterMs > 0
      ? Math.floor(this.random() * policy.jitterMs)
      : 0;
    const copies = (policy.duplicate ?? 0) > 0 && this.random() < (policy.duplicate ?? 0) ? 2 : 1;

    for (let copy = 0; copy < copies; copy++) {
      // The extra copy lands slightly later, which also exercises reordering.
      const delay = baseDelay + jitter + copy;
      this.clock.setTimeout(() => {
        if (this.closed) return;
        const handlers = this.handlers.get(to);
        if (handlers === undefined) return;
        const envelope: Envelope = { from, to, packet, at: this.clock.now() };
        this.delivered.push(envelope);
        for (const handler of [...handlers]) handler(packet, from);
      }, delay);
    }
  }

  private policyFor(from: EndpointId, to: EndpointId, packet: Packet): LinkPolicy {
    for (const filter of this.extraFilters) {
      const policy = filter(from, to, packet);
      if (policy !== null) return policy;
    }
    return this.defaultPolicy;
  }
}
