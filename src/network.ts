/**
 * Simulated network driven by the injected scheduler.
 *
 * Capabilities required by the spec: messages may be lost, duplicated,
 * delayed and reordered. Links can be cut (partition) and restored; messages
 * sent while a link is held are retained and can later be released in order
 * or flushed in shuffled order.
 *
 * Every delivery is a scheduled event, so the exact delivery sequence is
 * reproducible from the scheduler's RNG seed.
 */

import type { Scheduler, TimerHandle } from './scheduler.ts';
import type { NodeId, RaftMessage } from './types.ts';

export interface Envelope {
  from: NodeId;
  to: NodeId;
  message: RaftMessage;
}

export interface NetworkChaos {
  /** Probability in [0,1] that a sent message is dropped. */
  lossRate?: number;
  /** Probability in [0,1] that a sent message is duplicated (extra delayed copy). */
  duplicateRate?: number;
  /** Uniform extra delay range in virtual milliseconds. */
  minDelay?: number;
  maxDelay?: number;
  /** When true, jitter is wide enough that later messages can overtake earlier ones. */
  reorder?: boolean;
}

type Handler = (envelope: Envelope) => void;

interface LinkState {
  up: boolean;
  /** When held, envelopes are queued instead of being scheduled/dropped. */
  held: boolean;
  queue: Envelope[];
}

export class Network {
  private handlers = new Map<NodeId, Handler>();
  private links = new Map<string, LinkState>();
  private timers: TimerHandle[] = [];
  private readonly scheduler: Scheduler;
  chaos: Required<NetworkChaos>;

  constructor(
    scheduler: Scheduler,
    chaos: NetworkChaos = {},
  ) {
    this.scheduler = scheduler;
    this.chaos = {
      lossRate: chaos.lossRate ?? 0,
      duplicateRate: chaos.duplicateRate ?? 0,
      minDelay: chaos.minDelay ?? 2,
      maxDelay: chaos.maxDelay ?? 6,
      reorder: chaos.reorder ?? false,
    };
  }

  register(nodeId: NodeId, handler: Handler): void {
    this.handlers.set(nodeId, handler);
  }

  unregister(nodeId: NodeId): void {
    this.handlers.delete(nodeId);
  }

  private key(a: NodeId, b: NodeId): string {
    return [a, b].sort().join('→');
  }

  private link(a: NodeId, b: NodeId): LinkState {
    const k = this.key(a, b);
    let state = this.links.get(k);
    if (!state) {
      state = { up: true, held: false, queue: [] };
      this.links.set(k, state);
    }
    return state;
  }

  /** Fully partition two nodes: traffic in both directions is dropped. */
  isolate(a: NodeId, b: NodeId): void {
    this.link(a, b).up = false;
  }

  /** Partition `node` from every other registered node. */
  isolateAll(node: NodeId): void {
    for (const peer of this.handlers.keys()) {
      if (peer !== node) this.isolate(node, peer);
    }
  }

  heal(a: NodeId, b: NodeId): void {
    this.link(a, b).up = true;
  }

  healAll(node: NodeId): void {
    for (const peer of this.handlers.keys()) {
      if (peer !== node) this.heal(node, peer);
    }
  }

  isUp(a: NodeId, b: NodeId): boolean {
    return this.link(a, b).up;
  }

  /** Retain (rather than drop or deliver) messages on a link until released. */
  hold(a: NodeId, b: NodeId): void {
    this.link(a, b).held = true;
  }

  /** Deliver all held messages on a link in their original send order. */
  releaseHeld(a: NodeId, b: NodeId): void {
    const state = this.link(a, b);
    state.held = false;
    const queued = state.queue.splice(0);
    for (const envelope of queued) this.dispatchNow(envelope);
  }

  /** Deliver held messages in a deterministic shuffled order (RNG-driven). */
  releaseHeldShuffled(a: NodeId, b: NodeId): void {
    const state = this.link(a, b);
    state.held = false;
    const queued = state.queue.splice(0);
    // Fisher–Yates with the shared deterministic RNG.
    for (let i = queued.length - 1; i > 0; i--) {
      const j = Math.floor(this.scheduler.rng.next() * (i + 1));
      [queued[i], queued[j]] = [queued[j], queued[i]];
    }
    for (const envelope of queued) this.dispatchNow(envelope);
  }

  heldCount(a: NodeId, b: NodeId): number {
    return this.link(a, b).queue.length;
  }

  send(envelope: Envelope): void {
    const state = this.link(envelope.from, envelope.to);
    if (state.held) {
      state.queue.push(envelope);
      return;
    }
    if (!state.up) return; // silently dropped, like a partitioned UDP link
    if (this.scheduler.rng.next() < this.chaos.lossRate) return;

    this.scheduleDelivery(envelope);
    if (this.scheduler.rng.next() < this.chaos.duplicateRate) {
      this.scheduleDelivery(envelope);
    }
  }

  private scheduleDelivery(envelope: Envelope): void {
    const { minDelay, maxDelay, reorder } = this.chaos;
    const span = Math.max(0, maxDelay - minDelay);
    // Wide jitter (up to a full election-timeout-ish window) creates reordering.
    const jitter = reorder
      ? this.scheduler.rng.int(0, Math.max(span * 8, 1))
      : this.scheduler.rng.int(0, span);
    const delay = minDelay + jitter;
    const handle = this.scheduler.schedule(delay, () => {
      const handler = this.handlers.get(envelope.to);
      handler?.(envelope);
    });
    this.timers.push(handle);
  }

  /** Bypass scheduling — used when releasing retained messages. */
  private dispatchNow(envelope: Envelope): void {
    const state = this.link(envelope.from, envelope.to);
    if (!state.up) return;
    const handle = this.scheduler.schedule(1, () => {
      const handler = this.handlers.get(envelope.to);
      handler?.(envelope);
    });
    this.timers.push(handle);
  }

  /** Test helper: total live timers the network has scheduled. */
  scheduledTimerCount(): number {
    return this.timers.length;
  }
}
