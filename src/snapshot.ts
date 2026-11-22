/**
 * 分布式快照模块(非 FIFO 通道、多轮并发)。
 *
 * 算法要点(Chandy-Lamport / Lai-Yang 风格):
 * - 节点名单在一轮快照内固定;所有业务收发都经过本模块。
 * - 每条业务消息携带发送方发送时已记录完毕的轮次标记(rounds)。
 *   接收方在处理业务效果之前,先对标记中自己尚未记录的轮次补做本地截面,
 *   因此捕获边界由业务消息携带的轮次信息决定,与控制消息到达顺序无关。
 * - 通道记录:发送方在记录轮次时记下对每个邻居的“截面前发送计数”,
 *   通过控制消息告知接收方;接收方按 (from, seq) 去重后把截面前消息分类为
 *   “已吸收”(计入本地截面)或“在途”(计入通道记录)。某条通道截面前发送的
 *   消息全部分类完毕(分类数 == 发送方计数)后,该通道才算被证明完成;
 *   所有通道证明完成后,节点才向本轮发起者上报本地截面与在途消息。
 * - 单轮取消、容量不足、权威节点代次变更都会使该轮明确失败并广播中止,
 *   其他轮次与业务投递不受影响;轮次结束后通道载荷与轮次标记即被回收。
 */

export type NodeId = string;
export type RoundId = string;
export type Payload = unknown;

export type FailReason = 'cancelled' | 'capacity' | 'authority-epoch';

// ---------- 线上消息 ----------

export interface BusinessMessage {
  kind: 'business';
  from: NodeId;
  seq: number;
  /** 发送方发送时已记录的轮次(轮次标记) */
  rounds: RoundId[];
  payload: Payload;
}

export interface AnnounceMessage {
  kind: 'announce';
  from: NodeId; // 发起者
  round: RoundId;
  roster: NodeId[];
  epoch: number;
}

export interface ChannelReportMessage {
  kind: 'channel-report';
  from: NodeId;
  round: RoundId;
  /** from 在记录该轮之前向接收方发送的业务消息总数(截面前发送计数) */
  count: number;
}

export interface LocalReportMessage {
  kind: 'local-report';
  from: NodeId;
  round: RoundId;
  state: Payload;
  /** 本节点各入通道的在途消息(截面前发出、截面后到达) */
  channels: Array<{ from: NodeId; messages: Array<{ seq: number; payload: Payload }> }>;
}

export interface AbortMessage {
  kind: 'abort';
  from: NodeId;
  round: RoundId;
  reason: FailReason;
}

export interface RoundDoneMessage {
  kind: 'round-done';
  from: NodeId;
  round: RoundId;
}

export type WireMessage =
  | BusinessMessage
  | AnnounceMessage
  | ChannelReportMessage
  | LocalReportMessage
  | AbortMessage
  | RoundDoneMessage;

// ---------- 快照结果 ----------

export interface ChannelRecord {
  from: NodeId;
  to: NodeId;
  messages: Array<{ seq: number; payload: Payload }>;
}

export interface SnapshotResult {
  roundId: RoundId;
  epoch: number;
  roster: NodeId[];
  /** 各节点本地截面 */
  states: Record<NodeId, Payload>;
  /** 截面之间的在途消息,键为 `${from}->${to}` */
  channels: Record<string, ChannelRecord>;
}

// ---------- 适配接口 ----------

export interface Transport {
  send(from: NodeId, to: NodeId, msg: WireMessage): void;
}

export interface BusinessDelivery {
  from: NodeId;
  seq: number;
  payload: Payload;
}

export type NodeEvent =
  | { type: 'record'; round: RoundId }
  | { type: 'send-business'; to: NodeId; seq: number; rounds: RoundId[]; payload: Payload }
  | { type: 'deliver-business'; from: NodeId; seq: number; payload: Payload }
  | { type: 'duplicate-business'; from: NodeId; seq: number };

export interface SnapshotNodeOptions {
  id: NodeId;
  roster: NodeId[];
  transport: Transport;
  /** 调用方提供的本地状态捕获回调(返回深拷贝或可快照的值) */
  captureState: () => Payload;
  /** 本地消息处理回调,同步完成状态修改 */
  onBusiness: (msg: BusinessDelivery) => void;
  /** 并发轮次容量上限,超出则新轮次明确失败 */
  maxRounds?: number;
  authorityEpoch?: number;
  onRoundComplete?: (result: SnapshotResult) => void;
  onRoundFailed?: (roundId: RoundId, reason: FailReason) => void;
  /** 轨迹钩子,供测试复验 */
  onEvent?: (e: NodeEvent) => void;
}

