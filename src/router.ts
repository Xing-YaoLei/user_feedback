/**
 * RoutingDomain —— 单个 Broker 域的路径向量路由状态机。
 *
 * 防迟到消息的三道独立闸门：
 *   1. 会话代次（信封 sessionGen）：会话重建后旧会话上的消息直接丢弃；
 *   2. 来源重启代次（source.gen）：观察到较新代次后，旧代次来源信息失效；
 *   3. 公告版本流（邻居 × 目的地 → 最大已收版本）：旧版本/重复消息幂等忽略。
 *
 * 选路顺序：总代价 → 跳数 → 域 ID 序列字典序，结果确定唯一。
 */
import type {
  Announcement,
  Candidate,
  ForwardResult,
  NeighborSession,
  Request,
  RouteMessage,
  SelectedRoute,
  SessionEnvelope,
  SourceId,
  Summary,
  SummaryEntry,
  Withdrawal,
} from './types.ts';
import {
  assertNonNegativeIntCost,
  compareRanked,
  isAcceptablePath,
  sameSelectedRoute,
  type RankedCandidate,
} from './path-utils.ts';
import type { TraceLog } from './trace.ts';
import type { Transport } from './network.ts';

interface StreamState {
  /** 该邻居版本流上观察到的最大来源代次 */
  gen: number;
  /** 观察水位：该流上见过的最大版本号（含公告与撤销，仅用于识别迟到消息） */
  observedVersion: number;
  /** 已应用公告的版本号；null 表示当前未持有该邻居的候选 */
  appliedAnnounceVersion: number | null;
  /** 已应用撤销的版本号；null 表示尚未应用过撤销 */
  appliedWithdrawVersion: number | null;
}

type RibKey = string; // `${neighborId}::${destination}`

function ribKey(neighborId: string, destination: string): RibKey {
  return `${neighborId}::${destination}`;
}

export interface RoutingDomainOptions {
  id: string;
  transport: Transport;
  trace: TraceLog;
  /** 周期摘要间隔（毫秒）；<=0 表示不安排周期任务 */
  summaryIntervalMs?: number;
  /**
   * 全网连通性验证器（由联邦编排器注入）：
   * 校验一条完整域路径上的每一跳当前都是活动链路。
   * 缺省退化为只做本地静态路径校验。
   */
  pathValidator?: (path: readonly string[]) => boolean;
}

export class RoutingDomain {
  readonly id: string;
  /** 当前重启代次，初始为 1，每次 restart() 单调 +1 */
  private gen = 1;
  private readonly transport: Transport;
  private readonly trace: TraceLog;
  private readonly summaryIntervalMs: number;
  private readonly pathValidator: (path: readonly string[]) => boolean;
  private periodicTimer: (() => void) | null = null;

  private readonly neighbors = new Map<string, NeighborSession>();
  /** 本域拥有的目的地集合 */
  private readonly owned = new Set<string>();
  /** RIB：每个 (邻居, 目的地) 至多一条候选 */
  private readonly rib = new Map<RibKey, Candidate>();
  /** 当前选定路由：目的地 -> 最优路由 */
  private readonly selected = new Map<string, SelectedRoute>();
  /** 入向版本流状态：邻居 -> 目的地 -> 流状态（跨会话保留，防止旧会话回流） */
  private readonly streams = new Map<string, Map<string, StreamState>>();
  /** 出向版本流：目的地 -> 已发送的最大版本号 */
  private readonly outboundVersions = new Map<string, number>();
  /** 出向撤销需要的来源身份：目的地 -> 最近选定路由的来源 */
  private readonly lastSource = new Map<string, SourceId>();
  /** 实际向各邻居公告过的目的地集合（邻居 -> 目的地集合），用于安全反向撤销 */
  private readonly advertisedTo = new Map<string, Set<string>>();
  /** 批量处理深度：>0 时重选只登记目的地，批次结束统一重算与公告 */
  private batchDepth = 0;
  private readonly batchPending = new Set<string>();
  /**
   * Hold-down 抑制表：目的地 -> 抑制到期逻辑时间。
   * 进入不可达后在抑制窗口内忽略邻居对该目的地的公告，
   * 阻断「互相重公告失效路由」的计数到无穷；
   * 更新的来源代次（重启）或显式撤销不受抑制。
   */
  private readonly holdDownUntil = new Map<string, number>();
  /** 每个目的地全网观察到的最大来源代次（hold-down 放行重启公告的依据） */
  private readonly destSourceGen = new Map<string, number>();
  /**
   * Hold-down 窗口（逻辑毫秒）。需覆盖失效信息在网络直径内的传播时间，
   * 但远小于一次显式会话重建的时间尺度；会话重建会主动解除抑制。
   */
  private static readonly HOLD_DOWN_MS = 60;

