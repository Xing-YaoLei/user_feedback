import { mergeUpdate, compareEntries, sameIdentity } from './membership.ts';
import type {
  AuditEntry,
  Clock,
  DigestEntry,
  HelperWait,
  MemberUpdate,
  Message,
  NodeConfig,
  NodeIdentity,
  OutstandingProbe,
  Selectors,
  Transport,
} from './types.ts';
import { TERMINAL_STATES } from './types.ts';

interface PendingItem {
  update: MemberUpdate;
  queuedAt: number;
}

/** Deterministic default selectors (smallest-id order), overridable in tests. */
export const defaultSelectors: Selectors = {
  pickTarget: (candidates) => candidates[0],
  pickHelpers: (candidates, targetId, n) =>
    candidates.filter((c) => c !== targetId).slice(0, n),
  pickDigestPeer: (candidates) => candidates[0],
};

/**
 * Round-robin selectors. Every node gets its own cursor so probe targets and
 * digest peers rotate deterministically; helpers rotate around the target.
 */
export function createRoundRobinSelectors(): Selectors {
  let targetCursor = 0;
  let digestCursor = 0;
  let helperCursor = 0;
  return {
    pickTarget: (candidates) => {
      if (candidates.length === 0) return undefined;
      const pick = candidates[targetCursor % candidates.length]!;
      targetCursor++;
      return pick;
    },
    pickHelpers: (candidates, targetId, n) => {
      const pool = candidates.filter((c) => c !== targetId);
      const count = Math.min(n, pool.length);
      const picked: string[] = [];
      for (let i = 0; i < count; i++) {
        picked.push(pool[(helperCursor + i) % pool.length]!);
      }
      if (pool.length > 0) helperCursor++;
      return picked;
    },
    pickDigestPeer: (candidates) => {
      if (candidates.length === 0) return undefined;
      const pick = candidates[digestCursor % candidates.length]!;
      digestCursor++;
      return pick;
    },
  };
}

/**
 * A single membership-protocol node.
 *
 * Lifecycle of a probe round:
 *   ping -> (direct timeout) -> indirect-ping via k helpers
 *        -> valid ack (direct or relayed): success
 *        -> indirect timeout with no valid ack: bounded suspicion
 *        -> suspect deadline with no higher-seq refutation: dead
 *
 * All external side effects go through the injected Clock and Transport, so a
 * whole cluster can be driven deterministically with virtual time.
 */
export class MembershipNode {
  readonly id: string;
  private incarnation: number;
  private seq = 0;
  private readonly config: NodeConfig;
  private readonly clock: Clock;
  private readonly transport: Transport;

  /** Member view keyed by stable id. Includes this node's own record. */
  private view = new Map<string, MemberUpdate>();
  /** Bounded gossip forward queue, one newest entry per member id. */
  private pending: PendingItem[] = [];
  private outstanding: OutstandingProbe | undefined;
  private helperWaits = new Map<string, HelperWait>();
  private suspectTimers = new Map<string, () => void>();
  /** Local (receive) time at which each active suspicion was first armed. */
  private suspectArmedAt = new Map<string, number>();
  private timers: { fired: boolean; cancel: () => void }[] = [];
  private auditLog: AuditEntry[] = [];
  private roundCounter = 0;
  private digestCounter = 0;
  private stopped = false;
  private left = false;

  constructor(config: NodeConfig, clock: Clock, transport: Transport, initialIncarnation = 1) {
    this.config = config;
    this.clock = clock;
    this.transport = transport;
    this.id = config.id;
    this.incarnation = initialIncarnation;
    const self: MemberUpdate = {
      id: this.id,
      incarnation: this.incarnation,
      seq: this.seq,
      state: 'alive',
    };
    this.view.set(this.id, self);
    this.enqueuePending(self);
    transport.register(this.id, (msg) => this.handleMessage(msg));
    this.scheduleProbe();
    this.scheduleDigestSync();
  }

  // ---------------------------------------------------------------------------
  // Public inspection / lifecycle
  // ---------------------------------------------------------------------------

