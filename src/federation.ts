/**
 * Federation —— 联邦编排器：装配一组 RoutingDomain 与仿真网络，
 * 提供双向会话建立/断开、整域重启、收敛驱动与路由快照比对。
 */
import { RoutingDomain } from './router.ts';
import { SimNetwork, type LinkFaultPolicy, type Transport } from './network.ts';
import { TraceLog } from './trace.ts';

export interface FederationOptions {
  seed?: number;
  trace?: TraceLog;
  summaryIntervalMs?: number;
}

export class Federation {
  readonly network: SimNetwork;
  readonly trace: TraceLog;
  private readonly domains = new Map<string, RoutingDomain>();
  private readonly summaryIntervalMs: number;

  constructor(opts: FederationOptions = {}) {
    this.trace = opts.trace ?? new TraceLog();
    this.network = new SimNetwork(opts.seed ?? 1, this.trace);
    this.summaryIntervalMs = opts.summaryIntervalMs ?? 0;
    this.network.setHandler((from, _to, envelope) => {
      this.domains.get(from); // 确保发送方已注册
      const router = this.domains.get(_to);
      router?.receive(from, envelope);
    });
  }

  transport(): Transport {
    return this.network;
  }

  addDomain(id: string): RoutingDomain {
    if (this.domains.has(id)) throw new Error(`域 ${id} 已存在`);
    const router = new RoutingDomain({
      id,
      transport: this.network,
      trace: this.trace,
      summaryIntervalMs: this.summaryIntervalMs,
      // 全网连通性验证：完整路径上的每一跳，两端都必须存在且会话活动
      pathValidator: (path) => {
        for (let i = 0; i < path.length - 1; i++) {
          const u = this.domains.get(path[i]);
          const v = this.domains.get(path[i + 1]);
          if (!u || !v) return false;
          const su = u.getNeighbor(path[i + 1]);
          const sv = v.getNeighbor(path[i]);
          if (!su || !sv || !su.active || !sv.active) return false;
        }
        return true;
      },
    });
    this.domains.set(id, router);
    return router;
  }

  domain(id: string): RoutingDomain {
    const r = this.domains.get(id);
    if (!r) throw new Error(`未知域 ${id}`);
    return r;
  }

  allDomains(): RoutingDomain[] {
    return [...this.domains.values()];
  }

  /** 添加邻接（两端各登记邻居）并配置链路故障策略 */
  connect(a: string, b: string, linkCost: number, fault?: LinkFaultPolicy): void {
    const ra = this.domain(a);
    const rb = this.domain(b);
    if (!ra.hasNeighbor(b)) ra.addNeighbor(b, linkCost);
    if (!rb.hasNeighbor(a)) rb.addNeighbor(a, linkCost);
    this.network.configureLink(a, b, { delayMs: 10, jitterMs: 25, ...(fault ?? {}) });
    this.bringUp(a, b);
  }

  /** 双向会话建立：两端会话代次各自 +1 并交换对端代次 */
  bringUp(a: string, b: string): void {
    const ra = this.domain(a);
    const rb = this.domain(b);
    const newGenA = (ra.getNeighbor(b)?.sessionGen ?? 0) + 1;
    const newGenB = (rb.getNeighbor(a)?.sessionGen ?? 0) + 1;
    ra.activateSession(b, newGenA, newGenB);
    rb.activateSession(a, newGenB, newGenA);
  }

  /** 双向会话断开 */
  bringDown(a: string, b: string): void {
    this.domain(a).sessionDown(b);
    this.domain(b).sessionDown(a);
  }

  /** 链路代价调整（两端同步） */
  setLinkCost(a: string, b: string, newCost: number): void {
    this.domain(a).changeLinkCost(b, newCost);
    this.domain(b).changeLinkCost(a, newCost);
  }

  /**
   * 整域重启：先断开全部邻居会话，再执行重启（代次 +1、状态清空），
   * 最后重建会话并交换摘要。旧会话上仍在网络中排队的迟到消息
   * 会因会话代次不匹配被各邻居拒绝。
   */
  restartDomain(id: string): void {
    const router = this.domain(id);
    const peers = router.neighborIds().filter((p) => router.isNeighborActive(p));
    for (const p of peers) this.bringDown(id, p);
    router.restart();
    for (const p of peers) this.bringUp(id, p);
  }

  /** 驱动仿真直到事件队列耗尽（收敛） */
  runUntilIdle(maxSteps?: number): void {
    this.network.run(maxSteps);
  }

  /** 在指定逻辑时间窗口内运行（用于周期摘要场景） */
  runUntil(untilMs: number): void {
    this.network.runUntil(untilMs);
  }
}