  constructor(opts: RoutingDomainOptions) {
    this.id = opts.id;
    this.transport = opts.transport;
    this.trace = opts.trace;
    this.summaryIntervalMs = opts.summaryIntervalMs ?? 0;
    // 缺省验证器：静态合法性（来源首跳、无重复、不含本域）
    this.pathValidator =
      opts.pathValidator ??
      ((path) => isAcceptablePath(path, { stableId: path[0] ?? '', gen: 0 }, this.id));
  }

  selfSource(): SourceId {
    return { stableId: this.id, gen: this.gen };
  }

  currentGen(): number {
    return this.gen;
  }

  // ---------------------------------------------------------------- 邻居管理

  addNeighbor(neighborId: string, linkCost: number): void {
    assertNonNegativeIntCost(linkCost);
    if (this.neighbors.has(neighborId)) {
      throw new Error(`邻居 ${neighborId} 已存在`);
    }
    this.neighbors.set(neighborId, {
      neighborId,
      sessionGen: 0,
      peerSessionGen: 0,
      linkCost,
      active: false,
    });
  }

  hasNeighbor(neighborId: string): boolean {
    return this.neighbors.has(neighborId);
  }

  isNeighborActive(neighborId: string): boolean {
    return this.neighbors.get(neighborId)?.active === true;
  }

  getNeighbor(neighborId: string): NeighborSession | undefined {
    return this.neighbors.get(neighborId);
  }

  neighborIds(): string[] {
    return [...this.neighbors.keys()];
  }

  /**
   * 会话建立（编排器统一分配两端会话代次后调用）：
   * 记录本端/对端会话代次，清除该邻居旧候选，
   * 并立即交换摘要以补齐遗漏（重新收敛）。
   */
  activateSession(neighborId: string, ownSessionGen: number, peerSessionGen: number): void {
    const s = this.neighbors.get(neighborId);
    if (!s) throw new Error(`未知邻居 ${neighborId}`);
    if (ownSessionGen <= s.sessionGen) {
      throw new Error(`会话代次必须单调递增: ${neighborId}`);
    }
    s.sessionGen = ownSessionGen;
    s.peerSessionGen = peerSessionGen;
    s.active = true;
    this.dropNeighborCandidates(neighborId);
    // 会话重建代表一次显式重新同步：无条件解除全部 hold-down，
    // 使摘要/REQUEST 补齐的当前状态可以被正常接受（迟到消息仍由会话代次闸门拦截）。
    this.holdDownUntil.clear();
    this.trace.append({
      time: this.transport.now(),
      domain: this.id,
      type: 'session-up',
      peer: neighborId,
      extra: { sessionGen: s.sessionGen, peerSessionGen },
    });
    this.sendSummary(neighborId);
    if (this.periodicTimer === null && this.summaryIntervalMs > 0) {
      this.startPeriodicSummary();
    }
  }

  /** 便捷入口：本端自增会话代次（单域驱动、无编排器时使用） */
  sessionUp(neighborId: string, peerSessionGen: number): void {
    const s = this.neighbors.get(neighborId);
    if (!s) throw new Error(`未知邻居 ${neighborId}`);
    this.activateSession(neighborId, s.sessionGen + 1, peerSessionGen);
  }

  /**
   * 会话断开：标记失活、清除该邻居学到/经其中转的全部候选，
   * 并立即毒化撤回当前选定路由。
   * 版本流状态保留——重建前到达的迟到消息仍会被旧会话代次拦截。
   */
  sessionDown(neighborId: string): void {
    const s = this.neighbors.get(neighborId);
    if (!s) return;
    s.active = false;
    const affected = this.dropNeighborCandidates(neighborId);
    this.trace.append({
      time: this.transport.now(),
      domain: this.id,
      type: 'session-down',
      peer: neighborId,
    });
    // 毒化后不主动选旧备选：旧备选可能同样依赖刚失效的邻居（计数到无穷）。
    // 路由恢复完全由后续新鲜公告触发的 reselect 驱动；真不可达时保持 null。
    this.batch(() => {
      for (const dest of affected) this.poison(dest, 'session-down');
    });
  }

