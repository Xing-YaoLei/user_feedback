/**
 * 服务网格节点健康与选路模块。
 *
 * 模型概览：
 * - 每次尝试先 acquire / acquireProbe 领取凭证，完成后凭凭证 report 结果；
 * - 远端结果（success / remote-error）按完成时刻进入滑动窗口，
 *   评分 = 远端错误数 / 有效样本数；调用方取消与本地排队超时单独计数，不进窗口；
 * - 连续远端失败达到阈值 → 隔离；隔离名额有限，触顶后其余异常节点保持“待隔离”；
 * - 隔离期按连续隔离轮次指数退避（封顶）；到期后进入一轮受控探测；
 * - 探测轮限制并发，累计足够有效成功才恢复；任一远端失败或本轮截止到达 → 重新隔离；
 * - 取消 / 本地超时的探测归还名额以便补充；
 * - 凭证绑定节点代次与健康阶段，旧代次 / 旧阶段的迟到结果只进诊断记录，
 *   不能关闭新的隔离轮次，也不占用新一轮探测名额；
 * - 隔离名额释放后，按错误率（高→低）、节点ID（小→大）补入待隔离节点；
 * - 健康候选按地域优先级 + 节点ID 选路；无有效候选返回暂不可用；
 *   只有显式 allowDegraded 时才在待隔离节点中按失败评分 + 节点ID 稳定选择。
 *
 * 时钟由调用方注入（config.clock），所有时间推进（窗口淘汰、隔离到期、探测截止）
 * 在 acquire / acquireProbe / report / inspect / tick 时惰性求值。
 * 多个结果在同一时刻完成时，按 report 调用顺序逐个原子应用，
 * 因此状态转换与其后的选路结果彼此一致。
 */

export type Outcome = 'success' | 'remote-error' | 'cancelled' | 'local-timeout';

export type NodeState = 'healthy' | 'isolated' | 'probing' | 'pending';

export interface NodeSpec {
  id: string;
  region: string;
  /** 节点代次：代次变更视为新节点，旧代次凭证的迟到结果只进诊断 */
  generation: number;
}

export interface ServiceSpec {
  /** 地域优先级，靠前优先；未列出的地域排在最后 */
  regionPriority: string[];
  nodes: NodeSpec[];
}

export interface ProbePolicy {
  /** 一轮最多并发探测数 */
  concurrency: number;
  /** 恢复所需的累计有效成功数 */
  successThreshold: number;
  /** 本轮探测的截止时长（毫秒） */
  roundMs: number;
}

export interface RouterPolicy {
  /** 滑动统计窗口（毫秒） */
  windowMs: number;
  /** 连续远端失败阈值 */
  consecutiveFailureThreshold: number;
  /** 隔离数量上限（isolated + probing 占用名额，按服务计） */
  maxIsolations: number;
  /** 隔离期基础时长（毫秒） */
  baseIsolationMs: number;
  /** 连续隔离轮次的退避倍率 */
  isolationBackoffFactor: number;
  /** 隔离期封顶（毫秒） */
  maxIsolationMs: number;
  probe: ProbePolicy;
}

export interface RouterConfig {
  clock: () => number;
  policy: RouterPolicy;
  services: Record<string, ServiceSpec>;
}

export type CredentialKind = 'traffic' | 'probe';

export interface Credential {
  attemptId: string;
  service: string;
  nodeId: string;
  /** 领取时的节点代次 */
  generation: number;
  /** 领取时的健康阶段 */
  phase: number;
  kind: CredentialKind;
  /** 是否为降级选择的待隔离节点 */
  degraded: boolean;
  issuedAt: number;
}

export type AcquireResult =
  | { status: 'ok'; credential: Credential }
  | { status: 'unavailable' };

export type ProbeAcquireResult =
  | { status: 'ok'; credential: Credential }
  | { status: 'none' };

export type DiagnosticReason =
  | 'stale-phase'
  | 'stale-generation'
  | 'duplicate-report'
  | 'node-removed';

export interface DiagnosticRecord {
  at: number;
  service: string;
  nodeId: string;
  attemptId: string;
  outcome: Outcome;
  reason: DiagnosticReason;
}

export type RouterEventType =
  | 'isolated'
  | 'pending'
  | 'probe-round-started'
  | 'probe-issued'
  | 'probe-slot-returned'
  | 'recovered'
  | 're-isolated';