// ---------- 内部状态 ----------

interface ChannelState {
  /** 发送方报告的截面前发送计数 */
  expected: number | null;
  /** 截面前到达、已吸收进本地截面的消息数 */
  absorbed: number;
  /** 截面后到达的截面前消息(在途,进入通道记录) */
  inTransit: Array<{ seq: number; payload: Payload }>;
  /** 已分类的消息序号(去重) */
  classified: Set<number>;
}

interface RoundState {
  id: RoundId;
  epoch: number;
  initiator: NodeId | null;
  roster: NodeId[] | null;
  state: Payload;
  /** 记录本节点截面时对每个邻居的累计发送计数 */
  sentAtRecord: Map<NodeId, number>;
  /** 入通道,按发送方索引 */
  channels: Map<NodeId, ChannelState>;
  reportsSent: boolean;
  reported: boolean;
  /** 仅发起者使用:已收集的本地报告 */
  collected: Map<NodeId, LocalReportMessage> | null;
}

const ENDED_LIMIT = 256;

export class SnapshotNode {
  readonly id: NodeId;
  private readonly roster: NodeId[];
  private readonly transport: Transport;
  private readonly captureStateFn: () => Payload;
  private readonly onBusinessFn: (msg: BusinessDelivery) => void;
  private readonly maxRounds: number;
  private epoch: number;
  private seq = 0;
  private readonly sentCount = new Map<NodeId, number>();
  private readonly seen = new Set<string>();
  /** 已接收业务消息日志,供记录轮次时补分类“已吸收”消息 */
  private readonly receivedLog: Array<{ from: NodeId; seq: number; rounds: RoundId[] }> = [];
  private readonly rounds = new Map<RoundId, RoundState>();
  private readonly ended = new Map<RoundId, { outcome: 'completed' | 'failed'; reason?: FailReason }>();
  /** 轮次尚未知晓时先到的通道报告 */
  private readonly pendingReports = new Map<RoundId, Array<{ from: NodeId; count: number }>>();
  private readonly completeCb: ((result: SnapshotResult) => void) | undefined;
  private readonly failedCb: ((roundId: RoundId, reason: FailReason) => void) | undefined;
  private readonly eventCb: ((e: NodeEvent) => void) | undefined;

  constructor(opts: SnapshotNodeOptions) {
    this.id = opts.id;
    this.roster = [...opts.roster];
    this.transport = opts.transport;
    this.captureStateFn = opts.captureState;
    this.onBusinessFn = opts.onBusiness;
    this.maxRounds = opts.maxRounds ?? 16;
    this.epoch = opts.authorityEpoch ?? 0;
    this.completeCb = opts.onRoundComplete;
    this.failedCb = opts.onRoundFailed;
    this.eventCb = opts.onEvent;
  }

  get authorityEpoch(): number {
    return this.epoch;
  }

  // ---------- 对外 API ----------

  /** 发送业务消息(自动携带当前轮次标记) */
  sendBusiness(to: NodeId, payload: Payload): void {
    const rounds = [...this.rounds.keys()];
    const msg: BusinessMessage = { kind: 'business', from: this.id, seq: this.seq++, rounds, payload };
    this.sentCount.set(to, (this.sentCount.get(to) ?? 0) + 1);
    this.eventCb?.({ type: 'send-business', to, seq: msg.seq, rounds: [...rounds], payload });
    this.transport.send(this.id, to, msg);
  }

  /** 以本节点为发起者开始一轮快照 */
  startRound(roundId: RoundId): boolean {
    if (this.rounds.has(roundId) || this.ended.has(roundId)) return false;
    if (this.rounds.size >= this.maxRounds) {
      this.ended.set(roundId, { outcome: 'failed', reason: 'capacity' });
      this.evictEnded();
      this.failedCb?.(roundId, 'capacity');
      return false;
    }
    const round = this.newRound(roundId, [...this.roster], this.id, this.epoch);
    round.collected = new Map();
    this.record(round);
    for (const peer of this.roster) {
      if (peer === this.id) continue;
      this.transport.send(this.id, peer, {
        kind: 'announce',
        from: this.id,
        round: roundId,
        roster: [...this.roster],
        epoch: this.epoch,
      });
    }
    this.sendChannelReports(round);
    this.maybeReport(round);
    return true;
  }

