import type {
  AnnouncePacket,
  Clock,
  DataPacket,
  DatagramNetwork,
  EndpointId,
  NackPacket,
  Packet,
  RandomSource,
  Range,
  RepairPacket,
  SourceId,
} from './types.ts';
import { missingWithin, normalizeRanges, rangesOverlap, SeqIntervalSet } from './ranges.ts';

export interface ResyncRequest {
  readonly reason: 'window-lost';
  readonly sourceId: SourceId;
  readonly generation: number;
  /** The sequence the receiver was waiting for when it fell out of the window. */
  readonly nextExpected: number;
  /** Gaps below the source's repair floor that can no longer be repaired. */
  readonly missing: readonly Range[];
  /** Oldest sequence the source can still repair; a valid new start point. */
  readonly lowestAvailable: number;
  /** Highest sequence the source has announced. */
  readonly upperBound: number;
  /**
   * Buffered, undelivered sequence ranges at or above the repair floor. The
   * caller can pick a start point inside one of these to resume without
   * needing further repair.
   */
  readonly buffered: readonly Range[];
}

export interface GenerationChange {
  readonly sourceId: SourceId;
  readonly from: number;
  readonly to: number;
}

export interface ReceiverOptions {
  sourceId: SourceId;
  receiverId: EndpointId;
  network: DatagramNetwork;
  clock: Clock;
  random?: RandomSource;
  /** First sequence the application wants to receive. */
  startAt?: number;
  /** Externally known generation; otherwise inferred from the first packet. */
  generation?: number;
  /** Maximum number of out-of-order sequence numbers buffered (receive cache). */
  maxBufferedSeqs?: number;
  /** Maximum out-of-order ranges requested in one NACK packet (feedback backlog). */
  maxNackRanges?: number;
  /** Maximum concurrent gap entries that may be requested in one evaluation. */
  maxPendingFeedbackRanges?: number;
  /** Grace period before the first NACK, letting reordered data settle. */
  initialNackDelayMs?: number;
  /** Random spread added to the first NACK delay so peers do not fire together. */
  initialJitterMs?: number;
  /** How long to wait for a repair before re-checking and retrying. */
  repairWaitMs?: number;
  /** Base of the random retransmission backoff. */
  backoffBaseMs?: number;
  /** Cap of the random retransmission backoff. */
  backoffMaxMs?: number;
  /** How long to defer our own request after observing a peer NACK. */
  peerSuppressMs?: number;
  onPayload?: (seq: number, payload: unknown, generation: number) => void;
  onResyncRequired?: (request: ResyncRequest) => void;
  onGenerationChange?: (change: GenerationChange) => void;
}

export interface ReceiverStats {
  readonly generation: number | null;
  readonly nextExpected: number;
  readonly upperBoundObserved: number;
  readonly floorObserved: number;
  readonly buffered: number;
  readonly delivered: number;
  readonly duplicates: number;
  readonly staleGenerationPackets: number;
  readonly bufferOverflowDrops: number;
  readonly repairsReceived: number;
  readonly nacksSent: number;
  readonly nackRangesSent: number;
  readonly nackRetries: number;
  readonly deferredByPeer: number;
  readonly peerNacksObserved: number;
  readonly feedbackBacklogDeferred: number;
  readonly resyncSignals: number;
  readonly awaitingResync: boolean;
}

interface GapEntry {
  start: number;
  end: number;
  attempts: number;
  lastSentAt: number | null;
  nextAt: number;
  deferred: boolean;
}

interface PeerNackRecord {
  receiverId: EndpointId;
  ranges: Range[];
  at: number;
}

interface ResolvedOptions {
  sourceId: SourceId;
  receiverId: EndpointId;
  network: DatagramNetwork;
  clock: Clock;
  random: RandomSource;
  maxBufferedSeqs: number;
  maxNackRanges: number;
  maxPendingFeedbackRanges: number;
  initialNackDelayMs: number;
  initialJitterMs: number;
  repairWaitMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  peerSuppressMs: number;
  onPayload?: (seq: number, payload: unknown, generation: number) => void;
  onResyncRequired?: (request: ResyncRequest) => void;
  onGenerationChange?: (change: GenerationChange) => void;
}

