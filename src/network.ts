/**
 * Deterministic message-delivery simulation.
 *
 * The simulator owns one "true" clock.  Every participant is wired to an
 * `OffsetClock` over that source, so each node and the coordinator have their
 * own reading that differs from true time by a fixed, caller-declared offset.
 *
 * Delivery is modelled explicitly and repeatably:
 *
 *   - every message gets a latency drawn from a caller-supplied policy;
 *   - messages may be duplicated (each copy gets its own latency, so copies
 *     can arrive out of order);
 *   - messages may be dropped;
 *   - a node can be partitioned, in which case everything it sends or is sent
 *     is lost until it heals.
 *
 * `advanceTo(t)` dispatches every pending delivery whose due time is `<= t`
 * in due-time order, with insertion order as a deterministic tie-break.  No
 * wall clock, randomness, or timers are involved, so a run is fully
 * reproducible.
 */

import { ManualClock, OffsetClock } from './clock.ts';
import type { Coordinator, HandleOptions } from './coordinator.ts';
import type {
  CoordinatorToNodeMessage,
  NodeToCoordinatorMessage,
  WireMessage,
} from './protocol.ts';

export interface DeliveryPolicy {
  /** Latency in true milliseconds for one copy. */
  latencyMs(message: WireMessage): number;
  /** How many copies to send (>=1).  Default 1. */
  copies?(message: WireMessage): number;
  /** Drop the message entirely.  Default false. */
  drop?(message: WireMessage): boolean;
}

/** Deterministic PRNG (mulberry32) for reproducible jitter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface UniformNetworkOptions {
  /** Inclusive lower bound of latency jitter (true ms). */
  minLatencyMs: number;
  /** Inclusive upper bound of latency jitter (true ms). */
  maxLatencyMs: number;
  /** Probability in [0,1] that a message is dropped. */
  dropRate?: number;
  /** Probability in [0,1] that a message is sent twice. */
  duplicateRate?: number;
  seed?: number;
}

/** A simple reproducible policy: uniform latency, optional drop/duplicate. */
export function uniformPolicy(opts: UniformNetworkOptions): DeliveryPolicy {
  const random = mulberry32(opts.seed ?? 0x5eed);
  const span = Math.max(0, opts.maxLatencyMs - opts.minLatencyMs);
  return {
    latencyMs: () => opts.minLatencyMs + Math.floor(random() * (span + 1)),
    copies: () => (random() < (opts.duplicateRate ?? 0) ? 2 : 1),
    drop: () => random() < (opts.dropRate ?? 0),
  };
}

export interface NodeEndpoint {
  nodeId: string;
  receive(message: CoordinatorToNodeMessage): void;
  /**
   * Called when a partition heals.  Transports use this to re-send anything
   * still awaiting a reply, which is how "after recovery, continue processing
   * satisfiable borrows" happens without the caller having to poll.
   */
  onReconnect?(): void;
}

export interface NetworkLogEntry {
  at: number;
  direction: 'node->coordinator' | 'coordinator->node';
  message: WireMessage;
  outcome: 'delivered' | 'dropped' | 'partitioned';
  /** Copy index when a message was duplicated. */
  copy?: number;
}

interface PendingDelivery {
  dueAt: number;
  order: number;
  target: { kind: 'coordinator' } | { kind: 'node'; nodeId: string };
  message: WireMessage;
  copy: number;
  copies: number;
}

let deliveryOrder = 0;

export class SimulatedNetwork {
  readonly trueClock: ManualClock;
  readonly log: NetworkLogEntry[] = [];

  private readonly coordinator: Coordinator;
  private readonly optionsAt: (msg: WireMessage) => HandleOptions;
  private readonly policy: DeliveryPolicy;
  private readonly endpoints = new Map<string, NodeEndpoint>();
  private readonly offline = new Set<string>();
  private readonly pending: PendingDelivery[] = [];

  constructor(config: {
    coordinator: Coordinator;
    policy: DeliveryPolicy;
    /** Shared "true" clock.  Participants derive their own readings from it. */
    trueClock?: ManualClock;
    /** How to derive the coordinator decision reading for a message. */
    handleOptions?: (msg: NodeToCoordinatorMessage) => HandleOptions;
  }) {
    this.trueClock = config.trueClock ?? new ManualClock(0);
    this.coordinator = config.coordinator;
    this.policy = config.policy;
    this.optionsAt = config.handleOptions ?? (() => ({}));
  }

  get now(): number {
    return this.trueClock.now();
  }

  /** A clock for `participant` following true time with its declared offset. */
  clockFor(_participant: string, offsetMs = 0): OffsetClock {
    return new OffsetClock(this.trueClock, offsetMs);
  }

  registerNode(endpoint: NodeEndpoint): void {
    this.endpoints.set(endpoint.nodeId, endpoint);
  }

