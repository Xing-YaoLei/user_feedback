/**
 * 公共类型：本地票据、broker 适配器契约、恢复结果。
 *
 * 背景：分区日志换主并截断后，旧 offset 可能被新分支内容复用，
 * 仅比较日志长度无法判断消费位置是否仍在同一分支。
 * 因此恢复必须基于 leaderEpoch（相同 epoch = 同一日志分支前缀）
 * 并绑定日志 token（token 变化 = 日志历史已更换）。
 */

/** 本地票据条目：某 leaderEpoch 内已确认处理到的下一 offset（不含）。 */
export interface EpochTicketEntry {
  leaderEpoch: number;
  nextOffset: number;
}

/** broker 对某 epoch 在当前历史中的证明。 */
export type EpochProof =
  | { kind: 'valid'; endOffset: number } // 该 epoch 在当前历史中的有效末端（不含）
  | { kind: 'diverged' }; // 该 epoch 已不在当前历史中

/** epoch 查询回包：必须携带计算时所基于的日志 token。 */
export interface EpochQueryResponse {
  token: string;
  proof: EpochProof;
}

/** 当前日志快照。 */
export interface LogSnapshot {
  token: string;
  retentionStart: number;
  logEnd: number;
}

export interface FetchRecord {
  offset: number;
  leaderEpoch: number;
  value: string;
}

export interface FetchBatch {
  token: string;
  records: FetchRecord[];
}

/** 日志 token 不匹配：回包/请求所绑定的日志分支已失效。 */
export class TokenMismatchError extends Error {
  readonly expectedToken: string;
  readonly actualToken: string;
  constructor(expectedToken: string, actualToken: string) {
    super(`log token mismatch: expected ${expectedToken}, current ${actualToken}`);
    this.name = 'TokenMismatchError';
    this.expectedToken = expectedToken;
    this.actualToken = actualToken;
  }
}

/** 请求位置已早于保留起点。 */
export class RetentionError extends Error {
  readonly offset: number;
  readonly retentionStart: number;
  constructor(offset: number, retentionStart: number) {
    super(`offset ${offset} is before retention start ${retentionStart}`);
    this.name = 'RetentionError';
    this.offset = offset;
    this.retentionStart = retentionStart;
  }
}

/** 请求位置越过日志末端。 */
export class OffsetOutOfRangeError extends Error {
  constructor(offset: number, logEnd: number) {
    super(`offset ${offset} is beyond log end ${logEnd}`);
    this.name = 'OffsetOutOfRangeError';
  }
}

/** 恢复结论为“需要显式重置”时，调用方强行继续消费会收到此错误。 */
export class ResetRequiredError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ResetRequiredError';
  }
}

/** 恢复结论为“未定”时，调用方强行继续消费会收到此错误。 */
export class RecoveryUndeterminedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'RecoveryUndeterminedError';
  }
}

/**
 * broker 适配器契约。所有携带 expectedToken 的操作都必须原子校验：
 * 校验失败抛 TokenMismatchError，绝不把新分支数据冒充旧 token 的数据返回。
 */
export interface BrokerAdapter {
  /** 当前日志 token、保留起点、日志末端。 */
  getLogSnapshot(): Promise<LogSnapshot>;
  /** 查询某 epoch 在当前历史中的有效末端或已不保留的证明，绑定 expectedToken。 */
  queryEpoch(leaderEpoch: number, expectedToken: string): Promise<EpochQueryResponse>;
  /** 当日志 token 不再是给定 token 时 resolve（携带新 token）。 */
  waitForTokenChange(token: string): Promise<string>;
  /** 从 offset 拉取数据，原子校验 expectedToken。 */
  fetch(offset: number, expectedToken: string): Promise<FetchBatch>;
}

export type ResetReason = 'no-common-epoch' | 'before-retention-start';

export type RecoveryOutcome =
  | { kind: 'recovered'; position: number; token: string; leaderEpoch: number }
  | { kind: 'reset-required'; reason: ResetReason; detail: string }
  | {
      kind: 'undetermined';
      reason: 'query-budget-exhausted' | 'token-unstable';
      detail: string;
    };

export interface RecoveryStats {
  epochQueries: number;
  rounds: number;
  /** 被丢弃的迟到回包数量（所属轮次已作废后才到达的响应）。 */
  discardedLateReplies: number;
}