const defaultRandom: RandomSource = () => Math.random();

const gapKey = (entry: GapEntry): string => `${entry.start}-${entry.end}`;

/**
 * Ordered, exactly-once receiver for the multicast source.
 *
 * Out-of-order packets are buffered within a bounded cache, gaps are merged
 * into NACK packets and retried with randomised backoff, and peer NACKs
 * observed on the multicast channel defer our own overlapping requests. If the
 * next expected sequence falls out of the source's repair window the receiver
 * stops pretending the stream is continuous and reports an explicit resync
 * request with the lowest still-repairable sequence; the caller chooses a new
 * start point via `resync`.
 */
export class MulticastReceiver {
  private readonly options: ResolvedOptions;
  private generation: number | null;
  private nextExpected: number;
  private readonly initialStartAt: number;
  private upperObserved = 0;
  private floorObserved = 1;
  private readonly buffer = new Map<number, unknown>();
  private readonly bufferedSet = new SeqIntervalSet();
  private entries = new Map<string, GapEntry>();
  private readonly peerNacks: PeerNackRecord[] = [];
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private awaitingResync = false;
  private resyncRequestValue: ResyncRequest | null = null;
  private evaluating = false;
  private evaluateQueued = false;
  private readonly counters = {
    delivered: 0,
    duplicates: 0,
    staleGenerationPackets: 0,
    bufferOverflowDrops: 0,
    repairsReceived: 0,
    nacksSent: 0,
    nackRangesSent: 0,
    nackRetries: 0,
    deferredByPeer: 0,
    peerNacksObserved: 0,
    feedbackBacklogDeferred: 0,
    resyncSignals: 0,
  };

  constructor(options: ReceiverOptions) {
    if (!options.sourceId) throw new Error('MulticastReceiver: sourceId is required');
    if (!options.receiverId) throw new Error('MulticastReceiver: receiverId is required');
    const startAt = options.startAt ?? 1;
    if (!Number.isInteger(startAt) || startAt < 1) {
      throw new Error('MulticastReceiver: startAt must be a positive integer');
    }
    this.nextExpected = startAt;
    this.initialStartAt = startAt;
    this.generation = options.generation ?? null;
    if (this.generation !== null && (!Number.isInteger(this.generation) || this.generation < 1)) {
      throw new Error('MulticastReceiver: generation must be a positive integer');
    }
    this.options = {
      sourceId: options.sourceId,
      receiverId: options.receiverId,
      network: options.network,
      clock: options.clock,
      random: options.random ?? defaultRandom,
      maxBufferedSeqs: positive(options.maxBufferedSeqs ?? 512, 'maxBufferedSeqs'),
      maxNackRanges: positive(options.maxNackRanges ?? 16, 'maxNackRanges'),
      maxPendingFeedbackRanges: positive(
        options.maxPendingFeedbackRanges ?? 32,
        'maxPendingFeedbackRanges',
      ),
      initialNackDelayMs: nonNegative(options.initialNackDelayMs ?? 15, 'initialNackDelayMs'),
      initialJitterMs: nonNegative(options.initialJitterMs ?? 40, 'initialJitterMs'),
      repairWaitMs: nonNegative(options.repairWaitMs ?? 200, 'repairWaitMs'),
      backoffBaseMs: nonNegative(options.backoffBaseMs ?? 40, 'backoffBaseMs'),
      backoffMaxMs: nonNegative(options.backoffMaxMs ?? 320, 'backoffMaxMs'),
      peerSuppressMs: nonNegative(options.peerSuppressMs ?? 120, 'peerSuppressMs'),
      onPayload: options.onPayload,
      onResyncRequired: options.onResyncRequired,
      onGenerationChange: options.onGenerationChange,
    };
    this.unsubscribe = this.options.network.subscribe(this.options.receiverId, (packet, from) => {
      this.receive(packet, from);
    });
  }

