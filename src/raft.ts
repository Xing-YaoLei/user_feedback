/**
 * Raft 协调状态机节点。
 *
 * 实现范围：
 * - 领导者选举（随机化选举超时、日志上位检查、联合配置双多数派投票裁决）
 * - 日志复制（AppendEntries 一致性检查、冲突回退、提交推进、确定性归约应用）
 * - 本地持久化与重启恢复（term/vote、日志、应用位点与状态快照各自原子落盘）
 * - ReadIndex 线性一致读：必须在当前任期获得法定人数心跳确认领导权，
 *   且等到 commitIndex 推进到读取所需位点后才应用查询
 * - 在线成员替换：新成员先以学习者追平日志，再写联合配置（Cold,new），
 *   联合提交后写目标配置 Cnew；联合阶段选举与提交均按两套多数派裁决；
 *   同一时刻只允许一项成员变更；允许移除在任领导者
 *
 * 节点不创建任何真实定时器或网络连接，全部由注入的 Scheduler / Transport 驱动，
 * 因此整个执行过程可重复。
 */

import type { TimerHandle } from './types.ts';
import {
  ConfigChangeRejectedError,
  NodeStoppedError,
  NotLeaderError,
  type ActiveConfig,
  type AppendEntriesRequest,
  type AppendEntriesResponse,
  type ConfigEntry,
  type Entry,
  type LogEntry,
  type NodeId,
  type NodeStatus,
  type Query,
  type RaftMessage,
  type RaftNodeOptions,
  type RaftRole,
  type Reducer,
  type RequestVoteRequest,
  type RequestVoteResponse,
} from './types.ts';
import { FileStore } from './storage.ts';
import type { Addressed } from './transport.ts';

interface PendingClient {
  term: number;
  resolve: (index: number) => void;
  reject: (error: Error) => void;
}

interface PendingRead<TResult> {
  term: number;
  readIndex: number;
  query: Query<TState, TResult>;
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface PendingConfigChange {
  term: number;
  resolve: (index: number) => void;
  reject: (error: Error) => void;
}

interface PeerState {
  nextIndex: number;
  matchIndex: number;
  /** 已被移出当前配置但仍需补投日志的节点（见 replicateRetiredPeers）。 */
  retained: boolean;
}

interface VoteTally {
  term: number;
  granted: Set<NodeId>;
}

interface ReadRound {
  term: number;
  acks: Set<NodeId>;
}

interface EntryCommitOptions {
  /** 配置变更承诺在该条目提交时结算。 */
  configPromise?: PendingConfigChange;
  /** 领导者 no-op 条目（不经过调用方归约函数）。 */
  noop?: boolean;
}

export class RaftNode<TState, TCommand = unknown> {
  readonly id: NodeId;
  private readonly opts: RaftNodeOptions<TState, TCommand>;
  private readonly store: FileStore<TState, TCommand>;
  private readonly reducer: Reducer<TState, TCommand>;
  private readonly maxEntriesPerAppend: number;

  // -- 持久化状态（经 FileStore 落盘） --
  private currentTerm = 0;
  private votedFor: NodeId | null = null;
  private log: LogEntry<TCommand>[] = [];

  // -- 易失状态 --
  private role: RaftRole = 'follower';
  private commitIndex = 0;
  private lastApplied = 0;
  private state: TState;
  private leaderId: NodeId | null = null;
  private stopped = false;

  // 领导者专属
  private peers = new Map<NodeId, PeerState>();
  private heartbeatHandle: TimerHandle | null = null;
  private readRound: ReadRound | null = null;

  // 候选人专属
  private voteTally: VoteTally | null = null;

  // 客户端承诺
  private readonly pendingProposals = new Map<number, PendingClient[]>();
  private readonly pendingReads: PendingRead<unknown>[] = [];
  private configChange: PendingConfigChange | null = null;
  /** 本次成员变更的目标配置（仅内存；joint 条目落盘后即由日志接管）。 */
  private configChangeTarget: NodeId[] | null = null;

  // 条目提交时的附加动作
  private readonly entryCommitHooks = new Map<number, EntryCommitOptions>();

  private electionTimer: TimerHandle | null = null;