  /** 取消一轮快照:该轮明确失败,其他轮次与业务不受影响 */
  cancelRound(roundId: RoundId): boolean {
    if (!this.rounds.has(roundId)) return false;
    this.failRound(roundId, 'cancelled');
    return true;
  }

  /** 权威节点代次变更:代次不一致的活动轮次明确失败 */
  setAuthorityEpoch(epoch: number): void {
    this.epoch = epoch;
    for (const round of [...this.rounds.values()]) {
      if (round.epoch !== epoch) this.failRound(round.id, 'authority-epoch');
    }
  }

  /** 传输适配器投递入口 */
  receive(msg: WireMessage): void {
    switch (msg.kind) {
      case 'business':
        this.receiveBusiness(msg);
        break;
      case 'announce':
        this.receiveAnnounce(msg);
        break;
      case 'channel-report':
        this.receiveChannelReport(msg);
        break;
      case 'local-report':
        this.receiveLocalReport(msg);
        break;
      case 'abort':
        this.receiveAbort(msg);
        break;
      case 'round-done':
        this.receiveRoundDone(msg);
        break;
    }
  }

  // ---------- 测试/观测用 ----------

  activeRoundIds(): RoundId[] {
    return [...this.rounds.keys()];
  }

  roundOutcome(
    roundId: RoundId,
  ): { outcome: 'active' } | { outcome: 'completed' } | { outcome: 'failed'; reason?: FailReason } | undefined {
    if (this.rounds.has(roundId)) return { outcome: 'active' };
    return this.ended.get(roundId);
  }

  // ---------- 业务消息 ----------

  private receiveBusiness(msg: BusinessMessage): void {
    const key = `${msg.from}#${msg.seq}`;
    if (this.seen.has(key)) {
      // 重复投递:直接丢弃,不影响任何轮次与业务状态
      this.eventCb?.({ type: 'duplicate-business', from: msg.from, seq: msg.seq });
      return;
    }
    this.seen.add(key);

    // 1) 依据业务消息携带的轮次标记,在处理业务效果之前补做本地截面
    for (const rid of msg.rounds) {
      if (this.rounds.has(rid) || this.ended.has(rid)) continue;
      if (this.rounds.size >= this.maxRounds) {
        this.ended.set(rid, { outcome: 'failed', reason: 'capacity' });
        this.evictEnded();
        this.failedCb?.(rid, 'capacity');
        continue;
      }
      const round = this.newRound(rid, null, null, this.epoch);
      this.record(round);
    }

    // 2) 记录日志,供未来轮次在记录时补分类
    this.receivedLog.push({ from: msg.from, seq: msg.seq, rounds: [...msg.rounds] });

    // 3) 对所有活动轮次做在途分类:标记中不含该轮 => 截面前发送、截面后到达
    for (const round of this.rounds.values()) {
      if (round.reported) continue;
      if (msg.rounds.includes(round.id)) continue;
      const ch = this.channel(round, msg.from);
      if (ch.classified.has(msg.seq)) continue;
      ch.classified.add(msg.seq);
      ch.inTransit.push({ seq: msg.seq, payload: msg.payload });
    }

    // 4) 同步完成业务处理(回调内可能继续发送业务消息)
    this.eventCb?.({ type: 'deliver-business', from: msg.from, seq: msg.seq, payload: msg.payload });
    this.onBusinessFn({ from: msg.from, seq: msg.seq, payload: msg.payload });

    // 5) 分类进度可能使某些通道完成证明
    for (const round of this.rounds.values()) this.maybeReport(round);
  }

  // ---------- 控制消息 ----------

