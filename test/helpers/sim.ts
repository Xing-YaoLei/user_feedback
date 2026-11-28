import { ManualClock } from '../../src/clock.ts';
import { InMemoryNetwork } from '../../src/network.ts';
import type { LinkPolicy } from '../../src/network.ts';
import { MulticastSource } from '../../src/source.ts';
import type { SourceOptions } from '../../src/source.ts';
import { MulticastReceiver } from '../../src/receiver.ts';
import type {
  GenerationChange,
  ReceiverOptions,
  ResyncRequest,
} from '../../src/receiver.ts';
import { seededRandom } from '../../src/random.ts';
import type { Packet, RandomSource } from '../../src/types.ts';

export interface SimulationOptions {
  sourceId?: string;
  repairWindowSize?: number;
  announceIntervalMs?: number;
  seed?: number;
  dataLink?: LinkPolicy;
  repairLink?: LinkPolicy;
  nackLink?: LinkPolicy;
  controlLink?: LinkPolicy;
  sourceOptions?: Partial<SourceOptions>;
}

export interface DeliveryEpoch {
  generation: number | null;
  startAt: number;
  seqs: number[];
  closedBy: 'resync' | 'restart' | null;
}

export interface RecordedResync {
  at: number;
  request: ResyncRequest;
  startAt: number;
}

export interface ReceiverRecord {
  id: string;
  receiver: MulticastReceiver;
  deliveries: { generation: number; seq: number; payload: unknown; at: number }[];
  epochs: DeliveryEpoch[];
  resyncs: RecordedResync[];
  generationChanges: GenerationChange[];
}

const key = (generation: number, seq: number): string => `${generation}:${seq}`;

export interface AddReceiverOptions extends Partial<ReceiverOptions> {
  seed?: number;
  autoResync?: boolean;
}

/**
 * Event-driven simulation over the real `MulticastSource`, `MulticastReceiver`
 * and `InMemoryNetwork`. Faults are scripted rather than random so the
 * complex scenario is deterministic: which receivers lose which sequences,
 * which first NACK is dropped, which repair copies are lost, and until when
 * repairs for a sequence are withheld.
 */
export class Simulation {
  readonly clock = new ManualClock();
  readonly network: InMemoryNetwork;
  readonly source: MulticastSource;
  readonly sourceId: string;
  readonly receivers = new Map<string, ReceiverRecord>();
  private readonly random: RandomSource;
  private readonly dataLink: LinkPolicy;
  private readonly repairLink: LinkPolicy;
  private readonly nackLink: LinkPolicy;
  private readonly controlLink: LinkPolicy;

  /** `${generation}:${seq}:${receiverId}` */
  private readonly dataDrops = new Set<string>();
  /** `${generation}:${seq}` -> virtual time before which repairs are withheld. */
  private readonly repairWithheldUntil = new Map<string, number>();
  /** `${receiverId}|${generation}:${seq}` -> remaining repair copies to drop. */
  private readonly repairDropCopies = new Map<string, number>();
  /** `${generation}:${seq}` -> remaining whole repair transmissions to drop. */
  private readonly repairTransmissionDrops = new Map<string, number>();
  private readonly repairTransmissionDecision = new WeakMap<Packet, boolean>();
  /** `${generation}:${seq}` whose repairs are duplicated on the wire. */
  private readonly duplicateRepairSeqs = new Set<string>();
  private readonly nackDropOnce = new Set<string>();
  private readonly firstNackSeen = new Set<string>();
  private readonly nackDropDecision = new WeakMap<Packet, boolean>();

  readonly counters = {
    firstNacksDropped: 0,
    repairsWithheld: 0,
    repairCopiesDropped: 0,
    repairTransmissionsDropped: 0,
    repairDuplicatesInjected: 0,
    dataDropsApplied: 0,
  };

  constructor(options: SimulationOptions = {}) {
    this.sourceId = options.sourceId ?? 'source';
    this.random = seededRandom(options.seed ?? 1234);
    this.dataLink = options.dataLink ?? { delayMs: 2, jitterMs: 2 };
    this.repairLink = options.repairLink ?? { delayMs: 5, jitterMs: 5 };
    this.nackLink = options.nackLink ?? { delayMs: 1, jitterMs: 1 };
    this.controlLink = options.controlLink ?? { delayMs: 1 };
    this.network = new InMemoryNetwork({ clock: this.clock, random: this.random });
    this.network.addFilter((from, to, packet) => this.filter(from, to, packet));
    this.source = new MulticastSource({
      sourceId: this.sourceId,
      network: this.network,
      clock: this.clock,
      random: this.random,
      repairWindowSize: options.repairWindowSize ?? 24,
      announceIntervalMs: options.announceIntervalMs ?? 25,
      ...options.sourceOptions,
    });
  }

