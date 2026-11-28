import type {
  AnnouncePacket,
  Clock,
  DataPacket,
  DatagramNetwork,
  EndpointId,
  NackPacket,
  Packet,
  RandomSource,
  RepairPacket,
  SourceId,
} from './types.ts';
import { normalizeRanges } from './ranges.ts';

export interface SourceOptions {
  sourceId: SourceId;
  network: DatagramNetwork;
  clock: Clock;
  /** Reserved for future randomised source-side policy (repair spacing, etc.). */
  random?: RandomSource;
  /** How many most recent data packets are retained for repair. */
  repairWindowSize?: number;
  /** Periodic announcement cadence; `0` disables the periodic timer. */
  announceIntervalMs?: number;
  /** Repairs are multicast by default so every receiver missing the gap benefits. */
  repairMode?: 'multicast' | 'unicast';
  /** Upper bound on repair packets emitted for a single NACK. */
  maxRepairsPerRequest?: number;
  generation?: number;
  autoStart?: boolean;
}

export interface SourceStats {
  readonly generation: number;
  readonly upperBound: number;
  readonly floor: number;
  readonly buffered: number;
  readonly published: number;
  readonly repairsSent: number;
  readonly repairRequests: number;
  readonly deferredRepairs: number;
  readonly unavailableRepairs: number;
  readonly announcesSent: number;
  readonly staleNacksIgnored: number;
  readonly foreignPacketsIgnored: number;
}

interface ResolvedSourceOptions {
  sourceId: SourceId;
  network: DatagramNetwork;
  clock: Clock;
  repairWindowSize: number;
  announceIntervalMs: number;
  repairMode: 'multicast' | 'unicast';
  maxRepairsPerRequest: number;
}

/**
 * Single sending source for a NACK-based reliable multicast session.
 *
 * The source numbers payloads monotonically per generation, retains the last
 * `repairWindowSize` payloads, answers NACKs for anything still retained, and
 * periodically announces the highest sequence sent plus the oldest sequence it
 * can still repair. NACKs for a previous generation are ignored.
 */