export interface RouterEvent {
  at: number;
  type: RouterEventType;
  service: string;
  nodeId: string;
  /** 隔离轮次 / 探测轮次 */
  round?: number;
  until?: number;
  deadline?: number;
  reason?: 'threshold' | 'probe-failure' | 'probe-deadline' | 'filled-from-pending';
  attemptId?: string;
}

export interface NodeSnapshot {
  id: string;
  region: string;
  generation: number;
  state: NodeState;
  phase: number;
  /** 失败评分 = 窗口内远端错误 / 有效样本；无有效样本时为 0 */
  score: number;
  validSamples: number;
  remoteErrors: number;
  consecutiveFailures: number;
  cancels: number;
  localTimeouts: number;
  isolation: { round: number; until: number } | null;
  probe: {
    round: number;
    deadline: number;
    inFlight: number;
    successes: number;
    /** 本轮实际发放的探测数量（含取消后补充） */
    issued: number;
  } | null;
}

export interface ServiceSnapshot {
  now: number;
  isolatedCount: number;
  maxIsolations: number;
  /** 健康候选（选路顺序） */
  candidates: string[];
  /** 待隔离节点（降级选择顺序） */
  degraded: string[];
  nodes: NodeSnapshot[];
}

interface Sample {
  t: number;
  kind: 'success' | 'remote-error';
}

interface ProbeRoundState {
  round: number;
  deadline: number;
  inFlight: number;
  successes: number;
  issued: number;
}

interface NodeEntry {
  id: string;
  region: string;
  generation: number;
  state: NodeState;
  phase: number;
  samples: Sample[];
  consecutiveFailures: number;
  isolationRound: number;
  isolationUntil: number;
  probeRoundCounter: number;
  probe: ProbeRoundState | null;
  cancels: number;
  localTimeouts: number;
}

interface ServiceEntry {
  regionPriority: string[];
  nodes: Map<string, NodeEntry>;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freshEntry(spec: NodeSpec, phase: number): NodeEntry {
  return {
    id: spec.id,
    region: spec.region,
    generation: spec.generation,
    state: 'healthy',
    phase,
    samples: [],
    consecutiveFailures: 0,
    isolationRound: 0,
    isolationUntil: 0,
    probeRoundCounter: 0,
    probe: null,
    cancels: 0,
    localTimeouts: 0,
  };
}

export class HealthRouter {
  #clock: () => number;
  #policy: RouterPolicy;
  #services = new Map<string, ServiceEntry>();
  #credentials = new Map<string, { credential: Credential; settled: boolean }>();
  #attemptSeq = 0;
  #events: RouterEvent[] = [];
  #diagnostics: DiagnosticRecord[] = [];

  constructor(config: RouterConfig) {
    this.#clock = config.clock;
    this.#policy = config.policy;
    for (const [name, spec] of Object.entries(config.services)) {
      const svc: ServiceEntry = {
        regionPriority: [...spec.regionPriority],
        nodes: new Map(),
      };
      for (const n of spec.nodes) svc.nodes.set(n.id, freshEntry(n, 0));
      this.#services.set(name, svc);
    }
  }

  /** 更新服务的节点集合；代次变更的节点按全新健康状态重置，旧凭证随之失效 */
  setNodes(service: string, nodes: NodeSpec[]): void {
    this.#advance();
    const svc = this.#requireService(service);
    const seen = new Set<string>();
    for (const spec of nodes) {
      seen.add(spec.id);
      const existing = svc.nodes.get(spec.id);
      if (existing && existing.generation === spec.generation) {
        existing.region = spec.region;
        continue;
      }
      svc.nodes.set(spec.id, freshEntry(spec, existing ? existing.phase + 1 : 0));
    }
    for (const id of [...svc.nodes.keys()]) {
      if (!seen.has(id)) svc.nodes.delete(id);
    }
    this.#fillPending(service, svc, this.#clock());
  }