  constructor(opts: RaftNodeOptions<TState, TCommand>) {
    this.opts = opts;
    this.id = opts.id;
    this.reducer = opts.reducer;
    this.maxEntriesPerAppend = opts.maxEntriesPerAppend ?? 64;
    this.store = new FileStore<TState, TCommand>(opts.dataDir, opts.initialState);

    const hard = this.store.getHardState();
    this.currentTerm = hard.currentTerm;
    this.votedFor = hard.votedFor;
    this.log = this.store.getLog();
    const applied = this.store.getApplied();
    this.lastApplied = applied.lastApplied;
    this.state = applied.state;

    opts.transport.registerReceiver(opts.id, (message) => this.handle(message));
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  start(): void {
    if (this.stopped) throw new NodeStoppedError();
    this.resetElectionTimer();
  }

  stop(): void {
    // 幂等：重复停止（含重启替换场景）不抛错。
    if (this.stopped) return;
    this.stopped = true;
    if (this.electionTimer) this.opts.scheduler.cancel(this.electionTimer);
    if (this.heartbeatHandle) this.opts.scheduler.cancel(this.heartbeatHandle);
    this.electionTimer = null;
    this.heartbeatHandle = null;
    this.failAllClientWork(new NodeStoppedError());
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  status(): NodeStatus {
    return {
      id: this.id,
      role: this.role,
      currentTerm: this.currentTerm,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      lastLogIndex: this.lastLogIndex(),
      leaderId: this.leaderId,
      config: this.activeConfig(),
      stopped: this.stopped,
    };
  }

  /** 仅供测试/观察：当前已知领导者。 */
  get knownLeader(): NodeId | null {
    return this.leaderId;
  }

  // -------------------------------------------------------------------------
  // 日志与配置辅助
  // -------------------------------------------------------------------------

  private lastLogIndex(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1]!.index : 0;
  }

  private lastLogTerm(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1]!.term : 0;
  }

  private entryAt(index: number): LogEntry<TCommand> | undefined {
    if (index <= 0 || index > this.lastLogIndex()) return undefined;
    return this.log[index - 1];
  }

  private termAt(index: number): number {
    return this.entryAt(index)?.term ?? 0;
  }

  private persistLog(): void {
    this.store.saveLog(this.log);
  }

  private persistHardState(): void {
    this.store.saveHardState({ currentTerm: this.currentTerm, votedFor: this.votedFor });
  }

  /**
   * 从日志重算出当前生效配置。
   * 约定：日志中的最后一个 config 条目决定配置；joint 条目之后、final 条目之前
   * 处于联合阶段。无任何配置条目时回退到启动引导配置。
   */
  activeConfig(): ActiveConfig {
    let config: ActiveConfig = {
      joint: false,
      oldVoters: [...this.opts.bootstrapVoters],
      newVoters: [...this.opts.bootstrapVoters],
    };
    for (const logEntry of this.log) {
      if (logEntry.entry.kind !== 'config') continue;
      const cfg = logEntry.entry as ConfigEntry;
      if (cfg.phase === 'joint') {
        config = {
          joint: true,
          oldVoters: [...(cfg.oldVoters ?? config.newVoters)],
          newVoters: [...cfg.voters],
        };
      } else {
        config = { joint: false, oldVoters: [...cfg.voters], newVoters: [...cfg.voters] };
      }
    }
    return config;
  }

  private isVoter(id: NodeId, config: ActiveConfig = this.activeConfig()): boolean {
    if (config.newVoters.includes(id)) return true;
    return config.joint && config.oldVoters.includes(id);
  }

  private static majority(needed: number): number {
    return Math.floor(needed / 2) + 1;
  }

  /** 联合配置下需要两套多数派；普通配置只需一套。 */
  private quorumGroups(config: ActiveConfig): NodeId[][] {
    return config.joint ? [config.oldVoters, config.newVoters] : [config.newVoters];
  }

  private hasMajority(group: NodeId[], members: Set<NodeId>): boolean {
    let count = 0;
    for (const id of group) if (members.has(id)) count++;
    return count >= RaftNode.majority(group.length);
  }

  /** 当前配置下，给定确认集合是否构成完整法定人数。 */
  private quorumAchieved(config: ActiveConfig, acked: Set<NodeId>): boolean {
    return this.quorumGroups(config).every((group) => this.hasMajority(group, acked));
  }