  private receiveAnnounce(msg: AnnounceMessage): void {
    const ended = this.ended.get(msg.round);
    if (ended) {
      // 已失败的轮次:通知发起者,避免其空等
      if (ended.outcome === 'failed' && msg.from !== this.id) {
        this.transport.send(this.id, msg.from, {
          kind: 'abort',
          from: this.id,
          round: msg.round,
          reason: ended.reason ?? 'cancelled',
        });
      }
      return;
    }
    const existing = this.rounds.get(msg.round);
    if (existing) {
      if (!existing.roster) {
        // 先前由业务消息标记触发记录的轮次,现在补全名单与代次
        if (msg.epoch !== this.epoch) {
          this.failRound(existing.id, 'authority-epoch');
          return;
        }
        existing.roster = [...msg.roster];
        existing.initiator = msg.from;
        existing.epoch = msg.epoch;
        for (const p of msg.roster) if (p !== this.id) this.channel(existing, p);
        this.sendChannelReports(existing);
        this.maybeReport(existing);
      }
      return;
    }
    if (msg.epoch !== this.epoch) {
      // 代次不匹配:拒绝并向发起者报告失败
      this.transport.send(this.id, msg.from, {
        kind: 'abort',
        from: this.id,
        round: msg.round,
        reason: 'authority-epoch',
      });
      return;
    }
    if (this.rounds.size >= this.maxRounds) {
      this.ended.set(msg.round, { outcome: 'failed', reason: 'capacity' });
      this.evictEnded();
      this.transport.send(this.id, msg.from, {
        kind: 'abort',
        from: this.id,
        round: msg.round,
        reason: 'capacity',
      });
      this.failedCb?.(msg.round, 'capacity');
      return;
    }
    const round = this.newRound(msg.round, [...msg.roster], msg.from, msg.epoch);
    this.record(round);
    this.sendChannelReports(round);
    this.maybeReport(round);
  }

  private receiveChannelReport(msg: ChannelReportMessage): void {
    const round = this.rounds.get(msg.round);
    if (!round) {
      // 控制消息可能先于公告到达,暂存;轮次已结束则直接丢弃
      if (!this.ended.has(msg.round)) {
        const list = this.pendingReports.get(msg.round) ?? [];
        list.push({ from: msg.from, count: msg.count });
        this.pendingReports.set(msg.round, list);
      }
      return;
    }
    this.channel(round, msg.from).expected = msg.count;
    this.maybeReport(round);
  }

  private receiveLocalReport(msg: LocalReportMessage): void {
    const round = this.rounds.get(msg.round);
    if (!round || round.initiator !== this.id || !round.collected) return;
    if (round.collected.has(msg.from)) return; // 重复报告去重
    round.collected.set(msg.from, msg);
    const roster = round.roster;
    if (!roster || round.collected.size < roster.length) return;

    // 汇总全局状态:各节点本地截面 + 截面之间的在途消息
    const states: Record<NodeId, Payload> = {};
    const channels: Record<string, ChannelRecord> = {};
    for (const n of roster) {
      for (const m of roster) {
        if (n !== m) channels[`${n}->${m}`] = { from: n, to: m, messages: [] };
      }
    }
    for (const rep of round.collected.values()) {
      states[rep.from] = rep.state;
      for (const c of rep.channels) {
        channels[`${c.from}->${rep.from}`] = { from: c.from, to: rep.from, messages: c.messages };
      }
    }
    const result: SnapshotResult = {
      roundId: round.id,
      epoch: round.epoch,
      roster: [...roster],
      states,
      channels,
    };
    this.finishRound(round, 'completed');
    for (const peer of roster) {
      if (peer !== this.id) {
        this.transport.send(this.id, peer, { kind: 'round-done', from: this.id, round: round.id });
      }
    }
    this.completeCb?.(result);
  }

  private receiveAbort(msg: AbortMessage): void {
    const round = this.rounds.get(msg.round);
    if (round) {
      this.failRound(msg.round, msg.reason);
      return;
    }
    // 尚未知晓的轮次被中止:记住结局,拒绝后续迟到的公告
    if (!this.ended.has(msg.round)) {
      this.ended.set(msg.round, { outcome: 'failed', reason: msg.reason });
      this.evictEnded();
    }
    this.pendingReports.delete(msg.round);
  }

  private receiveRoundDone(msg: RoundDoneMessage): void {
    const round = this.rounds.get(msg.round);
    if (round) this.finishRound(round, 'completed');
    else if (!this.ended.has(msg.round)) {
      this.ended.set(msg.round, { outcome: 'completed' });
      this.evictEnded();
    }
    this.pendingReports.delete(msg.round);
  }

  // ---------- 内部 ----------