  /**
   * 普通选路：健康候选按地域优先级 + 节点ID；无健康候选且显式 allowDegraded 时，
   * 在待隔离节点中按失败评分（低→高）+ 节点ID 稳定选择；否则返回暂不可用。
   */
  acquire(service: string, opts: { allowDegraded?: boolean } = {}): AcquireResult {
    this.#advance();
    const svc = this.#requireService(service);
    const now = this.#clock();
    const healthy = [...svc.nodes.values()].filter((n) => n.state === 'healthy');
    if (healthy.length > 0) {
      healthy.sort(
        (a, b) =>
          this.#regionRank(svc, a.region) - this.#regionRank(svc, b.region) ||
          compareId(a.id, b.id),
      );
      return this.#issue(service, healthy[0], 'traffic', false, now);
    }
    if (opts.allowDegraded) {
      const pending = [...svc.nodes.values()].filter((n) => n.state === 'pending');
      if (pending.length > 0) {
        pending.sort(
          (a, b) => this.#score(a).rate - this.#score(b).rate || compareId(a.id, b.id),
        );
        return this.#issue(service, pending[0], 'traffic', true, now);
      }
    }
    return { status: 'unavailable' };
  }

  /** 领取一个探测名额：探测中的节点按节点ID顺序、每轮最多并发 policy.probe.concurrency 个 */
  acquireProbe(service: string): ProbeAcquireResult {
    this.#advance();
    const svc = this.#requireService(service);
    const now = this.#clock();
    const probing = [...svc.nodes.values()]
      .filter(
        (n) =>
          n.state === 'probing' &&
          n.probe !== null &&
          n.probe.inFlight < this.#policy.probe.concurrency,
      )
      .sort((a, b) => compareId(a.id, b.id));
    if (probing.length === 0) return { status: 'none' };
    const node = probing[0];
    const round = node.probe!;
    round.issued += 1;
    round.inFlight += 1;
    const issued = this.#issue(service, node, 'probe', false, now);
    this.#emit({
      type: 'probe-issued',
      service,
      nodeId: node.id,
      round: round.round,
      attemptId: issued.credential.attemptId,
    });
    return issued;
  }

  /** 报告一次尝试的结果。未知凭证抛错；已结算 / 旧代次 / 旧阶段的凭证只进诊断记录 */
  report(credential: Credential, outcome: Outcome): void {
    this.#advance();
    const now = this.#clock();
    const rec = this.#credentials.get(credential.attemptId);
    if (!rec) throw new Error(`unknown credential: ${credential.attemptId}`);
    const svc = this.#services.get(credential.service);
    const node = svc?.nodes.get(credential.nodeId);
    if (rec.settled) {
      this.#diag(now, credential, outcome, 'duplicate-report');
      return;
    }
    rec.settled = true;
    if (!svc || !node) {
      this.#diag(now, credential, outcome, 'node-removed');
      return;
    }
    if (node.generation !== credential.generation) {
      this.#diag(now, credential, outcome, 'stale-generation');
      return;
    }
    if (node.phase !== credential.phase) {
      this.#diag(now, credential, outcome, 'stale-phase');
      return;
    }

    switch (outcome) {
      case 'cancelled':
        node.cancels += 1;
        if (credential.kind === 'probe' && node.probe) this.#returnProbeSlot(node, credential.service);
        return;
      case 'local-timeout':
        node.localTimeouts += 1;
        if (credential.kind === 'probe' && node.probe) this.#returnProbeSlot(node, credential.service);
        return;
      case 'success':
      case 'remote-error':
        node.samples.push({ t: now, kind: outcome });
        if (credential.kind === 'probe') {
          this.#settleProbe(credential.service, svc, node, outcome, now);
        } else {
          this.#settleTraffic(credential.service, svc, node, outcome, now);
        }
        return;
    }
  }

  /** 显式推进时钟驱动的状态迁移（隔离到期开探测、探测截止重新隔离、窗口淘汰） */
  tick(): void {
    this.#advance();
  }

  inspect(service: string): ServiceSnapshot {
    this.#advance();
    const svc = this.#requireService(service);
    const now = this.#clock();
    const nodes = [...svc.nodes.values()].sort((a, b) => compareId(a.id, b.id));
    const healthy = nodes
      .filter((n) => n.state === 'healthy')
      .sort(
        (a, b) =>
          this.#regionRank(svc, a.region) - this.#regionRank(svc, b.region) ||
          compareId(a.id, b.id),
      );
    const pending = nodes
      .filter((n) => n.state === 'pending')
      .sort((a, b) => this.#score(a).rate - this.#score(b).rate || compareId(a.id, b.id));
    return {
      now,
      isolatedCount: this.#isolatedCount(svc),
      maxIsolations: this.#policy.maxIsolations,
      candidates: healthy.map((n) => n.id),
      degraded: pending.map((n) => n.id),
      nodes: nodes.map((n) => this.#snapshot(n)),
    };
  }

  events(): RouterEvent[] {
    return this.#events.slice();
  }

  diagnostics(): DiagnosticRecord[] {
    return this.#diagnostics.slice();
  }

  // ---- 内部实现 ----

  #requireService(service: string): ServiceEntry {
    const svc = this.#services.get(service);
    if (!svc) throw new Error(`unknown service: ${service}`);
    return svc;
  }

  #regionRank(svc: ServiceEntry, region: string): number {
    const idx = svc.regionPriority.indexOf(region);
    return idx === -1 ? svc.regionPriority.length : idx;
  }

  #score(node: NodeEntry): { rate: number; valid: number; errors: number } {
    let errors = 0;
    for (const s of node.samples) if (s.kind === 'remote-error') errors += 1;
    const valid = node.samples.length;
    return { rate: valid === 0 ? 0 : errors / valid, valid, errors };
  }

  #backoffMs(round: number): number {
    const raw = this.#policy.baseIsolationMs * this.#policy.isolationBackoffFactor ** (round - 1);
    return Math.min(raw, this.#policy.maxIsolationMs);
  }

  #isolatedCount(svc: ServiceEntry): number {
    let count = 0;
    for (const n of svc.nodes.values()) {
      if (n.state === 'isolated' || n.state === 'probing') count += 1;
    }
    return count;
  }

  #advance(): void {
    const now = this.#clock();
    for (const [service, svc] of this.#services) {
      const nodes = [...svc.nodes.values()].sort((a, b) => compareId(a.id, b.id));
      for (const node of nodes) {
        const cutoff = now - this.#policy.windowMs;
        if (node.samples.length > 0) {
          node.samples = node.samples.filter((s) => s.t > cutoff);
        }
        if (node.state === 'isolated' && now >= node.isolationUntil) {
          this.#startProbeRound(service, node, now);
        }
        if (node.state === 'probing' && node.probe && now >= node.probe.deadline) {
          this.#reIsolate(service, node, now, 'probe-deadline');
        }
      }
    }
  }

  #issue(
    service: string,
    node: NodeEntry,
    kind: CredentialKind,
    degraded: boolean,
    now: number,
  ): { status: 'ok'; credential: Credential } {
    const credential: Credential = {
      attemptId: `att-${++this.#attemptSeq}`,
      service,
      nodeId: node.id,
      generation: node.generation,
      phase: node.phase,
      kind,
      degraded,
      issuedAt: now,
    };
    this.#credentials.set(credential.attemptId, { credential, settled: false });
    return { status: 'ok', credential };
  }

  #settleTraffic(
    service: string,
    svc: ServiceEntry,
    node: NodeEntry,
    outcome: 'success' | 'remote-error',
    now: number,
  ): void {
    if (outcome === 'success') {
      node.consecutiveFailures = 0;
      return;
    }
    node.consecutiveFailures += 1;
    if (
      node.state === 'healthy' &&
      node.consecutiveFailures >= this.#policy.consecutiveFailureThreshold
    ) {
      this.#isolateOrPending(service, svc, node, now);
    }
  }

  #settleProbe(
    service: string,
    svc: ServiceEntry,
    node: NodeEntry,
    outcome: 'success' | 'remote-error',
    now: number,
  ): void {
    const round = node.probe;
    if (!round) return;
    round.inFlight -= 1;
    if (outcome === 'remote-error') {
      // 任一远端失败 → 立即重新隔离；本轮其余在途探测的凭证随之失效
      this.#reIsolate(service, node, now, 'probe-failure');
      return;
    }
    round.successes += 1;
    if (round.successes >= this.#policy.probe.successThreshold) {
      this.#recover(service, svc, node, now);
    }
  }

  #returnProbeSlot(node: NodeEntry, service: string): void {
    const round = node.probe;
    if (!round) return;
    round.inFlight -= 1;
    this.#emit({
      type: 'probe-slot-returned',
      service,
      nodeId: node.id,
      round: round.round,
    });
  }

  #isolateOrPending(service: string, svc: ServiceEntry, node: NodeEntry, now: number): void {
    if (this.#isolatedCount(svc) < this.#policy.maxIsolations) {
      node.isolationRound = 1;
      node.state = 'isolated';
      node.phase += 1;
      node.isolationUntil = now + this.#backoffMs(1);
      this.#emit({
        type: 'isolated',
        service,
        nodeId: node.id,
        round: 1,
        until: node.isolationUntil,
        reason: 'threshold',
      });
    } else {
      node.state = 'pending';
      node.phase += 1;
      this.#emit({ type: 'pending', service, nodeId: node.id });
    }
  }

  #startProbeRound(service: string, node: NodeEntry, now: number): void {
    node.state = 'probing';
    node.phase += 1;
    node.probeRoundCounter += 1;
    node.probe = {
      round: node.probeRoundCounter,
      deadline: now + this.#policy.probe.roundMs,
      inFlight: 0,
      successes: 0,
      issued: 0,
    };
    this.#emit({
      type: 'probe-round-started',
      service,
      nodeId: node.id,
      round: node.probe.round,
      deadline: node.probe.deadline,
    });
  }

  #reIsolate(
    service: string,
    node: NodeEntry,
    now: number,
    reason: 'probe-failure' | 'probe-deadline',
  ): void {
    node.isolationRound += 1;
    node.state = 'isolated';
    node.phase += 1;
    node.isolationUntil = now + this.#backoffMs(node.isolationRound);
    node.probe = null;
    this.#emit({
      type: 're-isolated',
      service,
      nodeId: node.id,
      round: node.isolationRound,
      until: node.isolationUntil,
      reason,
    });
  }

  #recover(service: string, svc: ServiceEntry, node: NodeEntry, now: number): void {
    const round = node.probe?.round;
    node.state = 'healthy';
    node.phase += 1;
    node.consecutiveFailures = 0;
    node.isolationRound = 0;
    node.probe = null;
    this.#emit({ type: 'recovered', service, nodeId: node.id, round });
    // 恢复释放隔离名额 → 补入待隔离节点
    this.#fillPending(service, svc, now);
  }

  #fillPending(service: string, svc: ServiceEntry, now: number): void {
    while (this.#isolatedCount(svc) < this.#policy.maxIsolations) {
      const pending = [...svc.nodes.values()].filter((n) => n.state === 'pending');
      if (pending.length === 0) return;
      // 错误率高→低、节点ID 小→大
      pending.sort(
        (a, b) => this.#score(b).rate - this.#score(a).rate || compareId(a.id, b.id),
      );
      const node = pending[0];
      node.isolationRound = 1;
      node.state = 'isolated';
      node.phase += 1;
      node.isolationUntil = now + this.#backoffMs(1);
      this.#emit({
        type: 'isolated',
        service,
        nodeId: node.id,
        round: 1,
        until: node.isolationUntil,
        reason: 'filled-from-pending',
      });
    }
  }

  #snapshot(node: NodeEntry): NodeSnapshot {
    const score = this.#score(node);
    return {
      id: node.id,
      region: node.region,
      generation: node.generation,
      state: node.state,
      phase: node.phase,
      score: score.rate,
      validSamples: score.valid,
      remoteErrors: score.errors,
      consecutiveFailures: node.consecutiveFailures,
      cancels: node.cancels,
      localTimeouts: node.localTimeouts,
      isolation:
        node.state === 'isolated'
          ? { round: node.isolationRound, until: node.isolationUntil }
          : null,
      probe: node.probe ? { ...node.probe } : null,
    };
  }

  #emit(event: Omit<RouterEvent, 'at'>): void {
    this.#events.push({ at: this.#clock(), ...event });
  }

  #diag(
    now: number,
    credential: Credential,
    outcome: Outcome,
    reason: DiagnosticReason,
  ): void {
    this.#diagnostics.push({
      at: now,
      service: credential.service,
      nodeId: credential.nodeId,
      attemptId: credential.attemptId,
      outcome,
      reason,
    });
  }
}

export function createHealthRouter(config: RouterConfig): HealthRouter {
  return new HealthRouter(config);
}
