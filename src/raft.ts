/**
 * Raft coordinated state machine (single node).
 *
 * Implements:
 *   - leader election with persisted term/vote (Raft §5.2)
 *   - log replication with the log-matching property (§5.3)
 *   - node restart from a per-node durable directory
 *   - linearizable reads via the ReadIndex/quorum-confirmation protocol (§6.4)
 *   - online membership replacement with joint consensus C_old,new (§6)
 *
 * All time and message delivery come from the injected Scheduler/Network,
 * making every run deterministic and reproducible from a seed.
 */

import type { Network } from './network.ts';
import type { PersistentStore } from './persistence.ts';
import type { Scheduler, TimerHandle } from './scheduler.ts';
import {
  quorumSize,
  RaftError,
  sameVoters,
} from './types.ts';
import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  Command,
  LogEntry,
  NodeId,
  RaftConfig,
  RaftMessage,
  RequestVoteRequest,
  RequestVoteResponse,
  Role,
  StateMachine,
} from './types.ts';

export interface RaftNodeOptions {
  heartbeatMs?: number;
  electionMinMs?: number;
  electionMaxMs?: number;
  /** Default deadline for client operations, in virtual milliseconds. */
  clientTimeoutMs?: number;
}

export interface ChangeConfigOptions {
  timeoutMs?: number;
  /**
   * Invoked exactly once, synchronously, when the joint configuration
   * C_old,new has been committed (under both majorities) but before the final
   * C_new entry is appended. This is the only point at which a fault may be
   * injected while the joint phase is provably active.
   */
  onJointCommitted?: (joint: RaftConfig) => void;
}

interface PendingWrite {
  index: number;
  resolve: (entry: LogEntry) => void;
  reject: (err: Error) => void;
  timer: TimerHandle;
}

interface ReadWaiter {
  term: number;
  round: number;
  barrierIndex: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: TimerHandle;
}

interface ConfigWaiter {
  index: number;
  resolve: (config: RaftConfig) => void;
  reject: (err: Error) => void;
  timer: TimerHandle;
}

export class RaftNode<S> {
  readonly id: NodeId;
  private readonly sm: StateMachine<S>;
  private readonly scheduler: Scheduler;
  private readonly network: Network;
  private readonly store: PersistentStore<S>;
  private readonly opts: Required<RaftNodeOptions>;

  private role: Role = 'follower';
  private currentTerm = 0;
  private votedFor: NodeId | null = null;
  private log: LogEntry[] = [];
  private config: RaftConfig;

  // Volatile state (Raft §5.1).
  private commitIndex = 0;
  private lastApplied = 0;
  private appliedState: S;

  // Leader-only volatile state.
  private nextIndex = new Map<NodeId, number>();
  private matchIndex = new Map<NodeId, number>();
  private votes = new Set<NodeId>();
  // ReadIndex confirmation: every read opens a fresh round, so acknowledgements
  // collected before that read cannot satisfy it.
  private barrierRound = 0;
  private barrierAcksByRound = new Map<number, Set<NodeId>>();

  // Client-facing pending operations.
  private pendingWrites = new Map<number, PendingWrite>();
  private readWaiters: ReadWaiter[] = [];
  private configWaiters = new Map<number, ConfigWaiter>();

  private electionTimer: TimerHandle | undefined;
  private heartbeatTimer: TimerHandle | undefined;
  private stopped = false;