  // -------------------------------------------------------------------------
  // 选举定时器 / 角色切换
  // -------------------------------------------------------------------------

  private becomeFollower(term: number, leader: NodeId | null): void {
    const termChanged = term !== this.currentTerm;
    if (termChanged) {
      this.currentTerm = term;
      this.votedFor = null;
      this.persistHardState();
    }
    this.role = 'follower';
    this.leaderId = leader;
    this.voteTally = null;
    this.stopHeartbeat();
    this.readRound = null;
    if (termChanged) this.failClientWorkForTerm(term - 1);
    this.resetElectionTimer();
  }

  private onElectionTimeout(): void {
    if (this.stopped || this.role === 'leader') return;
    this.startElection();
  }

  /**
   * 选举超时重置。
   * 普通跟随者/候选人在标准区间内随机；连续落选的候选人额外增加退避，
   * 避免分区少数派在无法胜选时以最高频率制造选举消息风暴。
   */
  private resetElectionTimer(): void {
    if (this.stopped) return;
    if (this.electionTimer) this.opts.scheduler.cancel(this.electionTimer);
    const span = this.opts.electionTimeoutMax - this.opts.electionTimeoutMin;
    let timeout = this.opts.electionTimeoutMin + this.opts.scheduler.randomInt(0, span);
    if (this.role === 'candidate') {
      // 退避：0..一个完整超时区间的额外抖动。
      timeout += this.opts.scheduler.randomInt(0, this.opts.electionTimeoutMax);
    }
    this.electionTimer = this.opts.scheduler.schedule(timeout, () => this.onElectionTimeout());
  }

  private startElection(): void {
    const config = this.activeConfig();
    // 学习者（不在任何投票集内）不发起选举。
    if (!config.newVoters.includes(this.id) && !(config.joint && config.oldVoters.includes(this.id))) return;

    this.currentTerm += 1;
    this.role = 'candidate';
    this.votedFor = this.id;
    this.leaderId = null;
    this.persistHardState();
    this.resetElectionTimer();

    const term = this.currentTerm;
    this.voteTally = { term, granted: new Set<NodeId>([this.id]) };
    this.checkElectionWon();

    const request: RequestVoteRequest<TCommand> = {
      type: 'RequestVote',
      term,
      candidateId: this.id,
      lastLogIndex: this.lastLogIndex(),
      lastLogTerm: this.lastLogTerm(),
    };
    const targets = new Set<string>([...config.oldVoters, ...config.newVoters]);
    for (const peer of targets) {
      if (peer === this.id) continue;
      this.send(peer, request);
    }
  }

  private checkElectionWon(): void {
    if (this.role !== 'candidate' || !this.voteTally) return;
    const config = this.activeConfig();
    if (this.quorumAchieved(config, this.voteTally.granted)) {
      this.becomeLeader();
    }
  }