  private newRound(id: RoundId, roster: NodeId[] | null, initiator: NodeId | null, epoch: number): RoundState {
    const round: RoundState = {
      id,
      epoch,
      initiator,
      roster,
      state: null,
      sentAtRecord: new Map(),
      channels: new Map(),
      reportsSent: false,
      reported: false,
      collected: null,
    };
    this.rounds.set(id, round);
    if (roster) for (const p of roster) if (p !== this.id) this.channel(round, p);
    const pending = this.pendingReports.get(id);
    if (pending) {
      for (const pr of pending) this.channel(round, pr.from).expected = pr.count;
      this.pendingReports.delete(id);
    }
    return round;
  }

  /** 记录本地截面:捕获状态,并把截面前已到达的消息补分类为“已吸收” */
  private record(round: RoundState): void {
    round.state = this.captureStateFn();
    round.sentAtRecord = new Map(this.sentCount);
    this.eventCb?.({ type: 'record', round: round.id });
    for (const entry of this.receivedLog) {
      if (entry.rounds.includes(round.id)) continue;
      const ch = this.channel(round, entry.from);
      if (ch.classified.has(entry.seq)) continue;
      ch.classified.add(entry.seq);
      ch.absorbed++;
    }
  }

  private channel(round: RoundState, peer: NodeId): ChannelState {
    let ch = round.channels.get(peer);
    if (!ch) {
      ch = { expected: null, absorbed: 0, inTransit: [], classified: new Set() };
      round.channels.set(peer, ch);
    }
    return ch;
  }

  private sendChannelReports(round: RoundState): void {
    if (round.reportsSent || !round.roster) return;
    round.reportsSent = true;
    for (const peer of round.roster) {
      if (peer === this.id) continue;
      this.transport.send(this.id, peer, {
        kind: 'channel-report',
        from: this.id,
        round: round.id,
        count: round.sentAtRecord.get(peer) ?? 0,
      });
    }
  }

  /**
   * 完成证明:每个邻居截面前发来的消息都已分类(分类数 == 发送方计数),
   * 才向发起者上报本地截面与各入通道的在途消息。
   */
  private maybeReport(round: RoundState): void {
    if (round.reported || !round.roster || !round.reportsSent) return;
    for (const peer of round.roster) {
      if (peer === this.id) continue;
      const ch = round.channels.get(peer);
      if (!ch || ch.expected === null || ch.classified.size !== ch.expected) return;
    }
    round.reported = true;
    const report: LocalReportMessage = {
      kind: 'local-report',
      from: this.id,
      round: round.id,
      state: round.state,
      channels: round.roster
        .filter((p) => p !== this.id)
        .map((p) => ({
          from: p,
          messages: this.channel(round, p).inTransit.map((m) => ({ seq: m.seq, payload: m.payload })),
        })),
    };
    if (round.initiator === this.id) this.receiveLocalReport(report);
    else if (round.initiator !== null) this.transport.send(this.id, round.initiator, report);
    // 参与者保留轮次状态直到 round-done/abort,期间继续携带轮次标记
  }

  private failRound(roundId: RoundId, reason: FailReason): void {
    const round = this.rounds.get(roundId);
    if (round) this.rounds.delete(roundId);
    if (this.ended.has(roundId)) return;
    this.ended.set(roundId, { outcome: 'failed', reason });
    this.evictEnded();
    if (round) {
      if (round.initiator === this.id && round.roster) {
        for (const peer of round.roster) {
          if (peer !== this.id) {
            this.transport.send(this.id, peer, { kind: 'abort', from: this.id, round: roundId, reason });
          }
        }
      } else if (round.initiator && round.initiator !== this.id) {
        this.transport.send(this.id, round.initiator, { kind: 'abort', from: this.id, round: roundId, reason });
      }
    }
    this.failedCb?.(roundId, reason);
  }

  /** 轮次结束:回收通道载荷与轮次标记(不再出现在后续业务消息标记中) */
  private finishRound(round: RoundState, outcome: 'completed' | 'failed'): void {
    this.rounds.delete(round.id);
    this.ended.set(round.id, { outcome });
    this.evictEnded();
  }

  private evictEnded(): void {
    while (this.ended.size > ENDED_LIMIT) {
      const oldest = this.ended.keys().next().value;
      if (oldest === undefined) break;
      this.ended.delete(oldest);
    }
  }
}