  /**
   * 清除从某邻居学到的候选，并额外清除所有「路径经该邻居中转」的候选
   * （即便这些候选是从其他邻居学到的——该邻居已不可达，中转路径必然失效）。
   */
  private dropNeighborCandidates(neighborId: string): string[] {
    const affected: string[] = [];
    for (const [key, cand] of this.rib) {
      const viaNeighbor =
        cand.learnedFrom === neighborId || cand.path.includes(neighborId);
      if (viaNeighbor) {
        affected.push(cand.destination);
        this.rib.delete(key);
      }
    }
    // 邻居会话终止：清除与该邻居相关的公告标记
    this.advertisedTo.delete(neighborId);
    return [...new Set(affected)];
  }

  /** 毒化：立即撤销当前选定路由、进入 hold-down 并向所有活动邻居公告撤回 */
  private poison(destination: string, reason: string): void {
    const prev = this.selected.get(destination) ?? null;
    if (!prev) {
      // 即便当前无选定路由，也对仍残留候选的目的地施加 hold-down
      this.armHoldDown(destination);
      return;
    }
    this.selected.delete(destination);
    this.armHoldDown(destination);
    this.trace.append({
      time: this.transport.now(),
      domain: this.id,
      type: 'route-withdrawn',
      destination,
      reason: `poison:${reason}`,
      path: prev.fullPath,
    });
    this.propagate(destination, null, reason);
  }

  private armHoldDown(destination: string): void {
    this.holdDownUntil.set(
      destination,
      this.transport.now() + RoutingDomain.HOLD_DOWN_MS,
    );
  }

  /** 链路代价变化：更新出向代价并对所有受影响目的地增量重选 */
  changeLinkCost(neighborId: string, newCost: number): void {
    assertNonNegativeIntCost(newCost);
    const s = this.neighbors.get(neighborId);
    if (!s) throw new Error(`未知邻居 ${neighborId}`);
    if (s.linkCost === newCost) return;
    s.linkCost = newCost;
    const affected = new Set<string>();
    for (const cand of this.rib.values()) {
      if (cand.learnedFrom === neighborId) {
        cand.linkCost = newCost;
        affected.add(cand.destination);
      }
    }
    for (const dest of this.owned) affected.add(dest);
    this.batch(() => {
      for (const dest of affected) this.reselect(dest, 'link-cost-change');
    });
  }

  // ---------------------------------------------------------------- 目的地

  addOwnedDestination(destination: string): void {
    if (this.owned.has(destination)) return;
    this.owned.add(destination);
    this.reselect(destination, 'local-added');
  }

  removeOwnedDestination(destination: string): void {
    if (!this.owned.has(destination)) return;
    this.owned.delete(destination);
    // 本地目的地消失：若仍有学习到的候选则切为转发路由，否则撤销
    this.reselect(destination, 'local-removed');
  }

  isOwned(destination: string): boolean {
    return this.owned.has(destination);
  }

  // ---------------------------------------------------------------- 重启

  /**
   * 域重启：稳定 ID 不变、重启代次 +1；清空全部学习状态与选定路由，
   * 本地目的地保留并以新代次重新始发。调用方负责先把邻居会话断开。
   */
  restart(): number {
    this.gen += 1;
    this.rib.clear();
    const destinations = [...this.selected.keys()];
    this.selected.clear();
    this.lastSource.clear();
    this.trace.append({
      time: this.transport.now(),
      domain: this.id,
      type: 'restart',
      extra: { gen: this.gen },
    });
    this.batch(() => {
      for (const dest of destinations) {
        if (this.owned.has(dest)) this.reselect(dest, 'restart-local');
        else {
          this.trace.append({
            time: this.transport.now(),
            domain: this.id,
            type: 'route-withdrawn',
            destination: dest,
            reason: 'restart',
          });
        }
      }
    });
    return this.gen;
  }

  // ---------------------------------------------------------------- 入向消息

