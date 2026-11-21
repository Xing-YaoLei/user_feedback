/**
 * 核心类型定义。
 *
 * 设计约定：
 * - 日志下标从 1 开始（Raft 论文约定），0 表示空哨兵位置。
 * - 配置以特殊日志条目形式存在；联合配置条目先入日志，目标配置条目后入日志。
 * - 所有时间均为注入调度器的虚拟毫秒，节点自身不接触系统时钟。
 */

export type NodeId = string;

export type RaftRole = 'follower' | 'candidate' | 'leader';

/** 调用方提供的确定性状态归约函数：同一条命令作用于同一状态，必得到同一结果。 */
export type Reducer<TState, TCommand> = (state: TState, command: TCommand) => TState;

/** 可选的只读查询函数；默认返回状态快照本身。 */
export type Query<TState, TResult> = (state: TState) => TResult;

/** 普通客户端命令条目。 */
export interface CommandEntry<TCommand = unknown> {
  kind: 'command';
  command: TCommand;
  /** 领导者上任时写入的 no-op 条目（不经过调用方归约函数）。 */
  noop?: boolean;
}

/**
 * 配置条目。
 * - joint：进入联合共识（Cold,new 联合配置）
 * - final：切换到纯 Cnew
 */
export interface ConfigEntry {
  kind: 'config';
  phase: 'joint' | 'final';
  /** 联合阶段的旧配置（仅 phase='joint' 时存在）。 */
  oldVoters?: NodeId[];
  /** joint 阶段的新配置 / final 阶段的目标配置。 */
  voters: NodeId[];
}

export type Entry<TCommand = unknown> = CommandEntry<TCommand> | ConfigEntry;

export interface LogEntry<TCommand = unknown> {
  index: number;
  term: number;
  entry: Entry<TCommand>;
}

/** 节点当前生效的配置。joint 为 true 时新旧两套投票集同时生效。 */
export interface ActiveConfig {
  joint: boolean;
  /** 旧配置投票集（联合阶段有效）。 */
  oldVoters: NodeId[];
  /** 新配置投票集。 */
  newVoters: NodeId[];
}

/** 持久化到节点本地目录的硬状态（term / vote）。 */
export interface HardState {
  currentTerm: number;
  votedFor: NodeId | null;
}

/** 持久化的已应用状态（含应用位点，保证重启后不会重复应用命令）。 */
export interface AppliedState<TState> {
  lastApplied: number;
  state: TState;
}

/** 节点启动参数。dataDir 必须是该节点独立拥有的本地目录。 */
export interface RaftNodeOptions<TState, TCommand> {
  id: NodeId;
  dataDir: string;
  /** 初始集群配置（所有节点首次启动时必须一致）。 */
  bootstrapVoters: NodeId[];
  reducer: Reducer<TState, TCommand>;
  initialState: TState;
  scheduler: Scheduler;
  transport: Transport<TCommand>;
  /** 选举超时区间（虚拟毫秒），每次重置在区间内由调度器 RNG 取值。 */
  electionTimeoutMin: number;
  electionTimeoutMax: number;
  /** 心跳间隔（虚拟毫秒）。 */
  heartbeatInterval: number;
  /** 单个 AppendEntries 批次携带的最大条目数。 */
  maxEntriesPerAppend?: number;
}

/**
 * 注入式调度器：驱动全部定时器与随机选择，使整个集群的演进完全可重复。
 * 实现见 scheduler.ts。
 */
export interface Scheduler {
  now(): number;
  /** 在延迟 delayMs 后执行回调，返回可取消的句柄。 */
  schedule(delayMs: number, callback: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
  /** 区间 [min, max) 内的确定性整数。 */
  randomInt(min: number, max: number): number;
  /** 推进虚拟时钟并执行到期回调，直到没有剩余事件或达到 maxSteps 上限。 */
  advance(maxSteps?: number): number;
  /** 推进到至少给定虚拟时间。 */
  advanceTo(when: number, maxSteps?: number): number;
  pendingCount(): number;
}

export interface TimerHandle {
  id: number;
}

/**
 * 注入式消息传输层。实现见 transport.ts，支持丢失、重复、延迟、乱序与滞留。
 */
export interface Transport<TCommand = unknown> {
  send(message: RaftMessage<TCommand>): void;
  /** 注册节点接收回调（由 RaftNode 构造时注册）。 */
  registerReceiver(id: NodeId, receiver: (message: RaftMessage<TCommand>) => void): void;
}

// ---------------------------------------------------------------------------
// 消息类型
// ---------------------------------------------------------------------------

export interface RequestVoteRequest<TCommand = unknown> {
  type: 'RequestVote';
  term: number;
  candidateId: NodeId;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface RequestVoteResponse {
  type: 'RequestVoteResp';
  term: number;
  voterId: NodeId;
  granted: boolean;
}

export interface AppendEntriesRequest<TCommand = unknown> {
  type: 'AppendEntries';
  term: number;
  leaderId: NodeId;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry<TCommand>[];
  leaderCommit: number;
}

export interface AppendEntriesResponse {
  type: 'AppendEntriesResp';
  term: number;
  followerId: NodeId;
  success: boolean;
  /** 该 follower 最新匹配下标（成功时）。 */
  matchIndex: number;
  /** 冲突提示下标（失败时，0 表示需要从头同步）。 */
  conflictIndex: number;
}

export type RaftMessage<TCommand = unknown> =
  | RequestVoteRequest<TCommand>
  | RequestVoteResponse
  | AppendEntriesRequest<TCommand>
  | AppendEntriesResponse;

// ---------------------------------------------------------------------------
// 客户端错误
// ---------------------------------------------------------------------------

export class NotLeaderError extends Error {
  /** 节点已知的最近领导者（可能未知）。 */
  readonly hint: NodeId | null;
  constructor(hint: NodeId | null) {
    super(hint ? `not leader, hint=${hint}` : 'not leader, no leader known');
    this.name = 'NotLeaderError';
    this.hint = hint;
  }
}

export class NodeStoppedError extends Error {
  constructor() {
    super('node has been stopped');
    this.name = 'NodeStoppedError';
  }
}

export class ConfigChangeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigChangeRejectedError';
  }
}

/** 成员变更请求的结果。 */
export interface ConfigChangeResult {
  /** 目标配置（Cnew）已提交的日志下标。 */
  committedIndex: number;
}

export interface NodeStatus {
  id: NodeId;
  role: RaftRole;
  currentTerm: number;
  commitIndex: number;
  lastApplied: number;
  lastLogIndex: number;
  leaderId: NodeId | null;
  config: ActiveConfig;
  stopped: boolean;
}