  addReceiver(id: string, options: AddReceiverOptions = {}): ReceiverRecord {
    const { seed, autoResync = true, ...receiverOptions } = options;
    const record: ReceiverRecord = {
      id,
      receiver: null as unknown as MulticastReceiver,
      deliveries: [],
      epochs: [],
      resyncs: [],
      generationChanges: [],
    };
    const startAt = receiverOptions.startAt ?? 1;
    record.epochs.push({ generation: receiverOptions.generation ?? null, startAt, seqs: [], closedBy: null });

    let receiver!: MulticastReceiver;
    receiver = new MulticastReceiver({
      sourceId: this.sourceId,
      receiverId: id,
      network: this.network,
      clock: this.clock,
      random: seededRandom(seed ?? 9000 + this.receivers.size * 17),
      maxBufferedSeqs: 128,
      maxNackRanges: 8,
      maxPendingFeedbackRanges: 16,
      initialNackDelayMs: 15,
      initialJitterMs: 25,
      repairWaitMs: 100,
      backoffBaseMs: 30,
      backoffMaxMs: 200,
      peerSuppressMs: 150,
      ...receiverOptions,
      onPayload: (seq, payload, deliveredGeneration) => {
        record.deliveries.push({ generation: deliveredGeneration, seq, payload, at: this.clock.now() });
        let epoch = record.epochs[record.epochs.length - 1]!;
        if (epoch.generation === null) epoch.generation = deliveredGeneration;
        if (epoch.generation !== deliveredGeneration) {
          this.closeEpoch(record, 'restart');
          epoch = { generation: deliveredGeneration, startAt: seq, seqs: [], closedBy: null };
          record.epochs.push(epoch);
        }
        epoch.seqs.push(seq);
        receiverOptions.onPayload?.(seq, payload, deliveredGeneration);
      },
      onResyncRequired: (request) => {
        // Choose a start point the receiver can satisfy immediately: the
        // lowest repair floor, moved up to the first already-buffered range
        // when the floor itself is not buffered.
        const firstBuffered = request.buffered.find((range) => range.end >= request.lowestAvailable);
        const chosen =
          firstBuffered === undefined
            ? request.lowestAvailable
            : Math.max(request.lowestAvailable, firstBuffered.start);
        record.resyncs.push({ at: this.clock.now(), request, startAt: 0 });
        receiverOptions.onResyncRequired?.(request);
        if (!autoResync) return;
        this.applyResync(id, chosen);
      },
      onGenerationChange: (change) => {
        record.generationChanges.push(change);
        this.closeEpoch(record, 'restart');
        record.epochs.push({ generation: change.to, startAt: 1, seqs: [], closedBy: null });
        receiverOptions.onGenerationChange?.(change);
      },
    });
    record.receiver = receiver;
    this.receivers.set(id, record);
    return record;
  }

  private closeEpoch(record: ReceiverRecord, reason: 'resync' | 'restart'): void {
    const epoch = record.epochs[record.epochs.length - 1];
    if (epoch !== undefined && epoch.closedBy === null) epoch.closedBy = reason;
  }

  /**
   * Apply a caller-chosen resync start point to a receiver added with
   * `autoResync: false`. Records the choice against the last resync request.
   */
  applyResync(id: string, startAt: number): void {
    const record = this.receivers.get(id);
    if (record === undefined) throw new Error(`unknown receiver ${id}`);
    const last = record.resyncs[record.resyncs.length - 1];
    if (last !== undefined) last.startAt = startAt;
    this.closeEpoch(record, 'resync');
    record.epochs.push({
      generation: record.receiver.currentGeneration,
      startAt,
      seqs: [],
      closedBy: null,
    });
    record.receiver.resync(startAt);
  }

  /** Lose these (generation, seq) data packets for the given receivers. */
  dropData(generation: number, seqs: readonly number[], receivers: readonly string[]): void {
    for (const seq of seqs) {
      for (const receiver of receivers) this.dataDrops.add(`${generation}:${seq}:${receiver}`);
    }
  }

  /** Withhold repairs for these sequences until `until` ms; Infinity = never. */
  withholdRepairs(generation: number, seqs: readonly number[], until: number): void {
    for (const seq of seqs) this.repairWithheldUntil.set(key(generation, seq), until);
  }

  /** Drop the first `copies` repair transmissions per receiver for these seqs. */
  dropRepairCopies(
    generation: number,
    seqs: readonly number[],
    receivers: readonly string[],
    copies = 1,
  ): void {
    for (const seq of seqs) {
      for (const receiver of receivers) {
        this.repairDropCopies.set(`${receiver}|${key(generation, seq)}`, copies);
      }
    }
  }

  /** Drop the first `copies` whole repair broadcasts for these sequences. */
  dropRepairTransmissions(generation: number, seqs: readonly number[], copies = 1): void {
    for (const seq of seqs) this.repairTransmissionDrops.set(key(generation, seq), copies);
  }

  /** Deliver an extra copy of repairs for these sequences on every repair. */
  duplicateRepairs(generation: number, seqs: readonly number[]): void {
    for (const seq of seqs) this.duplicateRepairSeqs.add(key(generation, seq));
  }