  constructor(
    id: NodeId,
    stateMachine: StateMachine<S>,
    scheduler: Scheduler,
    network: Network,
    store: PersistentStore<S>,
    bootstrapConfig: RaftConfig,
    options: RaftNodeOptions = {},
  ) {
    this.id = id;
    this.sm = stateMachine;
    this.scheduler = scheduler;
    this.network = network;
    this.store = store;
    this.opts = {
      heartbeatMs: options.heartbeatMs ?? 50,
      electionMinMs: options.electionMinMs ?? 150,
      electionMaxMs: options.electionMaxMs ?? 300,
      clientTimeoutMs: options.clientTimeoutMs ?? 2000,
    };

    // Reload durable state.
    this.currentTerm = store.currentTerm;
    this.votedFor = store.votedFor;
    this.log = [...store.getLog()];

    const snap = store.loadSnapshot();
    this.commitIndex = snap.commitIndex;
    this.lastApplied = snap.lastApplied;
    this.appliedState = snap.appliedState;

    // Replay any committed entries not covered by the durable snapshot.
    for (const entry of this.log) {
      if (entry.index > this.lastApplied && entry.index <= this.commitIndex) {
        this.applyEntry(entry);
      }
    }

    this.config = this.latestConfigAt(this.log.length - 1) ?? bootstrapConfig;
  }

  /* ============================================================== */
  /* Lifecycle                                                      */
  /* ============================================================== */

  start(): void {
    this.network.register(this.id, (envelope) => this.handle(envelope.message));
    this.resetElectionTimer();
  }

  stop(): void {
    this.stopped = true;
    this.scheduler.cancel(this.electionTimer);
    this.scheduler.cancel(this.heartbeatTimer);
    this.failAllPending(new RaftError('node stopped', 'SHUTDOWN'));
    this.network.unregister(this.id);
  }

  /* ============================================================== */
  /* Inspection (tests and callers)                                 */
  /* ============================================================== */

  getRole(): Role {
    return this.role;
  }

  getTerm(): number {
    return this.currentTerm;
  }

  getCommitIndex(): number {
    return this.commitIndex;
  }

  getLastApplied(): number {
    return this.lastApplied;
  }

  getAppliedState(): S {
    return this.appliedState;
  }

  getConfig(): RaftConfig {
    return this.config;
  }

  getLog(): readonly LogEntry[] {
    return this.log;
  }

  isMemberOf(config: RaftConfig): boolean {
    return config.voters.includes(this.id);
  }

  /* ============================================================== */
  /* Client API                                                     */
  /* ============================================================== */