  selfIdentity(): NodeIdentity {
    return { id: this.id, incarnation: this.incarnation, seq: this.seq };
  }

  /** Snapshot of the current member view. */
  getView(): Map<string, MemberUpdate> {
    return new Map(this.view);
  }

  getEntry(memberId: string): MemberUpdate | undefined {
    const entry = this.view.get(memberId);
    return entry ? { ...entry } : undefined;
  }

  getAuditLog(): readonly AuditEntry[] {
    return this.auditLog;
  }

  getPendingQueue(): readonly MemberUpdate[] {
    return this.pending.map((p) => ({ ...p.update }));
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** Voluntary leave: propagates a terminal `left` update and stops probing. */
  leave(): void {
    if (this.stopped) return;
    const update: MemberUpdate = {
      id: this.id,
      incarnation: this.incarnation,
      seq: this.seq,
      state: 'left',
    };
    this.applyLocalUpdate(update, 'self-leave');
    this.left = true;
    this.cancelProbeTimers();
    this.outstanding = undefined;
    // Give the leave update one immediate gossip chance to every reachable peer.
    for (const peerId of this.gossipCandidates()) {
      this.sendGapSync(peerId, 0);
    }
    this.audit('leave', { incarnation: this.incarnation, seq: this.seq });
  }

  /**
   * Rejoin after a confirmed death (or any restart). A strictly greater
   * incarnation overrides the old terminal identity cluster-wide; older
   * gossip and late acks for the old incarnation can never override it.
   */
  restart(newIncarnation?: number): void {
    const next = newIncarnation ?? this.incarnation + 1;
    if (next <= this.incarnation) {
      throw new Error(`restart incarnation must exceed ${this.incarnation}`);
    }
    this.incarnation = next;
    this.seq = 0;
    this.left = false;
    this.stopped = false;
    this.cancelProbeTimers();
    this.outstanding = undefined;
    for (const wait of this.helperWaits.values()) wait.cancelTimer();
    this.helperWaits.clear();
    this.disarmSuspectTimer(this.id);
    this.suspectArmedAt.delete(this.id);
    // A restart begins a fresh identity: drop all stale gossip from the old
    // incarnation so the new self-update is forwarded first.
    this.pending = [];
    const self: MemberUpdate = {
      id: this.id,
      incarnation: this.incarnation,
      seq: 0,
      state: 'alive',
    };
    // Directly replace the local self record (including any old dead/left
    // identity); peers keep the old incarnation until the new update gossips.
    this.view.set(this.id, { ...self });
    this.enqueuePending(self);
    this.scheduleProbe();
    this.scheduleDigestSync();
    this.audit('restart', { incarnation: this.incarnation });
  }

  /** Permanent shutdown: cancel every timer and detach from the transport. */
  close(): void {
    this.stopped = true;
    this.cancelProbeTimers();
    for (const t of this.timers) t.cancel();
    this.timers = [];
    for (const cancel of this.suspectTimers.values()) cancel();
    this.suspectTimers.clear();
    this.suspectArmedAt.clear();
    for (const wait of this.helperWaits.values()) wait.cancelTimer();
    this.helperWaits.clear();
    this.transport.unregister(this.id);
  }

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  private setTimer(delayMs: number, fn: () => void): () => void {
    const entry: { fired: boolean; cancel: () => void } = { fired: false, cancel: () => {} };
    entry.cancel = this.clock.setTimer(delayMs, () => {
      entry.fired = true;
      fn();
    });
    this.timers.push(entry);
    // Prune already-fired entries so the list stays bounded over long runs.
    if (this.timers.length > 256) {
      this.timers = this.timers.filter((t) => !t.fired).slice(-128);
    }
    return () => entry.cancel();
  }

  private scheduleProbe(): void {
    if (this.stopped || this.left) return;
    this.setTimer(this.config.probeInterval, () => this.runProbeRound());
  }

  private scheduleDigestSync(): void {
    if (this.stopped || this.left) return;
    this.setTimer(this.config.digestInterval, () => {
      this.runDigestSync();
      this.scheduleDigestSync();
    });
  }

  private cancelProbeTimers(): void {
    // Outstanding timeouts are self-validating; we also drop the bookkeeping.
    this.outstanding = undefined;
  }

  // ---------------------------------------------------------------------------
  // View updates, gossip queue, refutation
  // ---------------------------------------------------------------------------

  private enqueuePending(update: MemberUpdate): void {
    const existingIdx = this.pending.findIndex((p) => p.update.id === update.id);
    if (existingIdx >= 0) {
      // Replace in place with the newest version of this member's update.
      // Preserving the queue position means repeated gossip of the same
      // suspicion cannot buy it a longer forwarding lifetime.
      this.pending[existingIdx] = {
        update: { ...update },
        queuedAt: this.pending[existingIdx]!.queuedAt,
      };
    } else {
      if (this.pending.length >= this.config.maxPendingQueue) {
        // Bounded queue: evict the oldest queued update.
        const evicted = this.pending.shift();
        this.audit('pending-evict', { evictedId: evicted?.update.id });
      }
      this.pending.push({ update: { ...update }, queuedAt: this.clock.now() });
    }
  }

  /** Take up to maxPiggyback updates for one outbound message. */
  private takePiggyback(): MemberUpdate[] {
    const n = Math.min(this.config.maxPiggyback, this.pending.length);
    const taken = this.pending.splice(0, n).map((p) => ({ ...p.update }));
    return taken;
  }

  private currentDigest(): DigestEntry[] {
    return [...this.view.values()].map((u) => ({ ...u }));
  }

  /**
   * Apply one update originating from this node (leave, self-suspect etc.).
   * Local-origin updates always carry this node's current view of itself.
   */
  private applyLocalUpdate(update: MemberUpdate, event: string): void {
    const decision = mergeUpdate(this.view, update);
    if (decision.accepted) {
      this.enqueuePending(update);
      this.afterAcceptedUpdate(update, decision.reason, 'local', event);
    }
  }

  /**
   * Apply a batch of gossip/piggybacked updates from a message.
   * Returns the accepted updates, in input order.
   */
  private applyIncomingUpdates(updates: readonly MemberUpdate[], source: string): MemberUpdate[] {
    const accepted: MemberUpdate[] = [];
    for (const raw of updates) {
      const update: MemberUpdate = { ...raw };
      const decision = mergeUpdate(this.view, update);
      if (decision.accepted) {
        this.enqueuePending(update);
        this.afterAcceptedUpdate(update, decision.reason, source);
        accepted.push(update);
      } else if (decision.reason === 'duplicate-noop' && update.state === 'suspected') {
        this.audit('duplicate-suspect-ignored', {
          member: update.id,
          incarnation: update.incarnation,
          seq: update.seq,
          source,
        });
      }
    }
    return accepted;
  }

  /**
   * Reconciliation after an accepted update: refutation, suspect timers,
   * probe cancellation. All decisions are recorded in the audit trail.
   */
  private afterAcceptedUpdate(
    update: MemberUpdate,
    reason: string,
    source: string,
    eventOverride?: string,
  ): void {
    const isSelf = update.id === this.id;

    if (update.state === 'suspected') {
      if (isSelf && update.incarnation === this.incarnation) {
        // A live node receives a suspicion for its CURRENT identity: refute
        // by bumping the alive-declaration sequence number.
        if (update.seq >= this.seq) {
          this.refute(update, source);
          return;
        }
      }
      this.armSuspectTimer(update);
      this.audit(eventOverride ?? 'suspect-accepted', {
        member: update.id,
        incarnation: update.incarnation,
        seq: update.seq,
        deadline: update.suspectDeadline,
        reason,
        source,
      });
      this.cancelProbeIfSatisfied(update.id);
      return;
    }

    if (update.state === 'alive') {
      if (isSelf) {
        // Adopt a higher seq for our own identity only if it matches our
        // incarnation; we never let external data rewrite incarnation/seq bookkeeping.
        if (update.incarnation === this.incarnation && update.seq > this.seq) {
          this.seq = update.seq;
        }
      }
      this.disarmSuspectTimer(update.id);
      this.audit(eventOverride ?? 'alive-accepted', {
        member: update.id,
        incarnation: update.incarnation,
        seq: update.seq,
        reason,
        source,
      });
      return;
    }

    if (update.state === 'dead' || update.state === 'left') {
      this.disarmSuspectTimer(update.id);
      this.cancelProbeIfSatisfied(update.id);
      this.audit(eventOverride ?? `${update.state}-accepted`, {
        member: update.id,
        incarnation: update.incarnation,
        seq: update.seq,
        reason,
        source,
      });
    }
  }

  /** Bump the alive seq and emit a refutation alive update. */
  private refute(suspicion: MemberUpdate, source: string): void {
    this.seq = Math.max(this.seq, suspicion.seq) + 1;
    const refutation: MemberUpdate = {
      id: this.id,
      incarnation: this.incarnation,
      seq: this.seq,
      state: 'alive',
    };
    const decision = mergeUpdate(this.view, refutation);
    if (decision.accepted) this.enqueuePending(refutation);
    this.disarmSuspectTimer(this.id);
    this.audit('refutation', {
      againstSeq: suspicion.seq,
      newSeq: this.seq,
      incarnation: this.incarnation,
      source,
    });
  }

  private armSuspectTimer(update: MemberUpdate): void {
    if (this.suspectTimers.has(update.id)) return;
    // Every node applies the same bounded window locally. An explicit deadline
    // from gossip is honored when still in the future; otherwise we start the
    // window now. Duplicate suspicions never reach here (mergeUpdate rejects
    // them as no-ops), so gossip cannot extend the window.
    const now = this.clock.now();
    const deadline =
      typeof update.suspectDeadline === 'number' && update.suspectDeadline > now
        ? update.suspectDeadline
        : now + this.config.suspectTimeout;
    const stored = this.view.get(update.id);
    if (stored && stored.state === 'suspected') {
      stored.suspectDeadline = deadline;
    }
    this.suspectArmedAt.set(update.id, now);
    const delay = Math.max(0, deadline - now);
    const cancel = this.setTimer(delay, () => this.onSuspectDeadline(update.id));
    this.suspectTimers.set(update.id, cancel);
  }

  private disarmSuspectTimer(memberId: string): void {
    const cancel = this.suspectTimers.get(memberId);
    if (cancel) {
      cancel();
      this.suspectTimers.delete(memberId);
      this.suspectArmedAt.delete(memberId);
    }
  }

  private onSuspectDeadline(memberId: string): void {
    this.suspectTimers.delete(memberId);
    const armedAt = this.suspectArmedAt.get(memberId);
    this.suspectArmedAt.delete(memberId);
    const current = this.view.get(memberId);
    if (!current || current.state !== 'suspected') return;
    // No higher-seq alive refutation arrived within the bounded window.
    const dead: MemberUpdate = {
      id: memberId,
      incarnation: current.incarnation,
      seq: current.seq,
      state: 'dead',
    };
    const decision = mergeUpdate(this.view, dead);
    if (decision.accepted) {
      this.enqueuePending(dead);
      this.cancelProbeIfSatisfied(memberId);
      this.audit('death-confirmed', {
        member: memberId,
        incarnation: current.incarnation,
        seq: current.seq,
        suspectedAt: armedAt,
        deadline: current.suspectDeadline,
      });
    }
  }

  /** If a probe is running toward a member whose state is now terminal/suspected
   *  by another route, stop waiting on it. */
  private cancelProbeIfSatisfied(memberId: string): void {
    if (this.outstanding && this.outstanding.targetId === memberId) {
      const entry = this.view.get(memberId);
      if (entry && (TERMINAL_STATES.has(entry.state) || entry.state === 'suspected')) {
        this.outstanding = undefined;
      }
    }
  }

  private audit(event: string, detail: Record<string, unknown>): void {
    this.auditLog.push({ at: this.clock.now(), nodeId: this.id, event, detail });
  }

  // ---------------------------------------------------------------------------
  // Candidate selection
  // ---------------------------------------------------------------------------

  /**
   * Non-terminal peers known to the local view, plus bootstrap peers that are
   * not yet known (or not yet confirmed dead/left). A confirmed terminal
   * identity is never probed again; its possible higher-incarnation restart is
   * discovered through digest exchange instead.
   */
  private probeCandidates(): string[] {
    const ids = new Set<string>();
    for (const [memberId, entry] of this.view) {
      if (memberId === this.id) continue;
      if (!TERMINAL_STATES.has(entry.state)) ids.add(memberId);
    }
    for (const peer of this.config.bootstrapPeers ?? []) {
      if (peer === this.id) continue;
      const known = this.view.get(peer);
      if (!known || !TERMINAL_STATES.has(known.state)) ids.add(peer);
    }
    return [...ids].sort();
  }

  /**
   * Peers eligible for digest exchange and gossip.
   *
   * `dead`/`left` peers stay eligible: a node that this node believes dead may
   * have restarted with a higher incarnation, and periodic digest exchange is
   * precisely the channel that learns the override. Direct probe targeting
   * uses the narrower `probeCandidates` set.
   */
  private gossipCandidates(): string[] {
    const ids = new Set<string>();
    for (const memberId of this.view.keys()) {
      if (memberId !== this.id) ids.add(memberId);
    }
    for (const peer of this.config.bootstrapPeers ?? []) {
      if (peer !== this.id) ids.add(peer);
    }
    return [...ids].sort();
  }

  // ---------------------------------------------------------------------------
  // Probe rounds
  // ---------------------------------------------------------------------------

  private runProbeRound(): void {
    if (this.stopped || this.left) return;
    const candidates = this.probeCandidates();
    const targetId = this.config.selectors.pickTarget(candidates, this.id);
    if (!targetId) {
      this.scheduleProbe();
      return;
    }
    const targetEntry = this.view.get(targetId);
    const identity: NodeIdentity = targetEntry
      ? { id: targetId, incarnation: targetEntry.incarnation, seq: targetEntry.seq }
      : { id: targetId, incarnation: 0, seq: 0 };

    this.roundCounter++;
    const round = this.roundCounter;
    this.outstanding = {
      targetId,
      round,
      incarnation: identity.incarnation,
      seq: identity.seq,
      phase: 'direct',
      helpers: [],
    };
    this.sendPing(targetId, round, identity);
    this.setTimer(this.config.directTimeout, () => this.onDirectTimeout(round));
    this.audit('probe-direct-start', { target: targetId, round, ...identity });
    this.scheduleProbe();
  }

  private sendPing(targetId: string, round: number, identity: NodeIdentity): void {
    const msg: Message = {
      kind: 'ping',
      from: this.id,
      target: targetId,
      round,
      incarnation: identity.incarnation,
      seq: identity.seq,
      updates: this.takePiggyback(),
      digest: this.currentDigest(),
    };
    this.transport.send(msg, targetId);
  }

  private onDirectTimeout(round: number): void {
    const probe = this.outstanding;
    if (!probe || probe.round !== round || probe.phase !== 'direct') return;
    const entry = this.view.get(probe.targetId);
    if (entry && TERMINAL_STATES.has(entry.state)) {
      this.outstanding = undefined;
      return;
    }
    probe.phase = 'indirect';
    this.startIndirectPhase(probe);
  }

  private startIndirectPhase(probe: OutstandingProbe): void {
    const candidates = this.probeCandidates().filter((c) => c !== probe.targetId);
    const helpers = this.config.selectors.pickHelpers(
      candidates,
      probe.targetId,
      this.config.indirectHelpers,
    );
    probe.helpers = helpers;
    probe.indirectTimeoutAt = this.clock.now() + this.config.indirectTimeout;
    const identity: NodeIdentity = {
      id: probe.targetId,
      incarnation: probe.incarnation,
      seq: probe.seq,
    };
    helpers.forEach((helperId, idx) => {
      const subRound = idx + 1;
      const msg: Message = {
        kind: 'indirect-ping',
        from: this.id,
        helper: helperId,
        target: probe.targetId,
        round: probe.round,
        incarnation: probe.incarnation,
        seq: probe.seq,
        subRound,
        updates: this.takePiggyback(),
        digest: this.currentDigest(),
      };
      this.transport.send(msg, helperId);
    });
    this.setTimer(this.config.indirectTimeout, () => this.onIndirectTimeout(probe.round));
    this.audit('probe-indirect-start', {
      target: probe.targetId,
      round: probe.round,
      helpers,
      ...identity,
    });
  }

  private onIndirectTimeout(round: number): void {
    const probe = this.outstanding;
    if (!probe || probe.round !== round || probe.phase !== 'indirect') return;
    const targetId = probe.targetId;
    const entry = this.view.get(targetId);
    if (entry && TERMINAL_STATES.has(entry.state)) {
      this.outstanding = undefined;
      return;
    }
    this.outstanding = undefined;
    // No valid ack within direct + indirect windows: enter bounded suspicion.
    const suspicion: MemberUpdate = {
      id: targetId,
      incarnation: probe.incarnation,
      seq: probe.seq,
      state: 'suspected',
      suspectDeadline: this.clock.now() + this.config.suspectTimeout,
    };
    const decision = mergeUpdate(this.view, suspicion);
    if (decision.accepted) {
      this.enqueuePending(suspicion);
      this.afterAcceptedUpdate(suspicion, decision.reason, 'local', 'suspicion-raised');
    }
  }

  /**
   * Validate an ack that claims to answer one of our probe rounds.
   * The ack is bound to the concrete probe round and the target stable id.
   * Its identity must be the probed identity or a strictly newer identity of
   * the same id; a late ack carrying an older incarnation/seq is rejected.
   */
  private isValidProbeAck(
    ack: { round: number; target: string; incarnation: number; seq: number },
  ): boolean {
    const probe = this.outstanding;
    if (!probe || probe.round !== ack.round || probe.targetId !== ack.target) return false;
    const claimed: NodeIdentity = {
      id: ack.target,
      incarnation: ack.incarnation,
      seq: ack.seq,
    };
    const probedIdentity: NodeIdentity = {
      id: probe.targetId,
      incarnation: probe.incarnation,
      seq: probe.seq,
    };
    if (sameIdentity(claimed, probedIdentity)) return true;
    const local = this.view.get(ack.target);
    if (local) {
      // A newer incarnation (e.g. a restart not yet learned locally) is valid.
      if (claimed.incarnation > local.incarnation) return true;
      if (claimed.incarnation < local.incarnation) return false;
      // Same incarnation: the ack must be at least as fresh as both the local
      // record and the snapshot this probe was started with. Late acks for an
      // older seq, like stale gossip, cannot roll the identity backwards.
      return claimed.seq >= Math.max(local.seq, probe.seq);
    }
    // Not yet known locally: accept anything at least as new as the snapshot
    // the probe was started with (typically the bootstrap incarnation 0).
    return claimed.incarnation > probe.incarnation ||
      (claimed.incarnation === probe.incarnation && claimed.seq >= probe.seq);
  }

  private completeProbe(targetId: string, round: number, via: string): void {
    if (this.outstanding && this.outstanding.round === round) {
      this.outstanding = undefined;
      this.audit('probe-success', { target: targetId, round, via });
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: Message): void {
    if (this.stopped) return;
    // Piggybacked updates are applied first so a refutation can ride an ack.
    this.applyIncomingUpdates(msg.updates, msg.from);
    // Digest anti-entropy runs on every message in the cheap direction:
    // learn any member the sender knows that we are missing or behind on.
    this.scanDigest(msg.digest, msg.from);

    switch (msg.kind) {
      case 'ping':
        this.handlePing(msg);
        break;
      case 'ack':
        this.handleAck(msg);
        break;
      case 'indirect-ping':
        this.handleIndirectPing(msg);
        break;
      case 'indirect-ack':
        this.handleIndirectAck(msg);
        break;
      case 'digest-sync':
        // Updates already applied; full-gap reply repairs anything still missing.
        this.replyWithFullGaps(msg.from, msg.digest);
        break;
    }
  }

  private handlePing(msg: Extract<Message, { kind: 'ping' }>): void {
    // Only the named target answers; this also binds the ack to the round and
    // the target's CURRENT identity.
    if (msg.target !== this.id) return;
    const self = this.view.get(this.id);

    // A helper relayed this ping: remember the correlation so its ack can be
    // converted into an indirect-ack toward the original initiator. Keyed by
    // target#round because the ack arrives from the target itself.
    if (typeof msg.subRound === 'number') {
      const key = `${msg.target}#${msg.round}`;
      const existing = this.helperWaits.get(key);
      if (existing) existing.subRound = msg.subRound;
    }

    const ack: Message = {
      kind: 'ack',
      from: this.id,
      target: this.id,
      round: msg.round,
      incarnation: self ? self.incarnation : this.incarnation,
      seq: self ? self.seq : this.seq,
      updates: this.takePiggyback(),
      digest: this.currentDigest(),
    };
    this.transport.send(ack, msg.from);
  }

  private handleAck(msg: Extract<Message, { kind: 'ack' }>): void {
    // Helper path: we relayed a ping for someone else and the target answered.
    const helperKey = `${msg.target}#${msg.round}`;
    const wait = this.helperWaits.get(helperKey);
    if (wait && wait.targetId === msg.target) {
      this.helperWaits.delete(helperKey);
      wait.cancelTimer();
      const reply: Message = {
        kind: 'indirect-ack',
        from: this.id,
        helper: this.id,
        target: msg.target,
        round: msg.round,
        incarnation: msg.incarnation,
        seq: msg.seq,
        subRound: wait.subRound,
        success: true,
        updates: this.takePiggyback(),
        digest: this.currentDigest(),
      };
      this.transport.send(reply, wait.initiatorId);
      return;
    }

    // Initiator path: direct ack to our own probe round.
    if (!this.isValidProbeAck(msg)) {
      this.audit('stale-ack-ignored', {
        from: msg.from,
        round: msg.round,
        incarnation: msg.incarnation,
        seq: msg.seq,
      });
      return;
    }
    // Adopt the responder's current alive identity if it is newer to us.
    const alive: MemberUpdate = {
      id: msg.target,
      incarnation: msg.incarnation,
      seq: msg.seq,
      state: 'alive',
    };
    const decision = mergeUpdate(this.view, alive);
    if (decision.accepted) {
      this.enqueuePending(alive);
      this.afterAcceptedUpdate(alive, decision.reason, msg.from, 'probe-ack-alive');
    }
    this.completeProbe(msg.target, msg.round, 'direct');
  }

  private handleIndirectPing(msg: Extract<Message, { kind: 'indirect-ping' }>): void {
    if (msg.helper !== this.id) return;
    const key = `${msg.target}#${msg.round}`;

    const ping: Message = {
      kind: 'ping',
      from: this.id,
      target: msg.target,
      round: msg.round,
      incarnation: msg.incarnation,
      seq: msg.seq,
      subRound: msg.subRound,
      updates: this.takePiggyback(),
      digest: this.currentDigest(),
    };
    this.transport.send(ping, msg.target);

    // Failure timer: if the target never answers, report an unsuccessful relay.
    const cancelTimer = this.setTimer(this.config.indirectTimeout, () => {
      if (!this.helperWaits.has(key)) return;
      this.helperWaits.delete(key);
      this.sendIndirectAck(msg, false);
    });
    const wait: HelperWait = {
      initiatorId: msg.from,
      targetId: msg.target,
      round: msg.round,
      incarnation: msg.incarnation,
      seq: msg.seq,
      subRound: msg.subRound,
      timeoutAt: this.clock.now() + this.config.indirectTimeout,
      cancelTimer,
    };
    this.helperWaits.set(key, wait);
  }

  private sendIndirectAck(
    original: Extract<Message, { kind: 'indirect-ping' }>,
    success: boolean,
  ): void {
    const reply: Message = {
      kind: 'indirect-ack',
      from: this.id,
      helper: this.id,
      target: original.target,
      round: original.round,
      incarnation: original.incarnation,
      seq: original.seq,
      subRound: original.subRound,
      success,
      updates: this.takePiggyback(),
      digest: this.currentDigest(),
    };
    this.transport.send(reply, original.from);
  }

  private handleIndirectAck(msg: Extract<Message, { kind: 'indirect-ack' }>): void {
    if (!this.isValidProbeAck(msg)) {
      this.audit('stale-indirect-ack-ignored', {
        helper: msg.helper,
        round: msg.round,
        success: msg.success,
      });
      return;
    }
    if (!msg.success) {
      this.audit('indirect-probe-failed', { helper: msg.helper, round: msg.round });
      return;
    }
    // A helper confirmed the target answered: the target's current identity
    // rides the ack header; adopt it when newer.
    const alive: MemberUpdate = {
      id: msg.target,
      incarnation: msg.incarnation,
      seq: msg.seq,
      state: 'alive',
    };
    const decision = mergeUpdate(this.view, alive);
    if (decision.accepted) {
      this.enqueuePending(alive);
      this.afterAcceptedUpdate(alive, decision.reason, msg.helper, 'indirect-ack-alive');
    }
    this.completeProbe(msg.target, msg.round, `indirect:${msg.helper}`);
  }

  // ---------------------------------------------------------------------------
  // Digest anti-entropy
  // ---------------------------------------------------------------------------

  /**
   * One-directional digest scan: for every sender entry that is missing
   * locally or strictly stronger than the local record, ingest it as a full
   * update. Periodic digest exchange therefore repairs any gossip update that
   * piggyback limits or queue eviction caused us to miss.
   */
  private scanDigest(digest: readonly DigestEntry[], source: string): number {
    let ingested = 0;
    for (const entry of digest) {
      const local = this.view.get(entry.id);
      if (!local || compareEntries(entry, local) > 0) {
        const update: MemberUpdate = { ...entry };
        const decision = mergeUpdate(this.view, update);
        if (decision.accepted) {
          this.enqueuePending(update);
          this.afterAcceptedUpdate(update, decision.reason, `${source}:digest`);
          ingested++;
        }
      }
    }
    return ingested;
  }

  private runDigestSync(): void {
    if (this.stopped || this.left) return;
    const candidates = this.gossipCandidates();
    const peerId = this.config.selectors.pickDigestPeer(candidates, this.id);
    if (!peerId) return;
    this.digestCounter++;
    this.sendGapSync(peerId, this.digestCounter);
  }

  private sendGapSync(peerId: string, syncRound: number): void {
    const msg: Extract<Message, { kind: 'digest-sync' }> = {
      kind: 'digest-sync',
      from: this.id,
      to: peerId,
      syncRound,
      updates: this.takePiggyback(),
      digest: this.currentDigest(),
    };
    this.transport.send(msg, peerId);
  }

  /** Reply with every local record stronger than the peer's digest version. */
  private replyWithFullGaps(peerId: string, peerDigest: readonly DigestEntry[]): void {
    const peerMap = new Map(peerDigest.map((d) => [d.id, d]));
    const gaps: MemberUpdate[] = [];
    for (const local of this.view.values()) {
      const peerEntry = peerMap.get(local.id);
      if (!peerEntry || compareEntries(local, peerEntry) > 0) {
        gaps.push({ ...local });
      }
    }
    if (gaps.length === 0) return;
    const msg: Extract<Message, { kind: 'digest-sync' }> = {
      kind: 'digest-sync',
      from: this.id,
      to: peerId,
      syncRound: 0,
      updates: gaps.slice(0, this.config.maxPiggyback),
      digest: this.currentDigest(),
    };
    this.transport.send(msg, peerId);
    // Remaining gaps ride the next periodic exchange (digest keeps requesting).
  }
}