  /** Drop the very first NACK emitted by each of these receivers. */
  dropFirstNackFrom(receivers: readonly string[]): void {
    for (const receiver of receivers) this.nackDropOnce.add(receiver);
  }

  /** Publish once. Returns the payload that must arrive intact. */
  publish(): { payload: string; generation: number; seq: number } {
    const generation = this.source.currentGeneration;
    const seq = this.source.upperBound + 1;
    const payload = `g${generation}:${seq}`;
    this.source.publish(payload);
    return { payload, generation, seq };
  }

  /** Publish `count` packets spaced `everyMs` apart in virtual time. */
  publishSeries(count: number, everyMs: number): void {
    for (let i = 0; i < count; i++) {
      this.publish();
      this.clock.advance(everyMs);
    }
  }

  advance(ms: number): void {
    this.clock.advance(ms);
  }

  /**
   * Advance in small steps until `done()` holds or the budget runs out.
   * Returns whether the condition was met.
   */
  advanceUntil(done: () => boolean, maxMs: number, stepMs = 5): boolean {
    if (done()) return true;
    for (let spent = 0; spent < maxMs; spent += stepMs) {
      this.clock.advance(stepMs);
      if (done()) return true;
    }
    return done();
  }

  restart(): number {
    return this.source.restart();
  }

  /** Inject a packet onto the multicast channel after `afterMs`. */
  inject(packet: Packet, afterMs = 0): void {
    this.clock.setTimeout(() => this.network.broadcast(this.sourceId, packet), afterMs);
  }

  totalDeliveries(): number {
    let total = 0;
    for (const record of this.receivers.values()) total += record.deliveries.length;
    return total;
  }

  sumStat(field: keyof MulticastReceiver['stats']): number {
    let total = 0;
    for (const record of this.receivers.values()) {
      const value = record.receiver.stats[field];
      if (typeof value === 'number') total += value;
    }
    return total;
  }

  capturedNacks(): { receiverId: string; at: number; ranges: readonly { start: number; end: number }[] }[] {
    const out: { receiverId: string; at: number; ranges: readonly { start: number; end: number }[] }[] = [];
    for (const envelope of this.network.log) {
      if (envelope.packet.kind === 'nack' && envelope.to === null) {
        out.push({
          receiverId: envelope.packet.receiverId,
          at: envelope.at,
          ranges: envelope.packet.ranges,
        });
      }
    }
    return out;
  }

  /** Count of delivered (not merely sent) NACKs per receiver. */
  deliveredNackCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const envelope of this.network.delivered) {
      if (envelope.packet.kind !== 'nack') continue;
      const id = envelope.packet.receiverId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  private filter(from: string, to: string | null, packet: Packet): LinkPolicy | null {
    const recipient = to ?? '';
    switch (packet.kind) {
      case 'data': {
        if (this.dataDrops.delete(`${packet.generation}:${packet.seq}:${recipient}`)) {
          this.counters.dataDropsApplied += 1;
          return { drop: 1 };
        }
        return this.dataLink;
      }
      case 'repair': {
        if (recipient !== this.sourceId) {
          const seqKey = key(packet.generation, packet.seq);
          const until = this.repairWithheldUntil.get(seqKey);
          if (until !== undefined && this.clock.now() < until) {
            this.counters.repairsWithheld += 1;
            return { drop: 1 };
          }
          // Whole-transmission loss is decided once for the packet, not per
          // recipient, so a dropped multicast repair never reaches anyone.
          let wholeDrop = this.repairTransmissionDecision.get(packet);
          if (wholeDrop === undefined) {
            const remaining = this.repairTransmissionDrops.get(seqKey) ?? 0;
            wholeDrop = remaining > 0;
            if (wholeDrop) this.repairTransmissionDrops.set(seqKey, remaining - 1);
            this.repairTransmissionDecision.set(packet, wholeDrop);
          }
          if (wholeDrop) {
            this.counters.repairTransmissionsDropped += 1;
            return { drop: 1 };
          }
          const dropKey = `${recipient}|${seqKey}`;
          const remaining = this.repairDropCopies.get(dropKey) ?? 0;
          if (remaining > 0) {
            this.repairDropCopies.set(dropKey, remaining - 1);
            this.counters.repairCopiesDropped += 1;
            return { drop: 1 };
          }
          if (this.duplicateRepairSeqs.has(seqKey)) {
            this.counters.repairDuplicatesInjected += 1;
            return { ...this.repairLink, duplicate: 1 };
          }
        }
        return this.repairLink;
      }
      case 'nack': {
        let dropped = this.nackDropDecision.get(packet);
        if (dropped === undefined) {
          const first = !this.firstNackSeen.has(from);
          if (first) this.firstNackSeen.add(from);
          dropped = first && this.nackDropOnce.has(from);
          if (dropped) this.counters.firstNacksDropped += 1;
          this.nackDropDecision.set(packet, dropped);
        }
        return dropped ? { drop: 1 } : this.nackLink;
      }
      case 'announce':
        return this.controlLink;
    }
  }
}
