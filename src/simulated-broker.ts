import { OffsetOutOfRangeError, RetentionError, TokenMismatchError } from './types.ts';
import type {
  BrokerAdapter,
  EpochProof,
  EpochQueryResponse,
  FetchBatch,
  FetchRecord,
  LogSnapshot,
} from './types.ts';

interface Segment {
  epoch: number;
  start: number; // 含
  end: number; // 不含
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface SimulatedBrokerHooks {
  /** 在查询响应计算前触发（可用于在查询中途制造换主/截断）。 */
  beforeQueryResponse?: (
    leaderEpoch: number,
    token: string,
    broker: SimulatedBroker,
  ) => void | Promise<void>;
}

/**
 * 本地合成 broker：分段日志（每段一个 leaderEpoch），支持换主截断、
 * 保留推进、响应延迟与故障注入。所有携带 expectedToken 的操作都做原子校验。
 */
export class SimulatedBroker implements BrokerAdapter {
  private segments: Segment[] = [];
  private records: FetchRecord[] = [];
  private tokenSeq = 0;
  private token = 'token-0';
  private retentionStart = 0;
  private watchers: Array<(newToken: string) => void> = [];

  // 测试可观测/可注入点
  queryCount = 0;
  fetchCount = 0;
  queryDelayMs = 0;
  /** false 时模拟滞后副本：按请求到达时的状态应答，响应前不再校验 token。 */
  validateTokenAtResponse = true;
  hooks: SimulatedBrokerHooks = {};

  currentToken(): string {
    return this.token;
  }

  // ---------- 集群侧操作（测试用来驱动“集群”） ----------

  /** 以给定 leaderEpoch 追加 count 条记录。 */
  append(leaderEpoch: number, count: number, valuePrefix = 'rec'): void {
    const start = this.logEnd();
    for (let i = 0; i < count; i += 1) {
      this.records.push({
        offset: start + i,
        leaderEpoch,
        value: `${valuePrefix}-${start + i}`,
      });
    }
    this.segments.push({ epoch: leaderEpoch, start, end: start + count });
  }

  /** 换主并截断：fromOffset 之后的历史被丢弃，日志 token 更换（新分支会复用旧 offset）。 */
  truncateAndReassign(fromOffset: number): void {
    this.records = this.records.filter((r) => r.offset < fromOffset);
    const kept: Segment[] = [];
    for (const seg of this.segments) {
      if (seg.end <= fromOffset) {
        kept.push(seg);
      } else if (seg.start < fromOffset) {
        kept.push({ ...seg, end: fromOffset });
        break;
      } else {
        break;
      }
    }
    this.segments = kept;
    this.bumpToken();
  }

  /** 保留起点推进到 upToOffset。 */
  applyRetention(upToOffset: number): void {
    this.retentionStart = upToOffset;
    this.records = this.records.filter((r) => r.offset >= upToOffset);
    this.segments = this.segments
      .filter((s) => s.end > upToOffset)
      .map((s) => ({ ...s, start: Math.max(s.start, upToOffset) }));
  }

  private logEnd(): number {
    return this.segments.length
      ? this.segments[this.segments.length - 1].end
      : this.retentionStart;
  }

  private bumpToken(): void {
    this.tokenSeq += 1;
    this.token = `token-${this.tokenSeq}`;
    const watchers = this.watchers;
    this.watchers = [];
    for (const w of watchers) w(this.token);
  }

  private computeProof(leaderEpoch: number): EpochProof {
    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      if (this.segments[i].epoch === leaderEpoch) {
        return { kind: 'valid', endOffset: this.segments[i].end };
      }
    }
    return { kind: 'diverged' };
  }

  // ---------- BrokerAdapter ----------

  getLogSnapshot(): Promise<LogSnapshot> {
    return Promise.resolve({
      token: this.token,
      retentionStart: this.retentionStart,
      logEnd: this.logEnd(),
    });
  }

  async queryEpoch(leaderEpoch: number, expectedToken: string): Promise<EpochQueryResponse> {
    this.queryCount += 1;
    if (expectedToken !== this.token) {
      throw new TokenMismatchError(expectedToken, this.token);
    }
    const proofAtRequest = this.computeProof(leaderEpoch);
    if (this.queryDelayMs > 0) await delay(this.queryDelayMs);
    if (this.hooks.beforeQueryResponse) {
      await this.hooks.beforeQueryResponse(leaderEpoch, expectedToken, this);
    }
    if (!this.validateTokenAtResponse) {
      // 滞后副本：按请求到达时的快照应答（迟到回包）。
      return { token: expectedToken, proof: proofAtRequest };
    }
    // 响应前原子重校验：token 已变则拒绝，不让旧 token 拿到新分支的推导依据。
    if (expectedToken !== this.token) {
      throw new TokenMismatchError(expectedToken, this.token);
    }
    return { token: this.token, proof: this.computeProof(leaderEpoch) };
  }

  waitForTokenChange(token: string): Promise<string> {
    if (token !== this.token) return Promise.resolve(this.token);
    return new Promise((resolve) => this.watchers.push(resolve));
  }

  async fetch(offset: number, expectedToken: string): Promise<FetchBatch> {
    this.fetchCount += 1;
    // 原子校验：拒绝把新分支数据冒充旧 token 的数据返回。
    if (expectedToken !== this.token) {
      throw new TokenMismatchError(expectedToken, this.token);
    }
    if (offset < this.retentionStart) {
      throw new RetentionError(offset, this.retentionStart);
    }
    if (offset > this.logEnd()) {
      throw new OffsetOutOfRangeError(offset, this.logEnd());
    }
    return {
      token: this.token,
      records: this.records.filter((r) => r.offset >= offset),
    };
  }
}