  /** Partition a node: all traffic to and from it is dropped. */
  partition(nodeId: string): void {
    this.offline.add(nodeId);
  }

  heal(nodeId: string): void {
    this.offline.delete(nodeId);
    // Recovery hook: the endpoint re-sends requests still awaiting a reply.
    this.endpoints.get(nodeId)?.onReconnect?.();
  }

  isOffline(nodeId: string): boolean {
    return this.offline.has(nodeId);
  }

  /** Enqueue a node->coordinator message under the current delivery policy. */
  sendFromNode(nodeId: string, message: NodeToCoordinatorMessage): void {
    if (this.offline.has(nodeId)) {
      this.log.push({ at: this.now, direction: 'node->coordinator', message, outcome: 'partitioned' });
      return;
    }
    if (this.policy.drop?.(message)) {
      this.log.push({ at: this.now, direction: 'node->coordinator', message, outcome: 'dropped' });
      return;
    }
    const copies = Math.max(1, Math.floor(this.policy.copies?.(message) ?? 1));
    for (let copy = 0; copy < copies; copy += 1) {
      this.pending.push({
        dueAt: this.now + Math.max(0, this.policy.latencyMs(message)),
        order: deliveryOrder++,
        target: { kind: 'coordinator' },
        message,
        copy,
        copies,
      });
    }
  }

  private enqueueReply(nodeId: string, message: CoordinatorToNodeMessage): void {
    if (this.offline.has(nodeId)) {
      this.log.push({ at: this.now, direction: 'coordinator->node', message, outcome: 'partitioned' });
      return;
    }
    if (this.policy.drop?.(message)) {
      this.log.push({ at: this.now, direction: 'coordinator->node', message, outcome: 'dropped' });
      return;
    }
    const copies = Math.max(1, Math.floor(this.policy.copies?.(message) ?? 1));
    for (let copy = 0; copy < copies; copy += 1) {
      this.pending.push({
        dueAt: this.now + Math.max(0, this.policy.latencyMs(message)),
        order: deliveryOrder++,
        target: { kind: 'node', nodeId },
        message,
        copy,
        copies,
      });
    }
  }

  /**
   * Advance true time to `targetMs`, dispatching all deliveries due by then.
   * Deliveries created while draining that are also due are processed in the
   * same call.  Time never moves backwards.
   */
  advanceTo(targetMs: number): void {
    if (targetMs < this.now) throw new Error('cannot move simulated time backwards');
    while (true) {
      const next = this.nextDue(targetMs);
      if (!next) break;
      this.pending.splice(this.pending.indexOf(next), 1);
      this.trueClock.set(next.dueAt);
      this.dispatch(next);
    }
    this.trueClock.set(targetMs);
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.now + ms);
  }

  /** Deliver everything currently queued (advancing true time as needed). */
  runUntilIdle(): void {
    while (this.pending.length > 0) {
      const next = this.nextDue(Number.POSITIVE_INFINITY);
      if (!next) break;
      this.pending.splice(this.pending.indexOf(next), 1);
      this.trueClock.set(Math.max(this.now, next.dueAt));
      this.dispatch(next);
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }

  private nextDue(limit: number): PendingDelivery | null {
    let best: PendingDelivery | null = null;
    for (const entry of this.pending) {
      if (entry.dueAt > limit) continue;
      if (!best || entry.dueAt < best.dueAt || (entry.dueAt === best.dueAt && entry.order < best.order)) {
        best = entry;
      }
    }
    return best;
  }

  private dispatch(entry: PendingDelivery): void {
    if (entry.target.kind === 'coordinator') {
      const message = entry.message as NodeToCoordinatorMessage;
      const from =
        message.type === 'borrow.request' || message.type === 'return.intent' || message.type === 'consume.report'
          ? message.nodeId
          : 'unknown';
      if (this.offline.has(from)) {
        this.log.push({
          at: this.now,
          direction: 'node->coordinator',
          message,
          outcome: 'partitioned',
          copy: entry.copy,
        });
        return;
      }
      this.log.push({
        at: this.now,
        direction: 'node->coordinator',
        message,
        outcome: 'delivered',
        copy: entry.copy,
      });
      const reply = this.coordinator.handle(message, this.optionsAt(message));
      if (reply) this.enqueueReply(from, reply);
      return;
    }

    const { nodeId } = entry.target;
    if (this.offline.has(nodeId)) {
      this.log.push({
        at: this.now,
        direction: 'coordinator->node',
        message: entry.message,
        outcome: 'partitioned',
        copy: entry.copy,
      });
      return;
    }
    this.log.push({
      at: this.now,
      direction: 'coordinator->node',
      message: entry.message,
      outcome: 'delivered',
      copy: entry.copy,
    });
    this.endpoints.get(nodeId)?.receive(entry.message as CoordinatorToNodeMessage);
  }
}