  get id(): EndpointId {
    return this.options.receiverId;
  }

  get currentGeneration(): number | null {
    return this.generation;
  }

  get nextSequence(): number {
    return this.nextExpected;
  }

  get resyncRequest(): ResyncRequest | null {
    return this.resyncRequestValue;
  }

  get stats(): ReceiverStats {
    return {
      generation: this.generation,
      nextExpected: this.nextExpected,
      upperBoundObserved: this.upperObserved,
      floorObserved: this.floorObserved,
      buffered: this.buffer.size,
      awaitingResync: this.awaitingResync,
      ...this.counters,
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) {
      this.options.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Accept a new start point after a resync request. Must not be below the
   * source's announced repair floor (that data is gone), nor below data already
   * delivered (that would re-deliver duplicates). `nextSequence` is the first
   * sequence not yet delivered, so any valid start point is >= it.
   */
  resync(startAt: number): void {
    if (!Number.isInteger(startAt) || startAt < 1) {
      throw new Error('MulticastReceiver.resync: startAt must be a positive integer');
    }
    if (startAt < this.floorObserved) {
      throw new Error(
        `MulticastReceiver.resync: startAt ${startAt} is below the repair floor ${this.floorObserved}`,
      );
    }
    if (startAt < this.nextExpected) {
      throw new Error(
        `MulticastReceiver.resync: startAt ${startAt} would re-deliver already-delivered data ` +
          `(next expected is ${this.nextExpected})`,
      );
    }
    this.nextExpected = startAt;
    this.awaitingResync = false;
    this.resyncRequestValue = null;
    for (const seq of [...this.buffer.keys()]) {
      if (seq < startAt) this.dropBuffered(seq);
    }
    this.entries.clear();
    this.cancelTimer();
    this.drainBuffered();
    this.evaluate();
  }

  /** Feed a packet directly; the network subscription calls this too. */
  receive(packet: Packet, from: EndpointId = ''): void {
    if (this.closed) return;
    if (packet.sourceId !== this.options.sourceId) return;

    switch (packet.kind) {
      case 'data':
      case 'repair':
        this.handlePayload(packet, from);
        return;
      case 'announce':
        this.handleAnnounce(packet);
        return;
      case 'nack':
        this.handlePeerNack(packet);
        return;
    }
  }

  private handlePayload(packet: DataPacket | RepairPacket, _from: EndpointId): void {
    if (!this.ensureGeneration(packet.generation)) return;
    if (packet.kind === 'repair') this.counters.repairsReceived += 1;

    const seq = packet.seq;
    if (!Number.isInteger(seq) || seq < 1) return;
    this.upperObserved = Math.max(this.upperObserved, seq);

    if (this.awaitingResync) {
      if (seq >= this.floorObserved) this.bufferFuture(seq, packet.payload);
      return;
    }

    if (seq < this.nextExpected) {
      this.counters.duplicates += 1;
      return;
    }
    if (seq === this.nextExpected) {
      this.deliver(seq, packet.payload);
      this.nextExpected += 1;
      this.drainBuffered();
      this.evaluate();
      return;
    }

    if (this.bufferFuture(seq, packet.payload)) this.evaluate();
  }

  /** Buffer a sequence ahead of `nextExpected`; returns true if newly stored. */
  private bufferFuture(seq: number, payload: unknown): boolean {
    if (seq < this.nextExpected) {
      this.counters.duplicates += 1;
      return false;
    }
    if (this.bufferedSet.has(seq)) {
      this.counters.duplicates += 1;
      return false;
    }
    if (this.buffer.size >= this.options.maxBufferedSeqs) {
      const highest = this.bufferedSet.maxSeq();
      if (highest === undefined || seq > highest) {
        this.counters.bufferOverflowDrops += 1;
        return false;
      }
      // Evict the farthest-ahead buffered sequence to make room for one that
      // is closer to the gap we actually need to fill.
      this.dropBuffered(highest);
      this.counters.bufferOverflowDrops += 1;
    }
    this.buffer.set(seq, payload);
    this.bufferedSet.add(seq);
    return true;
  }

  private handleAnnounce(packet: AnnouncePacket): void {
    if (!this.ensureGeneration(packet.generation)) return;
    this.upperObserved = Math.max(this.upperObserved, packet.upperBound);
    this.floorObserved = Math.max(this.floorObserved, packet.floor);
    this.evaluate();
  }

  private handlePeerNack(packet: NackPacket): void {
    if (this.generation === null || packet.generation !== this.generation) return;
    if (packet.receiverId === this.options.receiverId) return;
    const now = this.options.clock.now();
    this.counters.peerNacksObserved += 1;
    const ranges = normalizeRanges(packet.ranges);
    if (ranges.length === 0) return;
    this.peerNacks.push({ receiverId: packet.receiverId, ranges, at: now });
    this.prunePeerNacks(now);
    this.evaluate();
  }

  private prunePeerNacks(now: number): void {
    const cutoff = now - this.options.peerSuppressMs;
    while (this.peerNacks.length > 0 && this.peerNacks[0]!.at < cutoff) {
      this.peerNacks.shift();
    }
    while (this.peerNacks.length > 128) this.peerNacks.shift();
  }

  /**
   * Adopt a new generation, or reject stale traffic. A newer generation is a
   * source restart: sequence numbering begins at 1 again and every buffered
   * sequence from the old generation is discarded so it cannot leak into the
   * new stream.
   */
  private ensureGeneration(generation: number): boolean {
    if (!Number.isInteger(generation) || generation < 1) return false;
    if (this.generation === null) {
      this.adoptGeneration(generation, false);
      return true;
    }
    if (generation < this.generation) {
      this.counters.staleGenerationPackets += 1;
      return false;
    }
    if (generation > this.generation) {
      this.adoptGeneration(generation, true);
      return true;
    }
    return true;
  }

  private adoptGeneration(generation: number, notify: boolean): void {
    const previous = this.generation;
    this.generation = generation;
    // The first generation honours an explicit caller start point; a restart
    // restarts numbering at 1.
    this.nextExpected = previous === null ? this.initialStartAt : 1;
    this.upperObserved = 0;
    this.floorObserved = 1;
    this.buffer.clear();
    this.bufferedSet.clear();
    this.entries.clear();
    this.peerNacks.length = 0;
    this.awaitingResync = false;
    this.resyncRequestValue = null;
    this.cancelTimer();
    if (notify && previous !== null) {
      this.options.onGenerationChange?.({
        sourceId: this.options.sourceId,
        from: previous,
        to: generation,
      });
    }
  }

  private deliver(seq: number, payload: unknown): void {
    this.counters.delivered += 1;
    this.options.onPayload?.(seq, payload, this.generation ?? 0);
  }

  private drainBuffered(): void {
    while (this.bufferedSet.has(this.nextExpected)) {
      const seq = this.nextExpected;
      const payload = this.buffer.get(seq);
      this.dropBuffered(seq);
      this.deliver(seq, payload);
      this.nextExpected += 1;
    }
  }

  private dropBuffered(seq: number): void {
    this.buffer.delete(seq);
    this.bufferedSet.remove(seq);
  }

  private evaluate(): void {
    if (this.closed) return;
    if (this.evaluating) {
      this.evaluateQueued = true;
      return;
    }
    this.evaluating = true;
    try {
      do {
        this.evaluateQueued = false;
        this.evaluateOnce();
      } while (this.evaluateQueued);
    } finally {
      this.evaluating = false;
    }
  }

  private evaluateOnce(): void {
    if (this.generation === null) return;

    if (this.awaitingResync) {
      if (this.nextExpected < this.floorObserved) {
        // Still stuck: refresh the reported boundary, request nothing.
        this.updateResyncRequest(this.missingBelowWindow());
        this.cancelTimer();
        return;
      }
      // The floor no longer covers our next sequence (e.g. an external
      // resync); resume normal operation.
      this.awaitingResync = false;
      this.resyncRequestValue = null;
      this.drainBuffered();
    }

    if (this.nextExpected < this.floorObserved) {
      this.issueResync();
      return;
    }

    const missing = normalizeRanges(
      missingWithin(this.bufferRanges(), this.nextExpected, this.upperObserved),
    );
    if (missing.length === 0) {
      this.entries.clear();
      this.cancelTimer();
      return;
    }

    const now = this.options.clock.now();
    this.prunePeerNacks(now);
    const oldEntries = this.entries;
    const nextEntries = new Map<string, GapEntry>();

    // Split every missing range at peer-suppression boundaries, so a gap that
    // is wholly or partly covered by a peer NACK is tracked separately from
    // one we may request now. This keeps range merging from ever re-requesting
    // a hole a peer already asked for.
    const segments: { range: Range; suppressedUntil: number }[] = [];
    for (const range of missing) {
      for (const segment of splitBySuppression(range, this.peerNacks, now, this.options.peerSuppressMs)) {
        segments.push(segment);
      }
    }

    // Ready gaps form runs; a run is broken by any suppressed or not-yet-due
    // gap so a merged range never spans a gap that is not being requested.
    const groups: GapEntry[][] = [];
    let current: GapEntry[] = [];
    let earliest = Number.POSITIVE_INFINITY;

    for (const { range, suppressedUntil } of segments) {
      const entry = this.inheritEntry(range, oldEntries, now);
      if (suppressedUntil > now) {
        if (!entry.deferred) {
          entry.deferred = true;
          this.counters.deferredByPeer += 1;
        }
        entry.nextAt = Math.max(entry.nextAt, suppressedUntil);
      }
      nextEntries.set(gapKey(entry), entry);

      const ready = now >= entry.nextAt;
      if (!ready) {
        earliest = Math.min(earliest, entry.nextAt);
        if (current.length > 0) {
          groups.push(current);
          current = [];
        }
        continue;
      }
      const last = current[current.length - 1];
      if (last !== undefined && entry.start > last.end + 1) {
        groups.push(current);
        current = [];
      }
      current.push(entry);
    }
    if (current.length > 0) groups.push(current);
    this.entries = nextEntries;

    const readyCount = groups.reduce((sum, group) => sum + group.length, 0);
    if (readyCount > 0) {
      this.sendNacks(groups, now);
      for (const entry of this.entries.values()) {
        if (entry.nextAt <= now) entry.nextAt = now + 1;
        earliest = Math.min(earliest, entry.nextAt);
      }
    }
    if (Number.isFinite(earliest)) {
      this.setTimer(earliest);
    } else {
      this.cancelTimer();
    }
  }

  private inheritEntry(range: Range, old: Map<string, GapEntry>, now: number): GapEntry {
    let attempts = 0;
    let lastSentAt: number | null = null;
    let inheritedNext: number | null = null;
    let deferred = false;
    for (const entry of old.values()) {
      if (!rangesOverlap(entry, range)) continue;
      attempts = Math.max(attempts, entry.attempts);
      if (entry.lastSentAt !== null && (lastSentAt === null || entry.lastSentAt > lastSentAt)) {
        lastSentAt = entry.lastSentAt;
      }
      inheritedNext = inheritedNext === null ? entry.nextAt : Math.min(inheritedNext, entry.nextAt);
      deferred = deferred || entry.deferred;
    }
    // Preserve an already-scheduled send time so repeated evaluations (each
    // incoming packet triggers one) do not push the NACK back forever.
    if (inheritedNext !== null) {
      return {
        start: range.start,
        end: range.end,
        attempts,
        lastSentAt,
        nextAt: inheritedNext,
        deferred,
      };
    }
    return {
      start: range.start,
      end: range.end,
      attempts,
      lastSentAt,
      nextAt:
        now +
        this.options.initialNackDelayMs +
        (this.options.initialNackDelayMs > 0
          ? Math.floor(this.options.random() * this.options.initialJitterMs)
          : 0),
      deferred,
    };
  }

  private bufferRanges(): Range[] {
    return this.bufferedSet.toRanges();
  }

  private sendNacks(groups: GapEntry[][], now: number): void {
    // The per-packet range budget is enforced on the group runs themselves:
    // never merge two runs across a peer-deferred gap. Excess runs are deferred
    // to the next tick (bounded feedback backlog) rather than coalesced.
    const orderedGroups = groups
      .map((group, index) => ({ group, index }))
      .sort((a, b) => a.group[0]!.start - b.group[0]!.start);
    const keptGroups = orderedGroups.slice(0, this.options.maxNackRanges);
    if (orderedGroups.length > keptGroups.length) {
      for (const { group } of orderedGroups.slice(keptGroups.length)) {
        for (const entry of group) entry.nextAt = now + 1;
        this.counters.feedbackBacklogDeferred += group.length;
      }
    }

    const flat = keptGroups
      .flatMap(({ group, index }) => group.map((entry) => ({ entry, groupIndex: index })))
      .sort((a, b) => a.entry.start - b.entry.start);
    const capped = flat.slice(0, this.options.maxPendingFeedbackRanges);
    if (flat.length > capped.length) {
      this.counters.feedbackBacklogDeferred += flat.length - capped.length;
      for (const { entry } of flat.slice(capped.length)) entry.nextAt = now + 1;
    }

    const ranges: Range[] = [];
    let groupStart: { groupIndex: number; from: number; to: number } | null = null;
    const flushGroup = (): void => {
      if (groupStart !== null) ranges.push({ start: groupStart.from, end: groupStart.to });
      groupStart = null;
    };
    for (const { entry, groupIndex } of capped) {
      if (groupStart === null || groupStart.groupIndex !== groupIndex) {
        flushGroup();
        groupStart = { groupIndex, from: entry.start, to: entry.end };
      } else if (entry.start <= groupStart.to + 1) {
        groupStart.to = Math.max(groupStart.to, entry.end);
      } else {
        flushGroup();
        groupStart = { groupIndex, from: entry.start, to: entry.end };
      }
    }
    flushGroup();
    if (ranges.length === 0) return;

    const packet: NackPacket = {
      kind: 'nack',
      sourceId: this.options.sourceId,
      generation: this.generation ?? 0,
      receiverId: this.options.receiverId,
      ranges,
      floor: this.floorObserved,
      upperBound: this.upperObserved,
    };
    this.counters.nacksSent += 1;
    this.counters.nackRangesSent += ranges.length;

    const base = this.options.repairWaitMs;
    for (const { entry } of capped) {
      if (entry.attempts > 0) this.counters.nackRetries += 1;
      entry.attempts += 1;
      entry.lastSentAt = now;
      entry.deferred = false;
      const jitterCap = Math.min(
        this.options.backoffMaxMs,
        this.options.backoffBaseMs * 2 ** Math.min(entry.attempts - 1, 16),
      );
      const jitter = jitterCap > 0 ? Math.floor(this.options.random() * jitterCap) : 0;
      entry.nextAt = now + Math.max(1, base + jitter);
    }

    this.options.network.broadcast(this.options.receiverId, packet);
  }

  private issueResync(): void {
    this.awaitingResync = true;
    this.entries.clear();
    this.cancelTimer();
    this.counters.resyncSignals += 1;
    this.resyncRequestValue = {
      reason: 'window-lost',
      sourceId: this.options.sourceId,
      generation: this.generation ?? 0,
      nextExpected: this.nextExpected,
      missing: this.missingBelowWindow(),
      lowestAvailable: this.floorObserved,
      upperBound: this.upperObserved,
      buffered: this.bufferedAboveFloor(),
    };
    this.options.onResyncRequired?.(this.resyncRequestValue);
  }

  private bufferedAboveFloor(): Range[] {
    return normalizeRanges(
      this.bufferRanges().filter((range) => range.end >= this.floorObserved),
    ).map((range) => ({
      start: Math.max(range.start, this.floorObserved),
      end: range.end,
    }));
  }

  private updateResyncRequest(missing: readonly Range[]): void {
    if (this.resyncRequestValue === null) return;
    this.resyncRequestValue = {
      ...this.resyncRequestValue,
      nextExpected: this.nextExpected,
      missing,
      lowestAvailable: this.floorObserved,
      upperBound: this.upperObserved,
      buffered: this.bufferedAboveFloor(),
    };
  }

  /**
   * Unrecoverable missing sequences: from `nextExpected` up to the repair floor,
   * excluding anything already buffered from a later window position. Anything
   * at or above the floor is still repairable, so it is not part of the gap the
   * caller must accept losing.
   */
  private missingBelowWindow(): Range[] {
    const top = this.floorObserved - 1;
    if (top < this.nextExpected) return [];
    return normalizeRanges(missingWithin(this.bufferRanges(), this.nextExpected, top));
  }

  private setTimer(at: number): void {
    if (this.timer !== null) {
      this.options.clock.clearTimeout(this.timer);
    }
    const delay = Math.max(1, at - this.options.clock.now());
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      this.evaluate();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.options.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MulticastReceiver: ${name} must be a positive integer`);
  }
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`MulticastReceiver: ${name} must be >= 0`);
  }
  return value;
}

interface PeerNackLike {
  at: number;
  ranges: readonly Range[];
}

/**
 * Split a missing range into segments that are each either fully covered by a
 * live peer NACK (at that peer NACK's expiry time) or fully free of peer
 * coverage. Overlapping peer requests resolve to the latest expiry.
 */
function splitBySuppression(
  range: Range,
  peerNacks: readonly PeerNackLike[],
  now: number,
  windowMs: number,
): { range: Range; suppressedUntil: number }[] {
  const live: { start: number; end: number; until: number }[] = [];
  for (const record of peerNacks) {
    const until = record.at + windowMs;
    if (until <= now) continue;
    for (const peerRange of record.ranges) {
      const start = Math.max(peerRange.start, range.start);
      const end = Math.min(peerRange.end, range.end);
      if (start <= end) live.push({ start, end, until });
    }
  }
  if (live.length === 0) return [{ range, suppressedUntil: 0 }];
  live.sort((a, b) => a.start - b.start || a.until - b.until);

  const segments: { range: Range; suppressedUntil: number }[] = [];
  let cursor = range.start;
  for (const piece of live) {
    if (piece.end < cursor) continue;
    if (piece.start > cursor) {
      segments.push({
        range: { start: cursor, end: Math.min(piece.start - 1, range.end) },
        suppressedUntil: 0,
      });
    }
    const start = Math.max(cursor, piece.start);
    if (start > range.end) break;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.suppressedUntil > 0 && last.range.end + 1 === start) {
      last.range = { start: last.range.start, end: Math.min(piece.end, range.end) };
      last.suppressedUntil = Math.max(last.suppressedUntil, piece.until);
    } else {
      segments.push({
        range: { start, end: Math.min(piece.end, range.end) },
        suppressedUntil: piece.until,
      });
    }
    cursor = piece.end + 1;
    if (cursor > range.end) break;
  }
  if (cursor <= range.end) {
    segments.push({ range: { start: cursor, end: range.end }, suppressedUntil: 0 });
  }
  return segments;
}
