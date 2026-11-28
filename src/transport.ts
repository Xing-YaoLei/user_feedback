import type { Clock, Message, Transport, TransportSendResult } from './types.ts';

type LinkState = 'up' | 'down';

interface HeldMessage {
  msg: Message;
  to: string;
}

/**
 * Fully controllable in-memory transport for tests and local simulation.
 *
 * Controls:
 *  - directed link up/down (down links drop immediately until restored);
 *  - node pause/resume: messages to or from a paused node are held in order
 *    and released on resume, exercising stale-message handling;
 *  - every delivery is scheduled on the injected clock so ordering is
 *    deterministic and no real timers are used.
 */
export class InMemoryTransport implements Transport {
  private handlers = new Map<string, (msg: Message) => void>();
  private links = new Map<string, LinkState>();
  private paused = new Set<string>();
  private held = new Map<string, HeldMessage[]>();
  private clock: Clock;
  private baseDelayMs: number;
  private stats = { sent: 0, delivered: 0, dropped: 0, held: 0, released: 0 };
  private history: { at: number; msg: Message; to: string; result: TransportSendResult['reason'] }[] =
    [];
  private historyLimit: number;

  constructor(clock: Clock, opts?: { baseDelayMs?: number; historyLimit?: number }) {
    this.clock = clock;
    this.baseDelayMs = opts?.baseDelayMs ?? 0;
    this.historyLimit = opts?.historyLimit ?? 500;
  }

  register(nodeId: string, handler: (msg: Message) => void): void {
    this.handlers.set(nodeId, handler);
    this.held.set(nodeId, []);
  }

  unregister(nodeId: string): void {
    this.handlers.delete(nodeId);
  }

  private linkKey(from: string, to: string): string {
    return `${from}->${to}`;
  }

  /** Configure a directed link. Default state for unconfigured links is up. */
  setLink(from: string, to: string, state: LinkState): void {
    this.links.set(this.linkKey(from, to), state);
  }

  setBidirectionalLink(a: string, b: string, state: LinkState): void {
    this.setLink(a, b, state);
    this.setLink(b, a, state);
  }

  /** Freeze all traffic to and from `nodeId`; messages are kept in order. */
  pauseNode(nodeId: string): void {
    this.paused.add(nodeId);
  }

  /** Is traffic for the node currently frozen? */
  isPaused(nodeId: string): boolean {
    return this.paused.has(nodeId);
  }

  /** Release every held message for a node (they become late deliveries). */
  resumeNode(nodeId: string): void {
    this.paused.delete(nodeId);
    const queue = this.held.get(nodeId) ?? [];
    this.held.set(nodeId, []);
    for (const item of queue) {
      this.stats.released++;
      this.deliver(item.msg, item.to);
    }
  }

  private deliver(msg: Message, to: string): void {
    this.clock.setTimer(this.baseDelayMs, () => {
      const handler = this.handlers.get(to);
      if (!handler) {
        this.stats.dropped++;
        this.record(msg, to, 'dropped-unknown-peer');
        return;
      }
      this.stats.delivered++;
      this.record(msg, to, 'delivered');
      handler(msg);
    });
  }

  private record(msg: Message, to: string, result: TransportSendResult['reason']): void {
    this.history.push({ at: this.clock.now(), msg, to, result });
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }

  send(msg: Message, to: string): TransportSendResult {
    this.stats.sent++;
    const from = msg.from;
    if (!this.handlers.has(to)) {
      this.stats.dropped++;
      this.record(msg, to, 'dropped-unknown-peer');
      return { delivered: false, reason: 'dropped-unknown-peer' };
    }
    if (this.paused.has(from) || this.paused.has(to)) {
      const queue = this.held.get(to) ?? [];
      queue.push({ msg, to });
      this.held.set(to, queue);
      this.stats.held++;
      this.record(msg, to, 'queued');
      return { delivered: false, reason: 'queued' };
    }
    if (this.links.get(this.linkKey(from, to)) === 'down') {
      this.stats.dropped++;
      this.record(msg, to, 'dropped-link-down');
      return { delivered: false, reason: 'dropped-link-down' };
    }
    this.deliver(msg, to);
    this.record(msg, to, 'queued');
    return { delivered: true, reason: 'delivered' };
  }

  getStats(): Record<string, number> {
    return { ...this.stats };
  }

  getHistory(): readonly { at: number; msg: Message; to: string; result: string }[] {
    return this.history;
  }

  /** Count delivered messages of a given wire kind. */
  countKind(kind: Message['kind']): number {
    return this.history.filter((h) => h.msg.kind === kind && h.result === 'delivered').length;
  }
}