  private becomeLeader(): void {
    const term = this.currentTerm;
    this.role = 'leader';
    this.leaderId = this.id;
    this.voteTally = null;

    const config = this.activeConfig();
    this.peers.clear();
    const all = new Set<NodeId>([...config.oldVoters, ...config.newVoters]);
    const nextIndex = this.lastLogIndex() + 1;
    for (const peer of all) {
      if (peer === this.id) continue;
      this.peers.set(peer, { nextIndex, matchIndex: 0, retained: false });
    }

    // Raft 规定：新领导者提交一条当前任期 no-op，以提交前任遗留条目。
    this.appendLocalEntry({ kind: 'command', command: null as TCommand, noop: true });
    this.broadcastAppendEntries();
    // 重启后当选的领导者凭日志继续未完成的成员变更。
    this.reconcileConfigChange();
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatHandle = this.opts.scheduler.schedule(this.opts.heartbeatInterval, () => {
      if (this.stopped || this.role !== 'leader') return;
      this.broadcastAppendEntries();
      this.reconcileConfigChange();
      this.startHeartbeat();
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle) {
      this.opts.scheduler.cancel(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  // -------------------------------------------------------------------------
  // 消息收发
  // -------------------------------------------------------------------------

  private send(to: NodeId, message: RaftMessage<TCommand>): void {
    if (this.stopped) return;
    (message as Addressed<TCommand>).__to = to;
    this.opts.transport.send(message);
  }

  private handle(message: RaftMessage<TCommand>): void {
    if (this.stopped) return;
    // 所有 RPC 的通用规则：见到更高任期立即退回跟随者。
    if (message.term > this.currentTerm) {
      this.becomeFollower(message.term, null);
    }
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

  // -------------------------------------------------------------------------
  // RequestVote
  // -------------------------------------------------------------------------

  private handleRequestVote(req: RequestVoteRequest<TCommand>): void {
    let granted = false;
    const config = this.activeConfig();
    const voterInConfig = config.newVoters.includes(this.id)
      || (config.joint && config.oldVoters.includes(this.id));

    if (req.term === this.currentTerm && voterInConfig) {
      const logUpToDate = req.lastLogTerm > this.lastLogTerm()
        || (req.lastLogTerm === this.lastLogTerm() && req.lastLogIndex >= this.lastLogIndex());
      const canVote = this.votedFor === null || this.votedFor === req.candidateId;
      if (logUpToDate && canVote) {
        granted = true;
        this.votedFor = req.candidateId;
        this.persistHardState();
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
    if (this.role !== 'candidate' || resp.term !== this.currentTerm || !this.voteTally) return;
    if (resp.granted) {
      this.voteTally.granted.add(resp.voterId);
      this.checkElectionWon();
    }
  }

  // -------------------------------------------------------------------------
  // AppendEntries（跟随者侧）
  // -------------------------------------------------------------------------

  private handleAppendEntries(req: AppendEntriesRequest<TCommand>): void {
    const config = this.activeConfig();
    const knownPeer = config.newVoters.includes(req.leaderId)
      || (config.joint && config.oldVoters.includes(req.leaderId));

    // 同任期但领导者已不在配置内（例如被移除的旧领导者）：拒绝且不重置选举定时器。
    if (req.term < this.currentTerm || !knownPeer) {
      this.rejectAppend(req.leaderId, 0);
      return;
    }
    if (req.term === this.currentTerm && this.role === 'candidate') {
      this.becomeFollower(this.currentTerm, req.leaderId);
    } else if (this.role !== 'leader') {
      this.role = 'follower';
      this.leaderId = req.leaderId;
    }
    this.resetElectionTimer();

    // 一致性检查：prevLogIndex 处的任期必须匹配。
    if (req.prevLogIndex > this.lastLogIndex()) {
      this.rejectAppend(req.leaderId, this.lastLogIndex() + 1);
      return;
    }
    if (req.prevLogIndex > 0 && this.termAt(req.prevLogIndex) !== req.prevLogTerm) {
      // 冲突回退提示：跳过冲突任期的整段条目。
      const conflictTerm = this.termAt(req.prevLogIndex);
      let conflictIndex = req.prevLogIndex;
      while (conflictIndex > 0 && this.termAt(conflictIndex) === conflictTerm) conflictIndex--;
      this.rejectAppend(req.leaderId, conflictIndex + 1);
      return;
    }

    // 拼入新条目：首个冲突位置截断，之后整体覆盖。
    let mutated = false;
    for (const incoming of req.entries) {
      const existing = this.entryAt(incoming.index);
      if (existing) {
        if (existing.term !== incoming.term) {
          this.log = this.log.slice(0, incoming.index - 1);
          this.log.push(incoming);
          mutated = true;
        }
      } else {
        if (incoming.index !== this.lastLogIndex() + 1) {
          // 日志出现空洞，拒绝并要求领导者从本地末尾之后重发。
          this.rejectAppend(req.leaderId, this.lastLogIndex() + 1);
          return;
        }
        this.log.push(incoming);
        mutated = true;
      }
    }
    if (mutated) this.persistLog();

    if (req.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(req.leaderCommit, this.lastLogIndex());
      this.applyCommittedEntries();
    }
    // 成功收到领导者心跳/复制：选举定时器重新计时。
    this.resetElectionTimer();

    const resp: AppendEntriesResponse = {
      type: 'AppendEntriesResp',
      term: this.currentTerm,
      followerId: this.id,
      success: true,
      matchIndex: req.prevLogIndex + req.entries.length,
      conflictIndex: 0,
    };
    this.send(req.leaderId, resp);
  }

  private rejectAppend(leaderId: NodeId, conflictIndex: number): void {
    const resp: AppendEntriesResponse = {
      type: 'AppendEntriesResp',
      term: this.currentTerm,
      followerId: this.id,
      success: false,
      matchIndex: 0,
      conflictIndex,
    };
    this.send(leaderId, resp);
  }

  // -------------------------------------------------------------------------
  // AppendEntries（领导者侧）
  // -------------------------------------------------------------------------

  private handleAppendEntriesResp(resp: AppendEntriesResponse): void {
    if (this.role !== 'leader' || resp.term !== this.currentTerm) return;
    // 防御：绝不处理发给自己的响应（正常情况下 peers 不含本节点）。
    if (resp.followerId === this.id) return;
    const peer = this.peers.get(resp.followerId);
    if (!peer) return;

    // 同任期的任何响应都证明该对等方认可本节点领导权，计入 ReadIndex 确认。
    this.noteReadAck(resp.followerId);

    if (resp.success) {
      const advanced = resp.matchIndex > peer.matchIndex;
      peer.matchIndex = Math.max(peer.matchIndex, resp.matchIndex);
      peer.nextIndex = Math.max(peer.nextIndex, peer.matchIndex + 1);
      if (advanced) {
        this.advanceCommitIndex();
        this.reconcileConfigChange();
        // 提交位点推进后定点通知跟随者，不做全量广播，避免零延迟消息环。
        this.sendAppendToPeer(resp.followerId);
      }
      this.maybePruneRetiredPeer(resp.followerId);
    } else {
      // 冲突回退：采用对端提示下标，最小退到 1。
      peer.nextIndex = Math.max(1, resp.conflictIndex);
      this.sendAppendToPeer(resp.followerId);
    }
  }

  private broadcastAppendEntries(): void {
    for (const peerId of this.peers.keys()) this.sendAppendToPeer(peerId);
  }

  private sendAppendToPeer(peerId: NodeId): void {
    if (this.role !== 'leader') return;
    if (peerId === this.id) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const prevIndex = peer.nextIndex - 1;
    const sliceStart = Math.max(0, prevIndex);
    const sliceEnd = Math.min(this.log.length, sliceStart + this.maxEntriesPerAppend);
    const entries = this.log.slice(sliceStart, sliceEnd);

    const request: AppendEntriesRequest<TCommand> = {
      type: 'AppendEntries',
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex: prevIndex,
      prevLogTerm: this.termAt(prevIndex),
      entries,
      leaderCommit: this.commitIndex,
    };
    this.send(peerId, request);
  }

  /** 领导者本地追加条目并落盘，返回新条目下标。 */
  private appendLocalEntry(entry: Entry<TCommand>, options: EntryCommitOptions = {}): number {
    const logEntry: LogEntry<TCommand> = {
      index: this.lastLogIndex() + 1,
      term: this.currentTerm,
      entry,
    };
    this.log.push(logEntry);
    this.persistLog();
    if (options.configPromise || options.noop) {
      this.entryCommitHooks.set(logEntry.index, options);
    }
    return logEntry.index;
  }

  /**
   * 提交推进（论文 5.4.2）：
   * 仅提交当前任期条目；联合阶段要求新旧两套多数派各自确认。
   */
  private advanceCommitIndex(): void {
    if (this.role !== 'leader') return;
    const config = this.activeConfig();
    for (let index = this.lastLogIndex(); index > this.commitIndex; index--) {
      if (this.termAt(index) !== this.currentTerm) continue;
      const acked = new Set<NodeId>([this.id]);
      for (const [peerId, peer] of this.peers) {
        if (peer.matchIndex >= index && this.isVoter(peerId, config)) acked.add(peerId);
      }
      if (this.quorumAchieved(config, acked)) {
        this.commitIndex = index;
        this.applyCommittedEntries();
        break;
      }
    }
  }

  private applyCommittedEntries(): void {
    while (this.lastApplied < this.commitIndex) {
      const next = this.lastApplied + 1;
      const logEntry = this.entryAt(next);
      if (!logEntry) throw new Error(`missing log entry at index ${next}`);

      if (logEntry.entry.kind === 'command') {
        const command = logEntry.entry as { command: TCommand; noop?: boolean };
        if (!command.noop) {
          this.state = this.reducer(this.state, command.command);
        }
      }
      // config 条目不进入调用方状态机，配置本身由日志重算得到。

      this.lastApplied = next;
      this.store.saveApplied({ lastApplied: this.lastApplied, state: this.state });
      this.settleProposals(next);
      this.runCommitHook(next);
      // 若本节点在新配置中被移除，应用 final 条目后立即下台。
      if (logEntry.entry.kind === 'config'
        && (logEntry.entry as ConfigEntry).phase === 'final') {
        this.stepDownIfRemoved();
      }
    }
    this.resolveReadyReads();
  }

  private runCommitHook(index: number): void {
    const hook = this.entryCommitHooks.get(index);
    if (!hook) return;
    this.entryCommitHooks.delete(index);
    if (hook.configPromise) {
      const promise = hook.configPromise;
      this.configChange = null;
      this.configChangeTarget = null;
      promise.resolve(index);
    }
  }

  private settleProposals(index: number): void {
    const pending = this.pendingProposals.get(index);
    if (!pending) return;
    this.pendingProposals.delete(index);
    for (const client of pending) client.resolve(index);
  }

  // -------------------------------------------------------------------------
  // 客户端写入
  // -------------------------------------------------------------------------

  /**
   * 提议一条客户端命令。仅领导者接受；返回该命令提交后的日志下标。
   * 领导者失联（任期推进或停止）时以 NotLeaderError 拒绝，由调用方重试。
   */
  propose(command: TCommand): Promise<number> {
    if (this.stopped) return Promise.reject(new NodeStoppedError());
    if (this.role !== 'leader') return Promise.reject(new NotLeaderError(this.leaderId));

    const index = this.appendLocalEntry({ kind: 'command', command });
    const promise = new Promise<number>((resolve, reject) => {
      const list = this.pendingProposals.get(index) ?? [];
      list.push({ term: this.currentTerm, resolve, reject });
      this.pendingProposals.set(index, list);
      this.broadcastAppendEntries();
    });
    // 保底处理器：换届/停机导致的拒绝即使调用方未 await 也不产生 unhandledRejection。
    promise.catch(() => undefined);
    return promise;
  }

  // -------------------------------------------------------------------------
  // ReadIndex 线性一致读
  // -------------------------------------------------------------------------

  /**
   * 线性一致读：
   * 1. 仅领导者可发起；记录当前 commitIndex 作为 readIndex
   * 2. 必须在当前任期获得法定人数心跳确认（ReadIndex round），
   *    联合阶段需要新旧两套多数派各自确认
   * 3. 等待 lastApplied 追上 readIndex 后，才对归约状态执行查询
   * 因此本节点仅仅“自认为领导者”不足以让读取成功。
   */
  read<TResult>(query: Query<TState, TResult>): Promise<TResult> {
    if (this.stopped) return Promise.reject(new NodeStoppedError());
    if (this.role !== 'leader') return Promise.reject(new NotLeaderError(this.leaderId));

    const read: PendingRead<TResult> = {
      term: this.currentTerm,
      readIndex: this.commitIndex,
      query,
      resolve: () => undefined,
      reject: () => undefined,
      settled: false,
    };
    const promise = new Promise<TResult>((resolve, reject) => {
      read.resolve = resolve;
      read.reject = reject;
    });
    this.pendingReads.push(read as PendingRead<unknown>);

    if (!this.readRound || this.readRound.term !== this.currentTerm) {
      this.readRound = { term: this.currentTerm, acks: new Set<NodeId>([this.id]) };
      // 心跳即领导权确认探针。
      this.broadcastAppendEntries();
    }
    this.resolveReadyReads();
    promise.catch(() => undefined); // 保底处理器，原因同 propose。
    return promise;
  }

  private noteReadAck(peerId: NodeId): void {
    if (!this.readRound || this.readRound.term !== this.currentTerm) return;
    const config = this.activeConfig();
    if (!this.isVoter(peerId, config)) return;
    this.readRound.acks.add(peerId);
    if (this.quorumAchieved(config, this.readRound.acks)) {
      this.resolveReadyReads();
    }
  }

  private resolveReadyReads(): void {
    if (!this.readRound) return;
    const config = this.activeConfig();
    const confirmed = this.quorumAchieved(config, this.readRound.acks);
    if (!confirmed) return;
    for (const read of this.pendingReads) {
      if (read.settled || read.term !== this.currentTerm) continue;
      if (this.lastApplied >= read.readIndex) {
        read.settled = true;
        read.resolve(read.query(this.state));
      }
    }
    // 清理已结算项。
    for (let i = this.pendingReads.length - 1; i >= 0; i--) {
      if (this.pendingReads[i]!.settled) this.pendingReads.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // 在线成员变更（联合共识）
  // -------------------------------------------------------------------------

  /**
   * 发起一次成员替换，目标为 Cnew = targetVoters。
   * 流程（全部由日志驱动，节点重启后可凭日志继续推进）：
   *   a. 不在 Cnew 的新节点先以学习者身份注册并追平日志
   *   b. 追加联合配置条目 Cold,new（双多数派裁决）
   *   c. 联合条目提交后追加目标配置条目 Cnew
   * 同一时刻只允许一项成员变更；仅领导者可发起。
   */
  beginConfigChange(targetVoters: NodeId[]): Promise<number> {
    if (this.stopped) return Promise.reject(new NodeStoppedError());
    if (this.role !== 'leader') return Promise.reject(new NotLeaderError(this.leaderId));

    const config = this.activeConfig();
    const target = [...new Set(targetVoters)];
    if (target.length === 0) {
      return Promise.reject(new ConfigChangeRejectedError('target configuration must not be empty'));
    }

    const promise = new Promise<number>((resolve, reject) => {
      this.configChange = { term: this.currentTerm, resolve, reject };
    });
    promise.catch(() => undefined); // 保底处理器，原因同 propose。
    this.configChangeTarget = target;

    // 幂等接续：日志中已存在同一目标的进行中变更（可能由前任领导者发起，
    // 或本节点重启后恢复），重新附着客户端承诺并继续推进，而不是拒绝。
    const pending = this.findInFlightConfigTarget();
    if (pending) {
      const sameTarget = pending.length === target.length
        && pending.every((id) => target.includes(id));
      if (!sameTarget) {
        this.configChange = null;
        this.configChangeTarget = null;
        return Promise.reject(new ConfigChangeRejectedError('a different config change is already in flight'));
      }
      this.reconcileConfigChange();
      return promise;
    }

    if (config.joint) {
      this.configChange = null;
      this.configChangeTarget = null;
      return Promise.reject(new ConfigChangeRejectedError('another config change is already in flight'));
    }

    // 阶段 a：新成员作为学习者（仅在 peers 中复制，不在投票集内）追平日志。
    const current = new Set<NodeId>(config.newVoters);
    for (const id of target) {
      if (!current.has(id) && !this.peers.has(id)) {
        this.peers.set(id, { nextIndex: this.lastLogIndex() + 1, matchIndex: 0, retained: false });
      }
    }
    this.broadcastAppendEntries();
    this.tryEnterJointConfig(target, config.newVoters);
    return promise;
  }

  /**
   * 从日志中找出尚未完成的配置变更目标（存在 joint 条目但尚无对应 final 条目）。
   * 已完成（final 已入日志）则返回 null。
   */
  private findInFlightConfigTarget(): NodeId[] | null {
    let lastJoint: ConfigEntry | null = null;
    let sawFinalAfterJoint = false;
    for (const logEntry of this.log) {
      if (logEntry.entry.kind !== 'config') continue;
      const cfg = logEntry.entry as ConfigEntry;
      if (cfg.phase === 'joint') {
        lastJoint = cfg;
        sawFinalAfterJoint = false;
      } else {
        sawFinalAfterJoint = true;
      }
    }
    if (lastJoint && !sawFinalAfterJoint) return [...lastJoint.voters];
    return null;
  }

  /** 学习者追平后写入联合配置条目；未追平则由后续心跳/复制响应重试。 */
  private tryEnterJointConfig(target: NodeId[], oldVoters: NodeId[]): void {
    if (this.role !== 'leader' || !this.configChange) return;
    if (this.activeConfig().joint) return;
    if (this.findInFlightConfigTarget()) return; // joint 条目已存在
    const caughtUpAt = this.lastLogIndex();
    for (const id of target) {
      if (id === this.id) continue;
      const peer = this.peers.get(id);
      if (!peer || peer.matchIndex < caughtUpAt) return; // 等待追平
    }
    const jointEntry: ConfigEntry = {
      kind: 'config',
      phase: 'joint',
      oldVoters: [...oldVoters],
      voters: target,
    };
    // joint 条目本身不结算客户端承诺；承诺在 final 条目提交时结算。
    this.appendLocalEntry(jointEntry);
    this.broadcastAppendEntries();
    this.reconcileConfigChange();
  }

  /**
   * 配置变更推进状态机：在每次复制响应与心跳时调用，
   * 使领导者（含重启后恢复、或新当选的领导者）能凭日志继续未完成的变更。
   */
  private reconcileConfigChange(): void {
    if (this.role !== 'leader') return;
    const config = this.activeConfig();

    // 情况 1：联合条目已在日志中，等待其提交后追加 final 条目。
    if (config.joint) {
      const jointIndex = this.lastConfigEntryIndex('joint');
      if (jointIndex > 0 && this.commitIndex >= jointIndex && this.lastConfigEntryIndex('final') === 0) {
        const finalEntry: ConfigEntry = { kind: 'config', phase: 'final', voters: [...config.newVoters] };
        // 客户端承诺在 final 提交时结算；无内存承诺（重启/换领导者）时仅推进日志。
        const options = this.configChange ? { configPromise: this.configChange } : {};
        this.appendLocalEntry(finalEntry, options);
        this.broadcastAppendEntries();
      }
      return;
    }

    // 情况 2：学习者仍在追平，重试进入联合阶段。
    if (this.configChange && this.configChangeTarget) {
      this.tryEnterJointConfig(this.configChangeTarget, config.newVoters);
    }
  }

  private lastConfigEntryIndex(phase: 'joint' | 'final'): number {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const logEntry = this.log[i]!;
      if (logEntry.entry.kind === 'config' && (logEntry.entry as ConfigEntry).phase === phase) {
        return logEntry.index;
      }
    }
    return 0;
  }

  /**
   * 被移出配置的节点仍需补投日志以收敛（题目要求配置切换与滞留写入一起收敛）。
   * 一旦其 matchIndex 达到 final 配置条目下标，即停止复制并让节点自行下台。
   */
  private maybePruneRetiredPeer(peerId: NodeId): void {
    const config = this.activeConfig();
    if (config.joint) return;
    if (config.newVoters.includes(peerId)) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.retained = true;
    const finalIndex = this.lastConfigEntryIndex('final');
    if (finalIndex > 0 && peer.matchIndex >= finalIndex) {
      this.peers.delete(peerId);
      this.stepDownIfRemoved();
    }
  }

  /** 当前领导者已不在目标配置中：final 条目应用后主动下台。 */
  private stepDownIfRemoved(): void {
    if (this.role !== 'leader') return;
    const config = this.activeConfig();
    if (config.joint || config.newVoters.includes(this.id)) return;
    this.becomeFollower(this.currentTerm, null);
    this.failAllClientWork(new NotLeaderError(null));
  }

  // -------------------------------------------------------------------------
  // 失败结算
  // -------------------------------------------------------------------------

  private failClientWorkForTerm(oldTerm: number): void {
    const error = new NotLeaderError(this.leaderId);
    for (const [index, clients] of this.pendingProposals) {
      const remaining = clients.filter((client) => {
        if (client.term <= oldTerm) {
          client.reject(error);
          return false;
        }
        return true;
      });
      if (remaining.length > 0) this.pendingProposals.set(index, remaining);
      else this.pendingProposals.delete(index);
    }
    for (const read of this.pendingReads) {
      if (!read.settled && read.term <= oldTerm) {
        read.settled = true;
        read.reject(error);
      }
    }
    if (this.configChange && this.configChange.term <= oldTerm) {
      const pending = this.configChange;
      this.configChange = null;
      this.configChangeTarget = null;
      pending.reject(error);
    }
  }

  private failAllClientWork(error: Error): void {
    for (const clients of this.pendingProposals.values()) {
      for (const client of clients) client.reject(error);
    }
    this.pendingProposals.clear();
    for (const read of this.pendingReads) {
      if (!read.settled) {
        read.settled = true;
        read.reject(error);
      }
    }
    this.pendingReads.length = 0;
    if (this.configChange) {
      const pending = this.configChange;
      this.configChange = null;
      this.configChangeTarget = null;
      pending.reject(error);
    }
  }
}