  /**
   * Drive the injected scheduler until `promise` settles. Client operations
   * only make progress when virtual time advances (message delivery, timers),
   * so the node pumps its own scheduler while awaiting an operation — the
   * caller can simply `await` without knowing about the virtual clock.
   */
  private async pumpUntil<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const guarded = promise.then(
      (v) => {
        settled = true;
        return v;
      },
      (err) => {
        settled = true;
        throw err;
      },
    );
    // Every client operation registers a timeout timer, so while it is
    // pending the scheduler always has at least one event to fire.
    while (!settled) {
      if (this.stopped || !this.scheduler.hasPending()) {
        // Defensive: nothing can settle the operation from here.
        await Promise.race([guarded, Promise.resolve()]);
        if (settled) return guarded;
        throw new RaftError('operation cannot make progress: scheduler idle', 'SHUTDOWN');
      }
      await this.scheduler.advance(10);
    }
    return guarded;
  }

  /** Replicate a command; resolves with the entry once it is committed and applied. */
  write(command: Command, timeoutMs = this.opts.clientTimeoutMs): Promise<LogEntry> {
    if (this.role !== 'leader') {
      return Promise.reject(new RaftError(`node ${this.id} is not leader`, 'NOT_LEADER'));
    }
    const entry: LogEntry = {
      term: this.currentTerm,
      index: this.lastLogIndex() + 1,
      command,
    };
    this.appendLocal(entry);
    this.matchIndex.set(this.id, entry.index);
    this.broadcastAppendEntries();
    const result = new Promise<LogEntry>((resolve, reject) => {
      const timer = this.scheduler.schedule(timeoutMs, () => {
        const pending = this.pendingWrites.get(entry.index);
        if (pending) {
          this.pendingWrites.delete(entry.index);
          reject(new RaftError(`write at index ${entry.index} timed out`, 'TIMEOUT'));
        }
      });
      this.pendingWrites.set(entry.index, { index: entry.index, resolve, reject, timer });
    });
    return this.pumpUntil(result);
  }

  /**
   * Linearizable read.
   *
   * The node must (1) still be leader, (2) confirm leadership in the current
   * term by obtaining quorum acknowledgements, and (3) wait until its applied
   * state covers the commit index observed at confirmation. A self-proclaimed
   * leader that cannot reach a quorum therefore fails the read.
   */
  read(timeoutMs = this.opts.clientTimeoutMs): Promise<S> {
    if (this.role !== 'leader') {
      return Promise.reject(new RaftError(`node ${this.id} is not leader`, 'NOT_LEADER'));
    }
    return this.pumpUntil(this.readInternal(timeoutMs));
  }

  private readInternal(timeoutMs: number): Promise<S> {
    const term = this.currentTerm;
    const round = ++this.barrierRound;
    const barrierIndex = this.commitIndex;
    // A fresh round starts with only the leader's own acknowledgement;
    // acks gathered by previous reads or heartbeats never count for this one.
    this.barrierAcksByRound.set(round, new Set([this.id]));
    return new Promise((resolve, reject) => {
      const timer = this.scheduler.schedule(timeoutMs, () => {
        const pos = this.readWaiters.findIndex((w) => w.round === round);
        if (pos >= 0) {
          const [waiter] = this.readWaiters.splice(pos, 1);
          this.barrierAcksByRound.delete(round);
          waiter.reject(new RaftError('read-index quorum not confirmed in time', 'TIMEOUT'));
        }
      });
      const waiter: ReadWaiter = { term, round, barrierIndex, resolve, reject, timer };
      this.readWaiters.push(waiter);
      // Solicit a quorum acknowledgement for THIS read's round.
      this.broadcastAppendEntries();
    });
  }

  /**
   * One-at-a-time joint-consensus membership change.
   *
   * Phase 1: append C_old,new; it takes effect locally immediately and both
   *          majorities are required for elections and commits.
   * Phase 2: once C_old,new is committed, append C_new and wait for its commit.
   * If this leader is removed by C_new it steps down after the switch.
   */
  changeConfig(
    targetVoters: NodeId[],
    options: ChangeConfigOptions = {},
  ): Promise<RaftConfig> {
    return this.pumpUntil(
      this.changeConfigInternal(
        targetVoters,
        options.timeoutMs ?? this.opts.clientTimeoutMs,
        options.onJointCommitted,
      ),
    );
  }

  private async changeConfigInternal(
    targetVoters: NodeId[],
    timeoutMs: number,
    onJointCommitted?: (joint: RaftConfig) => void,
  ): Promise<RaftConfig> {
    if (this.role !== 'leader') {
      throw new RaftError(`node ${this.id} is not leader`, 'NOT_LEADER');
    }
    const target = [...new Set(targetVoters)].sort();

    // Idempotent retry: a joint transition toward the same target may already
    // be underway (e.g. the client retried after a leader change).
    if (this.config.joint) {
      if (sameVoters(this.config.joint.newVoters, target)) {
        const finalIndex = this.findFinalConfigIndex(target);
        return this.waitForConfig(finalIndex, timeoutMs);
      }
      throw new RaftError('another membership change is in progress', 'CONFIG_BUSY');
    }
    if (sameVoters(this.config.voters, target)) {
      return this.config; // nothing to do
    }

    const oldVoters = [...this.config.voters].sort();
    const jointIndex = this.lastLogIndex() + 1;
    const jointConfig: RaftConfig = {
      id: jointIndex,
      voters: [...new Set([...oldVoters, ...target])].sort(),
      joint: { oldVoters, newVoters: target },
    };
    this.appendLocal({
      term: this.currentTerm,
      index: jointIndex,
      command: { type: '__config__', phase: 'joint' },
      config: jointConfig,
    });
    this.matchIndex.set(this.id, jointIndex);
    this.broadcastAppendEntries();

    await this.waitForIndex(jointIndex, timeoutMs);

    // Joint configuration is now committed under BOTH majorities. Expose this
    // precise phase boundary before the transition to C_new proceeds.
    onJointCommitted?.(jointConfig);

    // Phase 2: transition to the final configuration.
    const newIndex = this.lastLogIndex() + 1;
    const newConfig: RaftConfig = {
      id: newIndex,
      voters: target,
    };
    this.appendLocal({
      term: this.currentTerm,
      index: newIndex,
      command: { type: '__config__', phase: 'final' },
      config: newConfig,
    });
    this.matchIndex.set(this.id, newIndex);
    this.broadcastAppendEntries();

    const committed = await this.waitForConfig(newIndex, timeoutMs);

    if (!committed.voters.includes(this.id)) {
      // The leader has been removed by its own configuration change.
      this.becomeFollower(this.currentTerm);
    }
    return committed;
  }

  /* ============================================================== */
  /* Elections                                                      */
  /* ============================================================== */

  private resetElectionTimer(): void {
    this.scheduler.cancel(this.electionTimer);
    if (!this.isMemberOf(this.config)) return;
    const span = this.opts.electionMaxMs - this.opts.electionMinMs;
    const timeout = this.opts.electionMinMs + this.scheduler.rng.int(0, span);
    this.electionTimer = this.scheduler.schedule(timeout, () => this.startElection());
  }

  private startElection(): void {
    if (this.stopped || !this.isMemberOf(this.config)) return;
    this.role = 'candidate';
    this.currentTerm += 1;
    this.votedFor = this.id;
    this.store.saveVote(this.currentTerm, this.id);
    this.votes = new Set([this.id]);
    this.barrierRound = 0;
    this.barrierAcksByRound.clear();

    const req: RequestVoteRequest = {
      type: 'RequestVote',
      term: this.currentTerm,
      candidateId: this.id,
      lastLogIndex: this.lastLogIndex(),
      lastLogTerm: this.lastLogTerm(),
    };
    // Ask every node in the active configuration (joint union covers both sets).
    for (const peer of this.config.voters) {
      if (peer !== this.id) this.send(peer, req);
    }
    this.resetElectionTimer();
    this.maybeWinElection();
  }

  private maybeWinElection(): void {
    if (this.role !== 'candidate') return;
    const groups = this.config.joint
      ? [this.config.joint.oldVoters, this.config.joint.newVoters]
      : [this.config.voters];
    const won = groups.every(
      (group) =>
        group.filter((v) => this.votes.has(v)).length >= quorumSize(group.length),
    );
    if (won) this.becomeLeader();
  }

  private becomeLeader(): void {
    this.role = 'leader';
    this.scheduler.cancel(this.electionTimer);
    const next = this.lastLogIndex() + 1;
    for (const peer of this.config.voters) {
      if (peer === this.id) continue;
      this.nextIndex.set(peer, next);
      this.matchIndex.set(peer, 0);
    }
    // Read-index rounds start fresh for this leadership term; each read opens
    // its own round and the leader's own acknowledgement is counted there.
    this.barrierRound = 0;
    this.barrierAcksByRound.clear();
    this.votes = new Set();

    // A no-op entry commits entries from previous terms quickly and gives
    // pending reads a fresh commit point in this term.
    const noop: LogEntry = {
      term: this.currentTerm,
      index: this.lastLogIndex() + 1,
      command: { type: '__noop__' },
    };
    this.appendLocal(noop);
    this.matchIndex.set(this.id, noop.index);

    // Resume an unfinished joint transition if one exists in the durable log.
    this.resumeJointTransitionIfNeeded();

    this.heartbeatTimer = this.scheduler.schedule(0, () => this.heartbeatTick());
    this.broadcastAppendEntries();
  }

  private resumeJointTransitionIfNeeded(): void {
    const cfg = this.latestConfigAt(this.log.length - 1);
    if (!cfg?.joint) {
      return;
    }
    const jointIndex = cfg.id;
    this.waitForIndex(jointIndex, this.opts.clientTimeoutMs)
      .then(() => {
        if (this.role !== 'leader' || !this.config.joint) return;
        const newIndex = this.lastLogIndex() + 1;
        const newConfig: RaftConfig = {
          id: newIndex,
          voters: cfg.joint!.newVoters,
        };
        this.appendLocal({
          term: this.currentTerm,
          index: newIndex,
          command: { type: '__config__', phase: 'final' },
          config: newConfig,
        });
        this.matchIndex.set(this.id, newIndex);
        this.broadcastAppendEntries();
        return this.waitForConfig(newIndex, this.opts.clientTimeoutMs);
      })
      .then((committed) => {
        if (committed && !committed.voters.includes(this.id)) {
          this.becomeFollower(this.currentTerm);
        }
      })
      .catch(() => {
        // A deposed leader leaves the transition for the next leader to resume.
      });
  }

  private heartbeatTick(): void {
    if (this.stopped || this.role !== 'leader') return;
    this.broadcastAppendEntries();
    this.heartbeatTimer = this.scheduler.schedule(this.opts.heartbeatMs, () =>
      this.heartbeatTick(),
    );
  }

  private becomeFollower(term: number): void {
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.votedFor = null;
      this.store.saveTerm(term);
    }
    const wasLeader = this.role === 'leader';
    this.role = 'follower';
    this.scheduler.cancel(this.heartbeatTimer);
    this.nextIndex.clear();
    this.matchIndex.clear();
    this.votes.clear();
    this.barrierRound = 0;
    this.barrierAcksByRound.clear();
    if (wasLeader) {
      this.failAllPending(
        new RaftError(`leader ${this.id} deposed in term ${term}`, 'DEPOSED'),
      );
    }
    this.resetElectionTimer();
  }

  /* ============================================================== */
  /* Message dispatch                                               */
  /* ============================================================== */

  private handle(message: RaftMessage): void {
    if (this.stopped) return;
    switch (message.type) {
      case 'RequestVote':
        this.handleRequestVote(message);
        break;
      case 'RequestVoteResp':
        this.handleRequestVoteResp(message);
        break;
      case 'AppendEntries':
        this.handleAppendEntries(message);
        break;
      case 'AppendEntriesResp':
        this.handleAppendEntriesResp(message);
        break;
    }
  }

  private send(to: NodeId, message: RaftMessage): void {
    this.network.send({ from: this.id, to, message });
  }

  /* -------------------------------------------------------------- */
  /* RequestVote                                                    */
  /* -------------------------------------------------------------- */

  private handleRequestVote(req: RequestVoteRequest): void {
    let granted = false;
    if (req.term > this.currentTerm) {
      this.becomeFollower(req.term);
    }
    if (req.term === this.currentTerm) {
      const upToDate =
        req.lastLogTerm > this.lastLogTerm() ||
        (req.lastLogTerm === this.lastLogTerm() &&
          req.lastLogIndex >= this.lastLogIndex());
      const canVote =
        (this.votedFor === null || this.votedFor === req.candidateId) && upToDate;
      // Only members of the active configuration may receive granted votes.
      const eligiblePeer =
        this.config.voters.includes(req.candidateId) &&
        this.isMemberOf(this.config);
      if (canVote && eligiblePeer) {
        this.votedFor = req.candidateId;
        this.store.saveVote(this.currentTerm, req.candidateId);
        granted = true;
        this.resetElectionTimer();
      }
    }
    const resp: RequestVoteResponse = {
      type: 'RequestVoteResp',
      term: this.currentTerm,
      voterId: this.id,
      granted,
    };
    this.send(req.candidateId, resp);
  }

  private handleRequestVoteResp(resp: RequestVoteResponse): void {
    if (resp.term > this.currentTerm) {
      this.becomeFollower(resp.term);
      return;
    }
    if (this.role !== 'candidate' || resp.term !== this.currentTerm) return;
    if (resp.granted) {
      this.votes.add(resp.voterId);
      this.maybeWinElection();
    }
  }

  /* -------------------------------------------------------------- */
  /* AppendEntries                                                  */
  /* -------------------------------------------------------------- */

  private broadcastAppendEntries(): void {
    if (this.role !== 'leader') return;
    const barrier = this.commitIndex;
    for (const peer of this.config.voters) {
      if (peer === this.id) continue;
      this.sendAppendEntriesTo(peer, barrier);
    }
  }

  private sendAppendEntriesTo(peer: NodeId, barrier: number): void {
    const next = this.nextIndex.get(peer) ?? this.lastLogIndex() + 1;
    const prev = this.store.entryAt(next - 1);
    if (!prev) return;
    const entries = this.log.filter((e) => e.index >= next);
    const req: AppendEntriesRequest = {
      type: 'AppendEntries',
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex: prev.index,
      prevLogTerm: prev.term,
      entries,
      leaderCommit: this.commitIndex,
      readBarrier: barrier,
      // Echo the latest read round so followers' acks can be attributed to it;
      // ordinary heartbeats (no pending read) carry round 0 and are ignored.
      barrierRound: this.readWaiters.length > 0 ? this.barrierRound : 0,
    };
    this.send(peer, req);
  }

  private handleAppendEntries(req: AppendEntriesRequest): void {
    if (req.term < this.currentTerm) {
      this.replyAppendEntries(req, false, this.lastLogIndex());
      return;
    }
    if (req.term > this.currentTerm) {
      this.becomeFollower(req.term);
    }
    // Same-term legitimate leader: a candidate/follower must yield.
    if (this.role !== 'follower') {
      this.becomeFollower(req.term);
    } else {
      this.resetElectionTimer();
    }

    const prev = this.store.entryAt(req.prevLogIndex);
    if (!prev || prev.term !== req.prevLogTerm) {
      const hint = prev
        ? this.lastLogIndex()
        : Math.min(req.prevLogIndex - 1, this.lastLogIndex());
      this.replyAppendEntries(req, false, hint);
      return;
    }

    if (req.entries.length > 0) {
      this.store.appendEntries(req.entries[0].index, req.entries);
      this.log = [...this.store.getLog()];
      const newest = this.latestConfigAt(this.log.length - 1);
      if (newest) this.config = newest;
      // Membership changed: election eligibility and peer set may differ now.
      this.resetElectionTimer();
    }

    if (req.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(req.leaderCommit, this.lastLogIndex());
      this.advanceApplied();
    }

    this.replyAppendEntries(req, true, this.lastLogIndex());
  }

  private replyAppendEntries(
    req: AppendEntriesRequest,
    success: boolean,
    matchIndex: number,
  ): void {
    const resp: AppendEntriesResponse = {
      type: 'AppendEntriesResp',
      term: this.currentTerm,
      followerId: this.id,
      success,
      matchIndex,
      readBarrier: success ? req.readBarrier : undefined,
      barrierRound: success ? req.barrierRound : undefined,
    };
    this.send(req.leaderId, resp);
  }

  private handleAppendEntriesResp(resp: AppendEntriesResponse): void {
    if (resp.term > this.currentTerm) {
      this.becomeFollower(resp.term);
      return;
    }
    if (this.role !== 'leader' || resp.term !== this.currentTerm) return;
    const peer = resp.followerId;

    if (resp.success) {
      const previousMatch = this.matchIndex.get(peer) ?? 0;
      this.matchIndex.set(peer, Math.max(previousMatch, resp.matchIndex));
      this.nextIndex.set(peer, (this.matchIndex.get(peer) ?? 0) + 1);

      if (resp.barrierRound && resp.barrierRound === this.barrierRound) {
        const acks = this.barrierAcksByRound.get(resp.barrierRound);
        if (acks) {
          acks.add(peer);
          this.processBarrierAcks();
        }
      }
      this.advanceCommitIndex();
      // Replicate anything newly queued for this peer immediately.
      if ((this.nextIndex.get(peer) ?? 0) <= this.lastLogIndex()) {
        this.sendAppendEntriesTo(peer, this.commitIndex);
      }
    } else {
      // Backtrack and retry (conflict-term optimization is not required).
      const backtrack = Math.max(
        1,
        Math.min(resp.matchIndex, (this.nextIndex.get(peer) ?? 1) - 1),
      );
      this.nextIndex.set(peer, backtrack);
      this.sendAppendEntriesTo(peer, this.commitIndex);
    }
  }

  /* ============================================================== */
  /* Commit and apply                                               */
  /* ============================================================== */

  private advanceCommitIndex(): void {
    if (this.role !== 'leader') return;
    for (let candidate = this.lastLogIndex(); candidate > this.commitIndex; candidate--) {
      const entry = this.store.entryAt(candidate);
      if (!entry || entry.term !== this.currentTerm) continue; // §5.4.2
      const replicatedBy = (peer: NodeId): boolean =>
        peer === this.id || (this.matchIndex.get(peer) ?? 0) >= candidate;
      const groups = this.config.joint
        ? [this.config.joint.oldVoters, this.config.joint.newVoters]
        : [this.config.voters];
      const committed = groups.every(
        (group) =>
          group.filter(replicatedBy).length >= quorumSize(group.length),
      );
      if (committed) {
        this.commitIndex = candidate;
        this.advanceApplied();
        // Followers learn the new commit point on the next heartbeat/append.
        this.broadcastAppendEntries();
        break;
      }
    }
  }

  private advanceApplied(): void {
    let changed = false;
    for (const entry of this.log) {
      if (entry.index > this.lastApplied && entry.index <= this.commitIndex) {
        this.applyEntry(entry);
        changed = true;
      }
    }
    if (changed) {
      this.store.saveSnapshot({
        commitIndex: this.commitIndex,
        lastApplied: this.lastApplied,
        appliedState: this.appliedState,
      });
      this.resolveWrites();
      this.resolveConfigWaiters();
      this.processBarrierAcks();
    }
  }

  private applyEntry(entry: LogEntry): void {
    this.lastApplied = entry.index;
    if (entry.config) {
      this.config = entry.config;
    }
    const command = entry.command as { type?: string } | null;
    if (command && (command.type === '__noop__' || command.type === '__config__')) {
      return; // internal entries do not touch the caller's state machine
    }
    this.appliedState = this.sm.reduce(
      this.appliedState,
      entry.command,
      entry.index,
      entry.term,
    );
  }

  /* ============================================================== */
  /* Pending operation bookkeeping                                  */
  /* ============================================================== */

  private resolveWrites(): void {
    for (const [index, pending] of [...this.pendingWrites]) {
      if (index <= this.commitIndex) {
        this.pendingWrites.delete(index);
        this.scheduler.cancel(pending.timer);
        const entry = this.store.entryAt(index);
        if (entry) pending.resolve(entry);
      }
    }
  }

  private resolveConfigWaiters(): void {
    for (const [index, waiter] of [...this.configWaiters]) {
      if (index <= this.commitIndex) {
        this.configWaiters.delete(index);
        this.scheduler.cancel(waiter.timer);
        const entry = this.store.entryAt(index);
        if (entry?.config) waiter.resolve(entry.config);
      }
    }
  }

  private barrierConfirmed(term: number, round: number): boolean {
    if (term !== this.currentTerm || this.role !== 'leader') return false;
    const acks = this.barrierAcksByRound.get(round);
    if (!acks) return false;
    const groups = this.config.joint
      ? [this.config.joint.oldVoters, this.config.joint.newVoters]
      : [this.config.voters];
    return groups.every(
      (group) =>
        group.filter((v) => acks.has(v)).length >= quorumSize(group.length),
    );
  }

  private processBarrierAcks(): void {
    const remaining: ReadWaiter[] = [];
    for (const waiter of this.readWaiters) {
      if (this.barrierConfirmed(waiter.term, waiter.round)) {
        this.fulfillReadWhenApplied(waiter);
        if (this.readWaiters.includes(waiter)) {
          // Not yet fulfillable (applied index behind the barrier); keep it.
          remaining.push(waiter);
        }
      } else {
        remaining.push(waiter);
      }
    }
    this.readWaiters = remaining;
  }

  private fulfillReadWhenApplied(waiter: ReadWaiter): void {
    if (waiter.term !== this.currentTerm || this.role !== 'leader') {
      const pos = this.readWaiters.indexOf(waiter);
      if (pos >= 0) this.readWaiters.splice(pos, 1);
      this.barrierAcksByRound.delete(waiter.round);
      this.scheduler.cancel(waiter.timer);
      waiter.reject(new RaftError('leadership changed before read completed', 'DEPOSED'));
      return;
    }
    if (this.lastApplied >= waiter.barrierIndex) {
      const pos = this.readWaiters.indexOf(waiter);
      if (pos >= 0) this.readWaiters.splice(pos, 1);
      this.barrierAcksByRound.delete(waiter.round);
      this.scheduler.cancel(waiter.timer);
      waiter.resolve(this.appliedState);
    }
    // Otherwise the waiter stays registered; advanceApplied re-invokes
    // processBarrierAcks once the local state catches up.
  }

  private waitForIndex(index: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => this.commitIndex >= index;
      if (check()) return resolve();
      const timer = this.scheduler.schedule(timeoutMs, () => {
        reject(new RaftError(`index ${index} not committed in time`, 'TIMEOUT'));
      });
      const poll = (): void => {
        if (this.stopped) {
          this.scheduler.cancel(timer);
          reject(new RaftError('node stopped', 'SHUTDOWN'));
          return;
        }
        if (check()) {
          this.scheduler.cancel(timer);
          resolve();
          return;
        }
        this.scheduler.schedule(5, poll);
      };
      this.scheduler.schedule(5, poll);
    });
  }

  private waitForConfig(index: number, timeoutMs: number): Promise<RaftConfig> {
    const existing = this.configWaiters.get(index);
    if (existing) {
      return new Promise((resolve, reject) => {
        const origResolve = existing.resolve;
        const origReject = existing.reject;
        existing.resolve = (cfg) => {
          origResolve(cfg);
          resolve(cfg);
        };
        existing.reject = (err) => {
          origReject(err);
          reject(err);
        };
      });
    }
    return new Promise((resolve, reject) => {
      const timer = this.scheduler.schedule(timeoutMs, () => {
        this.configWaiters.delete(index);
        reject(new RaftError(`config entry ${index} not committed in time`, 'TIMEOUT'));
      });
      this.configWaiters.set(index, { index, resolve, reject, timer });
      this.advanceApplied();
    });
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pendingWrites) {
      this.scheduler.cancel(pending.timer);
      pending.reject(err);
    }
    this.pendingWrites.clear();
    for (const waiter of this.readWaiters) {
      this.scheduler.cancel(waiter.timer);
      waiter.reject(err);
    }
    this.readWaiters = [];
    for (const [, waiter] of this.configWaiters) {
      this.scheduler.cancel(waiter.timer);
      waiter.reject(err);
    }
    this.configWaiters.clear();
  }

  /* ============================================================== */
  /* Log helpers                                                    */
  /* ============================================================== */

  private appendLocal(entry: LogEntry): void {
    this.store.appendEntries(entry.index, [entry]);
    this.log = [...this.store.getLog()];
    if (entry.config) this.config = entry.config;
  }

  private lastLogIndex(): number {
    return this.store.lastIndex();
  }

  private lastLogTerm(): number {
    return this.store.lastTerm();
  }

  private latestConfigAt(off: number): RaftConfig | undefined {
    for (let i = off; i >= 0; i--) {
      const entry = this.log[i];
      if (entry?.config) return entry.config;
    }
    return undefined;
  }

  /**
   * Locate the log index of the final (non-joint) config entry whose voters
   * equal `target`. If it has not been appended yet, return the next index the
   * caller is going to use, so the waiter resolves once that entry commits.
   */
  private findFinalConfigIndex(target: NodeId[]): number {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const cfg = this.log[i]?.config;
      if (cfg && !cfg.joint && sameVoters(cfg.voters, target)) {
        return cfg.id;
      }
    }
    return this.lastLogIndex() + 1;
  }
}