export class MulticastSource {
  private readonly options: ResolvedSourceOptions;
  private generation: number;
  private seq = 0;
  private readonly buffer = new Map<number, unknown>();
  private readonly counters = {
    published: 0,
    repairsSent: 0,
    repairRequests: 0,
    deferredRepairs: 0,
    unavailableRepairs: 0,
    announcesSent: 0,
    staleNacksIgnored: 0,
    foreignPacketsIgnored: 0,
  };
  private announceTimer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(options: SourceOptions) {
    if (!options.sourceId) throw new Error('MulticastSource: sourceId is required');
    const windowSize = options.repairWindowSize ?? 256;
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new Error('MulticastSource: repairWindowSize must be a positive integer');
    }
    const announceInterval = options.announceIntervalMs ?? 250;
    if (announceInterval < 0 || !Number.isFinite(announceInterval)) {
      throw new Error('MulticastSource: announceIntervalMs must be >= 0');
    }
    this.generation = options.generation ?? 1;
    if (!Number.isInteger(this.generation) || this.generation < 1) {
      throw new Error('MulticastSource: generation must be a positive integer');
    }
    this.options = {
      sourceId: options.sourceId,
      network: options.network,
      clock: options.clock,
      repairWindowSize: windowSize,
      announceIntervalMs: announceInterval,
      repairMode: options.repairMode ?? 'multicast',
      maxRepairsPerRequest: options.maxRepairsPerRequest ?? 512,
    };
    if (options.autoStart !== false) this.start();
  }

  get sourceId(): SourceId {
    return this.options.sourceId;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get upperBound(): number {
    return this.seq;
  }

  get floor(): number {
    return Math.max(1, this.seq - this.options.repairWindowSize + 1);
  }

  get stats(): SourceStats {
    return {
      generation: this.generation,
      upperBound: this.upperBound,
      floor: this.floor,
      buffered: this.buffer.size,
      ...this.counters,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.options.network.subscribe(this.sourceId, (packet, from) => {
      this.handlePacket(packet, from);
    });
    this.announceNow();
    this.scheduleAnnounce();
  }

  stop(): void {
    this.started = false;
    if (this.announceTimer !== null) {
      this.options.clock.clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Publish one payload and return the emitted data packet. */
  publish(payload: unknown): DataPacket {
    this.seq += 1;
    this.buffer.set(this.seq, payload);
    while (this.buffer.size > this.options.repairWindowSize) {
      const oldest = this.buffer.keys().next();
      if (oldest.done === true) break;
      this.buffer.delete(oldest.value);
    }
    const packet: DataPacket = {
      kind: 'data',
      sourceId: this.sourceId,
      generation: this.generation,
      seq: this.seq,
      payload,
    };
    this.counters.published += 1;
    this.options.network.broadcast(this.sourceId, packet);
    return packet;
  }

  /**
   * Start a new generation: sequence numbering restarts at 1, the old repair
   * buffer is dropped, and a fresh announcement is sent immediately.
   */
  restart(): number {
    this.generation += 1;
    this.seq = 0;
    this.buffer.clear();
    this.announceNow();
    return this.generation;
  }

  announceNow(): AnnouncePacket {
    const packet: AnnouncePacket = {
      kind: 'announce',
      sourceId: this.sourceId,
      generation: this.generation,
      upperBound: this.seq,
      floor: this.floor,
    };
    this.counters.announcesSent += 1;
    this.options.network.broadcast(this.sourceId, packet);
    return packet;
  }

  private scheduleAnnounce(): void {
    if (!this.started || this.options.announceIntervalMs <= 0) return;
    this.announceTimer = this.options.clock.setTimeout(() => {
      this.announceTimer = null;
      this.announceNow();
      this.scheduleAnnounce();
    }, this.options.announceIntervalMs);
  }

  private handlePacket(packet: Packet, from: EndpointId): void {
    if (packet.kind !== 'nack') return;
    if (packet.sourceId !== this.sourceId) {
      this.counters.foreignPacketsIgnored += 1;
      return;
    }
    if (packet.generation !== this.generation) {
      this.counters.staleNacksIgnored += 1;
      return;
    }
    this.counters.repairRequests += 1;
    this.serveNack(packet, from);
  }

  private serveNack(nack: NackPacket, from: EndpointId): void {
    const floor = this.floor;
    const upper = this.seq;
    const requested = normalizeRanges(nack.ranges);
    let budget = this.options.maxRepairsPerRequest;
    let unavailable = 0;
    let deferred = 0;

    for (const range of requested) {
      // Anything below the floor is gone; anything above the upper bound has
      // not been sent yet.
      if (range.start < floor) {
        unavailable += Math.min(range.end, floor - 1) - range.start + 1;
      }
      const start = Math.max(range.start, floor);
      const end = Math.min(range.end, upper);
      if (start > end) continue;
      for (let seq = start; seq <= end; seq++) {
        if (budget <= 0) {
          deferred += end - seq + 1;
          break;
        }
        const payload = this.buffer.get(seq);
        if (payload === undefined) {
          unavailable += 1;
          continue;
        }
        this.sendRepair(seq, payload, from);
        budget -= 1;
      }
    }

    this.counters.unavailableRepairs += unavailable;
    this.counters.deferredRepairs += deferred;

    // Tell a requester that part of its gap has fallen out of the window so it
    // can resynchronise instead of waiting for repairs that will never come.
    if (unavailable > 0) {
      const announce: AnnouncePacket = {
        kind: 'announce',
        sourceId: this.sourceId,
        generation: this.generation,
        upperBound: this.seq,
        floor,
      };
      this.counters.announcesSent += 1;
      this.options.network.unicast(this.sourceId, from, announce);
    }
  }

  private sendRepair(seq: number, payload: unknown, requester: EndpointId): void {
    const packet: RepairPacket = {
      kind: 'repair',
      sourceId: this.sourceId,
      generation: this.generation,
      seq,
      payload,
    };
    this.counters.repairsSent += 1;
    if (this.options.repairMode === 'unicast') {
      this.options.network.unicast(this.sourceId, requester, packet);
    } else {
      this.options.network.broadcast(this.sourceId, packet);
    }
  }
}