  /** 传输层回调入口：先做会话代次闸门，再分派具体消息；单条消息整体批量处理 */
  receive(from: string, envelope: SessionEnvelope): void {
    const s = this.neighbors.get(from);
    if (!s || !s.active) return; // 未知或已失活邻居：静默丢弃
    if (envelope.sessionGen !== s.peerSessionGen) {
      // 旧会话上的迟到消息：会话代次不匹配，拒绝
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        peer: from,
        reason: 'stale-session-generation',
      });
      return;
    }
    this.batch(() => this.dispatch(from, envelope.payload));
  }

  /** 批量执行：批次内多次 reselect 合并，结束后统一重算并只公告最终状态 */
  private batch(fn: () => void): void {
    this.batchDepth += 1;
    try {
      fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchPending.size > 0) {
        const pending = [...this.batchPending];
        this.batchPending.clear();
        for (const dest of pending) this.reselect(dest, 'batch-flush');
      }
    }
  }

  private dispatch(from: string, msg: RouteMessage): void {
    switch (msg.kind) {
      case 'announce':
        this.onAnnounce(from, msg);
        break;
      case 'withdraw':
        this.onWithdraw(from, msg);
        break;
      case 'summary':
        this.onSummary(from, msg);
        break;
      case 'request':
        this.onRequest(from, msg);
        break;
    }
  }

  private streamOf(neighborId: string, destination: string): StreamState {
    let perDest = this.streams.get(neighborId);
    if (!perDest) {
      perDest = new Map();
      this.streams.set(neighborId, perDest);
    }
    let st = perDest.get(destination);
    if (!st) {
      st = {
        gen: 0,
        observedVersion: 0,
        appliedAnnounceVersion: null,
        appliedWithdrawVersion: null,
      };
      perDest.set(destination, st);
    }
    return st;
  }

  private onAnnounce(from: string, msg: Announcement): void {
    const s = this.neighbors.get(from)!;
    const st = this.streamOf(from, msg.destination);

    // Hold-down 闸门：抑制窗口内忽略同代次的可达公告，防止失效路由互相重公告。
    // 仅当公告带来更新的来源代次（来源重启）时放行。
    const until = this.holdDownUntil.get(msg.destination);
    const knownGen = this.destSourceGen.get(msg.destination) ?? 0;
    if (
      until !== undefined &&
      this.transport.now() < until &&
      msg.source.gen <= knownGen
    ) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'hold-down',
        path: msg.path,
      });
      return;
    }

    // 闸门 2：来源重启代次
    if (msg.source.gen < st.gen) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'stale-source-generation',
        extra: { gotGen: msg.source.gen, knownGen: st.gen },
      });
      return;
    }
    // 闸门 3：版本流。观察水位识别迟到/重复；已应用水位保证幂等，
    // 但不阻止「丢失后经 REQUEST 重发」的当前状态补齐。
    if (msg.source.gen === st.gen && msg.version < st.observedVersion) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'stale-version',
        extra: { gotVersion: msg.version, observedVersion: st.observedVersion },
      });
      return;
    }
    // 重复判定以 RIB 实际持有候选为准：同版本公告若 RIB 已无该候选
    // （会话断开/撤销后经摘要 REQUEST 重发），必须允许重新学习。
    if (
      msg.source.gen === st.gen &&
      msg.version === st.observedVersion &&
      st.appliedAnnounceVersion === msg.version &&
      this.rib.has(ribKey(from, msg.destination))
    ) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'duplicate-version',
        extra: { gotVersion: msg.version },
      });
      return;
    }
    if (!Number.isInteger(msg.cost) || msg.cost < 0) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'invalid-cost',
      });
      return;
    }
    // 路径合法性：含本域或重复域一律拒绝采用
    if (!isAcceptablePath(msg.path, msg.source, this.id)) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'path-loop-or-self',
        path: msg.path,
      });
      return;
    }
    // 全网连通性：路径上每一跳当前都必须是活动链路
    if (!this.pathValidator([...msg.path, this.id])) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'inactive-path-segment',
        path: msg.path,
      });
      return;
    }

    st.gen = msg.source.gen;
    st.observedVersion = Math.max(st.observedVersion, msg.version);
    st.appliedAnnounceVersion = msg.version;
    st.appliedWithdrawVersion = null;
    this.destSourceGen.set(
      msg.destination,
      Math.max(this.destSourceGen.get(msg.destination) ?? 0, msg.source.gen),
    );

    const candidate: Candidate = {
      destination: msg.destination,
      learnedFrom: from,
      source: { stableId: msg.source.stableId, gen: msg.source.gen },
      path: [...msg.path],
      version: msg.version,
      announcedCost: msg.cost,
      linkCost: s.linkCost,
    };
    this.rib.set(ribKey(from, msg.destination), candidate);
    this.trace.append({
      time: this.transport.now(),
      domain: this.id,
      type: 'announce-accepted',
      destination: msg.destination,
      peer: from,
      path: msg.path,
      extra: { version: msg.version, cost: msg.cost },
    });
    this.reselect(msg.destination, 'announce');
  }

  private onWithdraw(from: string, msg: Withdrawal): void {
    const st = this.streamOf(from, msg.destination);
    if (msg.source.gen < st.gen) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'withdraw-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'stale-source-generation',
      });
      return;
    }
    if (msg.source.gen === st.gen && msg.version < st.observedVersion) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'withdraw-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'stale-version',
      });
      return;
    }
    if (
      msg.source.gen === st.gen &&
      msg.version === st.observedVersion &&
      st.appliedWithdrawVersion === msg.version
    ) {
      // 重复撤销：幂等忽略
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'withdraw-rejected',
        destination: msg.destination,
        peer: from,
        reason: 'duplicate-version',
      });
      return;
    }

    st.gen = msg.source.gen;
    st.observedVersion = Math.max(st.observedVersion, msg.version);
    st.appliedWithdrawVersion = msg.version;
    st.appliedAnnounceVersion = null;

    const key = ribKey(from, msg.destination);
    const existed = this.rib.delete(key);
    this.trace.append({
      time: this.transport.now(),
      domain: this.id,
      type: 'withdraw-accepted',
      destination: msg.destination,
      peer: from,
      extra: { version: msg.version, removedRib: existed ? 1 : 0 },
    });
    this.reselect(msg.destination, 'withdraw');
  }

  private onSummary(from: string, msg: Summary): void {
    const s = this.neighbors.get(from)!;
    // 摘要携带对端自身当前代次；旧代次摘要整体拒绝
    const knownSpeakerGen = this.knownSpeakerGen(from, msg.speaker.stableId);
    if (knownSpeakerGen !== null && msg.speaker.gen < knownSpeakerGen) {
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'announce-rejected',
        peer: from,
        reason: 'stale-summary-generation',
      });
      return;
    }
    for (const entry of msg.entries) {
      const st = this.streamOf(from, entry.destination);
      const ribExists = this.rib.has(ribKey(from, entry.destination));
      const iOwn = this.owned.has(entry.destination);
      const iHaveRoute = this.selected.has(entry.destination);

      // 对端是该目的地的拥有者（来源稳定 ID == 对端）：它是权威方，
      // 本域缺路由时只能请求补齐，绝不能反向撤销权威方。
      const peerOwnsDestination = entry.source.stableId === from;
      // 本域出向版本流：本域此前就该目的地向邻居发出过更新（含撤销）。
      const myOutbound = this.outboundVersions.get(entry.destination) ?? 0;
      // 本域出向版本严格新于对端摘要版本：对端尚未收到本域的最新状态
      //（典型：本域撤销在链路上丢失）。
      const peerMissingMyUpdate = myOutbound > entry.version;
      // 必须确实曾向该邻居成功公告过该路由，反向撤销才安全
      //（水平分割下叶子节点不会向上游回公告，从而不会误撤上游的真实路由）。
      const advertisedBefore = this.advertisedTo.get(from)?.has(entry.destination) === true;

      // 反向不一致：本域无路由、对端非权威、对端缺失本域更新且本域确曾公告。
      if (
        !iOwn &&
        !iHaveRoute &&
        !peerOwnsDestination &&
        peerMissingMyUpdate &&
        advertisedBefore
      ) {
        const source = this.lastSource.get(entry.destination) ?? entry.source;
        const prevVersion = this.outboundVersions.get(entry.destination) ?? 0;
        const version = prevVersion + 1;
        this.outboundVersions.set(entry.destination, version);
        const wd: Withdrawal = {
          kind: 'withdraw',
          destination: entry.destination,
          source,
          version,
        };
        this.sendEnvelope(from, wd);
        this.trace.append({
          time: this.transport.now(),
          domain: this.id,
          type: 'withdraw-sent',
          peer: from,
          destination: entry.destination,
          reason: 'summary-reconcile',
          extra: { version },
        });
        if (entry.source.gen > st.gen) st.gen = entry.source.gen;
        continue;
      }

      // 缺口判定：本地无候选，或对端摘要的代次/版本比观察水位更新
      const gap =
        !ribExists ||
        entry.source.gen > st.gen ||
        (entry.source.gen === st.gen && entry.version > st.observedVersion);
      if (entry.source.gen > st.gen) st.gen = entry.source.gen;
      if (gap) {
        const req: Request = { kind: 'request', destination: entry.destination };
        this.sendEnvelope(from, req);
        this.trace.append({
          time: this.transport.now(),
          domain: this.id,
          type: 'request-sent',
          peer: from,
          destination: entry.destination,
        });
      }
    }
    // 对端摘要中缺失、但本域仍从该邻居保留着候选的目的地：请求核对
    const summarized = new Set(msg.entries.map((e) => e.destination));
    for (const cand of this.rib.values()) {
      if (cand.learnedFrom === from && !summarized.has(cand.destination)) {
        const req: Request = { kind: 'request', destination: cand.destination };
        this.sendEnvelope(from, req);
        this.trace.append({
          time: this.transport.now(),
          domain: this.id,
          type: 'request-sent',
          peer: from,
          destination: cand.destination,
          reason: 'missing-in-summary',
        });
      }
    }
  }

  /**
   * 已知对端（稳定 ID）的最大代次：取与该邻居相关版本流中的最大代次。
   * 邻居稳定 ID 与会话邻居 ID 一致（每域一个稳定身份）。
   */
  private knownSpeakerGen(_from: string, stableId: string): number | null {
    let max: number | null = null;
    for (const [neighborId, perDest] of this.streams) {
      if (neighborId !== stableId) continue;
      for (const st of perDest.values()) {
        if (max === null || st.gen > max) max = st.gen;
      }
    }
    return max;
  }

  private onRequest(from: string, msg: Request): void {
    const route = this.selected.get(msg.destination);
    // REQUEST 响应总是沿出向版本流分配一个新版本号，
    // 确保即便此前同状态的消息丢失，重发也不会被对端观察水位当作迟到消息。
    const prevVersion = this.outboundVersions.get(msg.destination) ?? 0;
    const version = prevVersion + 1;
    this.outboundVersions.set(msg.destination, version);
    if (route) {
      const ann: Announcement = {
        kind: 'announce',
        destination: msg.destination,
        source: route.source,
        path: route.fullPath,
        cost: route.totalCost,
        version,
      };
      this.sendEnvelope(from, ann);
      let set = this.advertisedTo.get(from);
      if (!set) {
        set = new Set();
        this.advertisedTo.set(from, set);
      }
      set.add(msg.destination);
    } else {
      const source = this.lastSource.get(msg.destination);
      if (source) {
        const wd: Withdrawal = {
          kind: 'withdraw',
          destination: msg.destination,
          source,
          version,
        };
        this.sendEnvelope(from, wd);
      }
    }
  }

  // ---------------------------------------------------------------- 选路与传播

  /** 对单个目的地执行增量重选，并在结果变化时向全部活动邻居传播 */
  private reselect(destination: string, reason: string): void {
    if (this.batchDepth > 0) {
      this.batchPending.add(destination);
      return;
    }
    const ranked: RankedCandidate[] = [];
    const staleKeys: RibKey[] = [];
    for (const [key, cand] of this.rib) {
      if (cand.destination !== destination) continue;
      const candidateFullPath = [...cand.path, this.id];
      // 重校验：静态合法性 + 全网连通性。拓扑变化后旧候选可能已含本域、
      // 出现重复域，或路径上某段链路已经失活。
      if (
        !isAcceptablePath(cand.path, cand.source, this.id) ||
        !this.pathValidator(candidateFullPath)
      ) {
        staleKeys.push(key);
        this.trace.append({
          time: this.transport.now(),
          domain: this.id,
          type: 'route-withdrawn',
          destination,
          reason: 'stale-candidate-purged',
          path: cand.path,
        });
        continue;
      }
      // 总代价 = 邻居公告的累计代价 + 本域到邻居的链路代价
      const totalCost = cand.announcedCost + cand.linkCost;
      ranked.push({ ...cand, fullPath: candidateFullPath, totalCost });
    }
    for (const key of staleKeys) this.rib.delete(key);

    let next: SelectedRoute | null = null;
    if (this.owned.has(destination)) {
      // 本地始发：代价 0、单域路径，始终优先于任何学习候选
      next = {
        destination,
        source: this.selfSource(),
        fullPath: [this.id],
        totalCost: 0,
        hops: 0,
        local: true,
        learnedFrom: null,
        version: this.gen,
      };
    } else if (ranked.length > 0) {
      ranked.sort(compareRanked);
      const best = ranked[0];
      next = {
        destination,
        source: best.source,
        fullPath: best.fullPath,
        totalCost: best.totalCost,
        hops: best.fullPath.length - 1,
        local: false,
        learnedFrom: best.learnedFrom,
        version: best.version,
      };
    }

    const prev = this.selected.get(destination) ?? null;
    if (sameSelectedRoute(prev, next)) return;

    if (next) {
      this.selected.set(destination, next);
      this.lastSource.set(destination, next.source);
      // 重新选到有效路由：解除 hold-down
      this.holdDownUntil.delete(destination);
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'route-selected',
        destination,
        path: next.fullPath,
        reason,
        extra: { totalCost: next.totalCost, hops: next.hops },
      });
    } else {
      this.selected.delete(destination);
      // 路由消失：布防 hold-down，阻断邻居间失效路由互相重公告
      this.armHoldDown(destination);
      this.trace.append({
        time: this.transport.now(),
        domain: this.id,
        type: 'route-withdrawn',
        destination,
        reason,
      });
    }
    this.propagate(destination, next, reason);
  }

  /** 将本域当前选定路由（或撤销）公告给全部活动邻居 */
  private propagate(destination: string, route: SelectedRoute | null, _reason: string): void {
    const prevVersion = this.outboundVersions.get(destination) ?? 0;
    const version = prevVersion + 1;
    this.outboundVersions.set(destination, version);

    if (route) {
      const ann: Announcement = {
        kind: 'announce',
        destination,
        source: route.source,
        path: route.fullPath,
        cost: route.totalCost,
        version,
      };
      for (const s of this.neighbors.values()) {
        if (!s.active) continue;
        // 水平分割：不从学到该路由的邻居回公告，杜绝把路径带回来源方向
        if (route.learnedFrom === s.neighborId) continue;
        this.sendEnvelope(s.neighborId, ann);
        let set = this.advertisedTo.get(s.neighborId);
        if (!set) {
          set = new Set();
          this.advertisedTo.set(s.neighborId, set);
        }
        set.add(destination);
        this.trace.append({
          time: this.transport.now(),
          domain: this.id,
          type: 'announce-sent',
          destination,
          peer: s.neighborId,
          path: route.fullPath,
          extra: { version },
        });
      }
    } else {
      const source = this.lastSource.get(destination);
      if (!source) return; // 从未选过该目的地：无需撤销
      const wd: Withdrawal = { kind: 'withdraw', destination, source, version };
      for (const s of this.neighbors.values()) {
        if (!s.active) continue;
        this.sendEnvelope(s.neighborId, wd);
        // 注意：保留 advertisedTo 标记——撤销可能在链路上丢失，
        // 该标记用于后续摘要核对时识别「对端残留的是本域旧状态」。
        // 标记仅在会话断开（dropNeighborCandidates）时随邻居状态一并清除。
        this.trace.append({
          time: this.transport.now(),
          domain: this.id,
          type: 'withdraw-sent',
          destination,
          peer: s.neighborId,
          extra: { version },
        });
      }
    }
  }

  private sendEnvelope(to: string, payload: RouteMessage): void {
    const s = this.neighbors.get(to);
    if (!s || !s.active) return;
    const envelope: SessionEnvelope = { sessionGen: s.sessionGen, payload };
    this.transport.send(this.id, to, envelope);
  }

  private sendSummary(to: string): void {
    const entries: SummaryEntry[] = [];
    for (const [dest, route] of this.selected) {
      entries.push({
        destination: dest,
        source: route.source,
        version: this.outboundVersions.get(dest) ?? 1,
      });
    }
    const summary: Summary = { kind: 'summary', speaker: this.selfSource(), entries };
    this.sendEnvelope(to, summary);
    this.trace.append({
      time: this.transport.now(),
      domain: this.id,
      type: 'summary-sent',
      peer: to,
      extra: { entries: entries.length },
    });
  }

  private startPeriodicSummary(): void {
    const tick = (): void => {
      for (const s of this.neighbors.values()) {
        if (s.active) this.sendSummary(s.neighborId);
      }
      if (this.summaryIntervalMs > 0 && this.periodicTimer !== null) {
        this.transport.schedule(this.summaryIntervalMs, tick);
      }
    };
    this.periodicTimer = tick;
    this.transport.schedule(this.summaryIntervalMs, tick);
  }

  // ---------------------------------------------------------------- 只读视图

  getSelected(destination: string): SelectedRoute | null {
    return this.selected.get(destination) ?? null;
  }

  selectedRoutes(): ReadonlyMap<string, SelectedRoute> {
    return this.selected;
  }

  ribCandidates(): readonly Candidate[] {
    return [...this.rib.values()];
  }

  /** 数据面：逐跳校验下一域与实际链路，返回完整转发轨迹或可定位断点 */
  forward(
    destination: string,
    routingTable: ReadonlyMap<string, RoutingDomain>,
    attempt = 0,
  ): ForwardResult {
    const trace: string[] = [this.id];
    const visited = new Set<string>([this.id]);
    let current = this;

    for (;;) {
      // 到达拥有该目的地的域：交付成功
      if (current.owned.has(destination)) {
        this.traceForward(destination, trace, attempt);
        return { ok: true, trace: [...trace], destination };
      }
      const route = current.getSelected(destination);
      if (!route) {
        this.traceForward(destination, trace, attempt);
        return {
          ok: false,
          breakDomain: current.id,
          expectedNext: null,
          reason: 'no-route',
          trace: [...trace],
          destination,
        };
      }
      // 逐跳校验：本域必须位于完整路径上，且下一跳取自路径相邻段
      const idx = route.fullPath.indexOf(current.id);
      if (idx < 0) {
        this.traceForward(destination, trace, attempt);
        return {
          ok: false,
          breakDomain: current.id,
          expectedNext: null,
          reason: 'path-mismatch',
          trace: [...trace],
          destination,
        };
      }
      if (idx === 0) {
        this.traceForward(destination, trace, attempt);
        return {
          ok: false,
          breakDomain: current.id,
          expectedNext: null,
          reason: 'path-mismatch',
          trace: [...trace],
          destination,
        };
      }
      const nextHop = route.fullPath[idx - 1];
      const session = current.getNeighbor(nextHop);
      if (!session) {
        this.traceForward(destination, trace, attempt);
        return {
          ok: false,
          breakDomain: current.id,
          expectedNext: nextHop,
          reason: 'not-a-neighbor',
          trace: [...trace],
          destination,
        };
      }
      if (!session.active) {
        this.traceForward(destination, trace, attempt);
        return {
          ok: false,
          breakDomain: current.id,
          expectedNext: nextHop,
          reason: 'inactive-link',
          trace: [...trace],
          destination,
        };
      }
      if (visited.has(nextHop)) {
        this.traceForward(destination, trace, attempt);
        return {
          ok: false,
          breakDomain: current.id,
          expectedNext: nextHop,
          reason: 'loop-detected',
          trace: [...trace],
          destination,
        };
      }
      visited.add(nextHop);
      trace.push(nextHop);
      const nextRouter = routingTable.get(nextHop);
      if (!nextRouter) {
        this.traceForward(destination, trace, attempt);
        return {
          ok: false,
          breakDomain: current.id,
          expectedNext: nextHop,
          reason: 'not-a-neighbor',
          trace: [...trace],
          destination,
        };
      }
      current = nextRouter;
    }
  }

  private traceForward(destination: string, trace: readonly string[], attempt: number): void {
    trace.forEach((dom, idx) => {
      this.trace.append({
        time: this.transport.now(),
        domain: dom,
        type: 'forward',
        destination,
        extra: { step: idx, attempt },
      });
    });
  }
}
