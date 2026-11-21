/**
 * 迁移规划器：把目标分配转换为复制（replicate）、追平（catchup）、
 * 删除（delete）动作，并在每一步维护迁移安全不变量。
 *
 * 槽位口径：已追平副本、复制中副本（inflight）、待删除副本（removing）
 * 都占用 Broker 槽位；删除动作完成后才释放。
 *
 * 安全不变量（每次主动删除后必须成立）：
 * - 可用副本数 >= min(删除前可用副本数, 目标副本数)；
 * - 覆盖故障域数 >= min(删除前覆盖故障域数, 目标副本数)；
 * - 当分区处于目标副本数（非缩容）时，新副本未全部追平前，不允许删除
 *   旧副本——保证新副本确认追平后才允许删除它替代的旧副本，且删除
 *   顺序严格让位于新副本就绪。
 *
 * 成环处理：当所有需要的复制都因目标槽位被占用而阻塞时，检测等待环，
 * 利用临时副本（落在未覆盖故障域）腾挪；没有空间则返回受阻关系与
 * 需要释放槽位的位置。
 */

import type { Assignment, BrokerSpec } from './types.ts';

export type ActionType = 'replicate' | 'catchup' | 'delete' | 'release';

export interface MigrationAction {
  type: ActionType;
  partitionId: string;
  brokerId: string;
  /** 仅 replicate：该落点是否为临时副本（不在最终目标中）。 */
  temporary?: boolean;
}

/** 某一时刻的可核对快照。 */
export interface MigrationSnapshot {
  partitionId: string;
  /** 已追平、真实存在的副本。 */
  availableReplicas: string[];
  /** 复制中、尚未追平的副本（仍占槽位）。 */
  inflightReplicas: string[];
  /** 删除指令已发出、槽位尚未释放的副本。 */
  removingReplicas: string[];
  /** 当前可用副本覆盖的故障域数。 */
  coveredFaultDomains: number;
}

export interface BlockedReport {
  kind:
    | 'cycle-no-room'
    | 'no-temp-broker'
    | 'target-broker-unavailable'
    | 'delete-window-full';
  partitionId: string;
  brokerId: string;
  /** 等待关系：(分区, Broker) -> 等待哪个 Broker 释放槽位。 */
  waits: Array<{ partitionId: string; brokerId: string; waitingForBroker: string }>;
  /** 检测到的等待环（分区 ID 有序列表），无环时为空。 */
  cyclePartitions: string[];
  /** 需要释放槽位的 Broker 及其占用者，便于核对。 */
  releaseAt: Array<{ brokerId: string; occupiedBy: string[] }>;
  /** 临时副本候选（含无空槽的不可用候选），用于核对腾挪空间。 */
  tempCandidates: Array<{ brokerId: string; faultDomain: string; freeSlots: number }>;
  detail: string;
}

export interface MigrationPlanResult {
  status: 'complete' | 'blocked';
  actions: MigrationAction[];
  /** 每个动作执行后的快照轨迹。 */
  trajectory: Array<{ step: number; action: MigrationAction; snapshots: MigrationSnapshot[] }>;
  blocked?: BlockedReport;
}

export interface PlannerPartitionState {
  available: Set<string>;
  inflight: Set<string>;
  removing: Set<string>;
}

export interface PlannerInput {
  brokers: BrokerSpec[];
  partitionIds: string[];
  target: Assignment;
  /** 迁移开始时各分区真实存在的副本（规划基线）。 */
  initial: Assignment;
}

function sorted(values: Set<string> | string[]): string[] {
  return [...values].sort();
}

export class MigrationPlanner {
  private readonly brokers: BrokerSpec[];
  private readonly brokerById: Map<string, BrokerSpec>;
  private readonly partitionIds: string[];
  private readonly target: Map<string, Set<string>>;
  private readonly rf: Map<string, number>;
  private readonly state = new Map<string, PlannerPartitionState>();
  /** 迁移基线中的原始副本，用于「新副本追平前不删旧副本」闸门。 */
  private readonly originalCurrent = new Map<string, Set<string>>();

  constructor(input: PlannerInput) {
    this.brokers = [...input.brokers].sort((a, b) => (a.id < b.id ? -1 : 1));
    this.brokerById = new Map(this.brokers.map((b) => [b.id, b]));
    this.partitionIds = [...input.partitionIds].sort();
    this.target = new Map();
    this.rf = new Map();
    for (const pid of this.partitionIds) {
      const t = input.target[pid];
      if (!t) throw new Error(`目标分配缺少分区 ${pid}`);
      this.target.set(pid, new Set(t));
      this.rf.set(pid, t.length);
      const initial = input.initial[pid] ?? [];
      this.state.set(pid, {
        available: new Set(initial),
        inflight: new Set(),
        removing: new Set(),
      });
      this.originalCurrent.set(pid, new Set(initial));
    }
  }

  // ---- 槽位与状态查询 -------------------------------------------------

  private usage(brokerId: string): number {
    let n = 0;
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      if (s.available.has(brokerId) || s.inflight.has(brokerId) || s.removing.has(brokerId)) {
        n++;
      }
    }
    return n;
  }

  private freeSlots(brokerId: string): number {
    const broker = this.brokerById.get(brokerId);
    if (!broker) return 0;
    return broker.capacity - this.usage(brokerId);
  }

  private domainsOf(brokerIds: Set<string>): number {
    const domains = new Set<string>();
    for (const b of brokerIds) domains.add(this.brokerById.get(b)!.faultDomain);
    return domains.size;
  }

  snapshot(): MigrationSnapshot[] {
    return this.partitionIds.map((pid) => {
      const s = this.state.get(pid)!;
      return {
        partitionId: pid,
        availableReplicas: sorted(s.available),
        inflightReplicas: sorted(s.inflight),
        removingReplicas: sorted(s.removing),
        coveredFaultDomains: this.domainsOf(s.available),
      };
    });
  }

  isConverged(): boolean {
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      if (s.inflight.size > 0 || s.removing.size > 0) return false;
      const target = this.target.get(pid)!;
      if (s.available.size !== target.size) return false;
      for (const b of target) if (!s.available.has(b)) return false;
    }
    return true;
  }

  // ---- 动作应用（executor / 静态规划共用） ----------------------------

  /** 应用一个已被调度的动作，推进规划器内部状态。 */
  applyAction(action: MigrationAction): void {
    const s = this.state.get(action.partitionId)!;
    switch (action.type) {
      case 'replicate':
        if (!s.available.has(action.brokerId) && !s.inflight.has(action.brokerId)) {
          s.inflight.add(action.brokerId); // 复制中即占槽位
        }
        break;
      case 'catchup':
        s.inflight.delete(action.brokerId);
        s.available.add(action.brokerId); // 追平后成为真实可用副本
        break;
      case 'delete':
        s.available.delete(action.brokerId);
        s.inflight.delete(action.brokerId);
        s.removing.add(action.brokerId); // 删除完成前槽位仍占用
        break;
      case 'release':
        // 删除在外部系统确认完成：槽位真正释放。
        s.removing.delete(action.brokerId);
        break;
    }
  }

  /** 删除在外部系统确认完成后调用，释放槽位。 */
  releaseRemoval(partitionId: string, brokerId: string): void {
    this.state.get(partitionId)!.removing.delete(brokerId);
  }

  /**
   * 复制失败 / 被中止时调用：复制中的副本从未成为可用副本，
   * 直接从 inflight 移除并释放槽位，不经过删除安全闸门。
   */
  abortInflight(partitionId: string, brokerId: string): void {
    this.state.get(partitionId)!.inflight.delete(brokerId);
  }

  // ---- 安全删除判定 ---------------------------------------------------

  /**
   * 判断删除 (pid, broker) 是否满足全部安全不变量。
   */
  private canDelete(pid: string, broker: string): boolean {
    const s = this.state.get(pid)!;
    if (!s.available.has(broker)) return false;
    const rf = this.rf.get(pid)!;
    const countBefore = s.available.size;
    const domainsBefore = this.domainsOf(s.available);

    // 容量前置条件：delete 到 release 之间该副本仍占槽位，删除不会立即
    // 降低 Broker 占用。因此若 Broker 当前已满载，删除窗口内必然超容量，
    // 必须等待已有 removing 副本释放后再删除。
    const brokerSpec = this.brokerById.get(broker)!;
    if (this.usage(broker) >= brokerSpec.capacity && s.removing.size === 0) {
      return false;
    }

    // 不变量 1：删除后可用副本数 >= min(删除前, 目标副本数)。
    if (countBefore - 1 < Math.min(countBefore, rf)) return false;

    // 不变量 2：删除后覆盖故障域数 >= min(删除前覆盖数, 目标副本数)。
    const remaining = new Set(s.available);
    remaining.delete(broker);
    if (this.domainsOf(remaining) < Math.min(domainsBefore, rf)) return false;

    // 不变量 3：删除迁移基线中的原始副本前，必须存在已追平的替代者，
    // 二选一即可：
    //  (a) 该分区所有新目标副本（目标中、基线之外的落点）均已追平——
    //      常规迁移路径，新副本确认追平后才删除它替代的旧副本；
    //  (b) 已存在一个异域的、基线之外的可用副本（临时副本安全垫）——
    //      环上腾挪路径，删除后仍有同等级的可用副本兜底，随后再向
    //      目标 Broker 归位。安全垫必须与被删副本处于不同故障域，
    //      否则删除会降低故障域覆盖并导致临时副本反复重建。
    const original = this.originalCurrent.get(pid)!;
    if (original.has(broker)) {
      const target = this.target.get(pid)!;
      const newTargetReplicas = [...target].filter((b) => !original.has(b));
      const allNewCaughtUp = newTargetReplicas.every((b) => s.available.has(b));
      if (!allNewCaughtUp) {
        const brokerDomain = this.brokerById.get(broker)!.faultDomain;
        const hasTempSafetyNet = [...s.available].some(
          (b) =>
            !original.has(b) &&
            this.brokerById.get(b)!.faultDomain !== brokerDomain,
        );
        if (!hasTempSafetyNet) return false;
      }
    }

    // 不变量 4：临时副本（不在迁移基线、也不在目标中的桥接副本）在
    // 该分区仍持有任何原始副本期间承担安全垫角色，不允许删除——否则
    // 临时腾挪会与「复制->删除」来回震荡，永远无法推进迁移。
    if (!original.has(broker) && !this.target.get(pid)!.has(broker)) {
      const stillHoldingOriginal = [...s.available].some((b) => original.has(b));
      if (stillHoldingOriginal) return false;
    }
    return true;
  }

  // ---- 单步规划 -------------------------------------------------------

  /**
   * 返回当前可以立即执行的一批动作（无副作用）。
   * 返回空数组且未收敛时，调用方应调用 analyzeBlocked() 获取受阻依据。
   *
   * 同一批内的复制动作共享槽位预算：先入批的复制立即记账占用，后续复制
   * 必须看到更新后的空闲槽位，避免多个分区同时复制进同一 Broker 而超容量。
   */
  nextActions(): MigrationAction[] {
    const actions: MigrationAction[] = [];
    // 本批复制对各 Broker 的额外占用（规划器状态尚未应用这些动作）。
    const batchReserved = new Map<string, number>();
    const effectiveFree = (brokerId: string): number =>
      this.freeSlots(brokerId) - (batchReserved.get(brokerId) ?? 0);

    // 0) 释放：上一轮删除已在外部确认完成的副本槽位（removing -> 消失）。
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      for (const broker of sorted(s.removing)) {
        actions.push({ type: 'release', partitionId: pid, brokerId: broker });
      }
    }

    // 1) 追平：复制中的副本完成复制后，确认追平。
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      for (const broker of sorted(s.inflight)) {
        actions.push({ type: 'catchup', partitionId: pid, brokerId: broker });
      }
    }

    // 2) 安全删除：优先释放槽位，为后续复制创造空间。
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      const target = this.target.get(pid)!;
      for (const broker of sorted(s.available)) {
        if (target.has(broker)) continue;
        if (this.canDelete(pid, broker)) {
          actions.push({ type: 'delete', partitionId: pid, brokerId: broker });
        }
      }
    }

    // 3) 复制：启动目标中尚不存在（含复制中）的副本，逐笔核对槽位预算。
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      const target = this.target.get(pid)!;
      for (const broker of sorted(target)) {
        if (s.available.has(broker) || s.inflight.has(broker) || s.removing.has(broker)) continue;
        if (effectiveFree(broker) <= 0) continue;
        batchReserved.set(broker, (batchReserved.get(broker) ?? 0) + 1);
        actions.push({ type: 'replicate', partitionId: pid, brokerId: broker, temporary: false });
      }
    }

    if (actions.length > 0 || this.isConverged()) {
      this.lastBlockedReport = undefined;
      return actions;
    }

    // 4) 阻塞分析：等待环 + 临时副本腾挪。
    const blocked = this.analyzeBlocked();
    if (blocked.tempAction) {
      this.lastBlockedReport = undefined;
      return [blocked.tempAction];
    }
    this.lastBlockedReport = blocked.report;
    return [];
  }

  /** 最近一次规划得到的受阻报告；无阻塞时为 undefined。 */
  private lastBlockedReport: BlockedReport | undefined;

  /**
   * 阻塞分析：构建「需要的复制 -> 等待 Broker 释放槽位」的等待关系，
   * 检测等待环，并为环上分区寻找临时副本落点。
   */
  private analyzeBlocked(): {
    tempAction?: MigrationAction;
    report?: BlockedReport;
  } {
    type Need = { pid: string; broker: string };
    const needs: Need[] = [];
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      const target = this.target.get(pid)!;
      for (const broker of sorted(target)) {
        if (s.available.has(broker) || s.inflight.has(broker) || s.removing.has(broker)) continue;
        if (!this.brokerById.has(broker)) {
          return {
            report: this.buildReport('target-broker-unavailable', pid, broker, [], [], []),
          };
        }
        needs.push({ pid, broker });
      }
    }

    // 没有待启动的复制：说明阻塞来自删除窗口（满载 Broker 上的副本要等
    // removing 释放）或状态尚未推进，交由调用方在下一轮重新规划。
    if (needs.length === 0) {
      return { report: undefined };
    }

    // 等待关系：分区在某 Broker 上等待槽位，占用该 Broker 的可用副本
    // （且该副本不属于占用者分区的目标集合）即形成等待边。
    const waits: BlockedReport['waits'] = [];
    for (const need of needs) {
      for (const occupantPid of this.partitionIds) {
        const os = this.state.get(occupantPid)!;
        if (
          os.available.has(need.broker) &&
          !this.target.get(occupantPid)!.has(need.broker)
        ) {
          waits.push({
            partitionId: need.pid,
            brokerId: need.broker,
            waitingForBroker: need.broker,
          });
        }
      }
    }

    // 等待图：need 节点 (分区, 目标Broker) -> 占用该 Broker 的分区。
    const edges = new Map<string, Set<string>>();
    for (const need of needs) {
      const key = `${need.pid}|${need.broker}`;
      edges.set(key, new Set());
      for (const occupantPid of this.partitionIds) {
        const os = this.state.get(occupantPid)!;
        if (
          os.available.has(need.broker) &&
          occupantPid !== need.pid &&
          !this.target.get(occupantPid)!.has(need.broker)
        ) {
          edges.get(key)!.add(occupantPid);
        }
      }
    }

    // DFS 找环（确定性：邻接按分区 ID 排序）。
    const cyclePartitions: string[] = [];
    const color = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    const dfs = (key: string): boolean => {
      color.set(key, 1);
      stack.push(key);
      for (const nextPid of sorted(edges.get(key)!)) {
        // 后继分区自身阻塞在哪些 need 上
        const nextKeys = needs.filter((n) => n.pid === nextPid).map((n) => `${n.pid}|${n.broker}`);
        for (const nk of nextKeys) {
          const c = color.get(nk) ?? 0;
          if (c === 1) {
            const start = stack.indexOf(nk);
            for (let i = start; i < stack.length; i++) {
              const p = stack[i]!.split('|')[0]!;
              if (!cyclePartitions.includes(p)) cyclePartitions.push(p);
            }
            cyclePartitions.sort();
            return true;
          }
          if (c === 0 && dfs(nk)) return true;
        }
      }
      stack.pop();
      color.set(key, 2);
      return false;
    };
    for (const need of needs) {
      const key = `${need.pid}|${need.broker}`;
      if ((color.get(key) ?? 0) === 0 && dfs(key)) break;
    }

    // 为所有阻塞分区（环上分区优先）寻找临时副本落点。注意：已经腾挪
    // 出空间的 Broker 可能承载另一个分区的临时副本，因此必须逐个分区
    // 尝试，不能因为第一个分区没有落点就判定整体受阻。
    const blockedPids = sorted(new Set(needs.map((n) => n.pid)));
    const candidatePartitions =
      cyclePartitions.length > 0
        ? [...cyclePartitions, ...blockedPids.filter((p) => !cyclePartitions.includes(p))]
        : blockedPids;

    const allTempCandidates: BlockedReport['tempCandidates'] = [];
    for (const pid of candidatePartitions) {
      const s = this.state.get(pid)!;
      const coveredDomains = new Set<string>();
      for (const b of new Set([...s.available, ...s.inflight, ...s.removing])) {
        coveredDomains.add(this.brokerById.get(b)!.faultDomain);
      }
      // 临时副本必须落在未覆盖故障域：只有这样，删除旧副本时
      // 「覆盖故障域数不下降」的不变量才成立。同域 Broker 只能作为
      // 报告中的候选展示，不允许实际承载临时副本。
      const eligible = this.brokers.filter(
        (b) =>
          !s.available.has(b.id) &&
          !s.inflight.has(b.id) &&
          !s.removing.has(b.id),
      );
      const uncovered = eligible.filter((b) => !coveredDomains.has(b.faultDomain));
      const sameDomain = eligible.filter((b) => coveredDomains.has(b.faultDomain));
      const ordered = [...uncovered, ...sameDomain].sort((a, b) => {
        // 确定性排序，优先级依次为：
        // 1) 未覆盖故障域优先（删除旧副本时故障域覆盖不下降）；
        // 2) 有空闲槽位优先；3) 空闲槽位降序；4) Broker ID 升序。
        const da = coveredDomains.has(a.faultDomain) ? 1 : 0;
        const db = coveredDomains.has(b.faultDomain) ? 1 : 0;
        if (da !== db) return da - db;
        const ra = this.freeSlots(a.id) > 0 ? 1 : 0;
        const rb = this.freeSlots(b.id) > 0 ? 1 : 0;
        if (ra !== rb) return rb - ra;
        const fa = a.capacity - this.usage(a.id);
        const fb = b.capacity - this.usage(b.id);
        if (fa !== fb) return fb - fa;
        return a.id < b.id ? -1 : 1;
      });

      for (const c of ordered) {
        allTempCandidates.push({
          brokerId: c.id,
          faultDomain: c.faultDomain,
          freeSlots: this.freeSlots(c.id),
        });
      }

      // 只接受未覆盖域中有空闲槽位的落点。
      const withRoom = ordered.find(
        (b) => this.freeSlots(b.id) > 0 && !coveredDomains.has(b.faultDomain),
      );
      if (withRoom) {
        return {
          tempAction: {
            type: 'replicate',
            partitionId: pid,
            brokerId: withRoom.id,
            temporary: true,
          },
        };
      }
    }

    // 所有阻塞分区都找不到可用临时落点。先判断是否为「删除窗口满载」：
    // 存在待删除的非目标副本，但其 Broker 已满载，delete->release 窗口内
    // 无处容纳，迁移无法在不超容量的前提下推进。
    const stuckDeletes = this.collectStuckDeletes();
    if (stuckDeletes.length > 0) {
      const first = needs[0] ?? stuckDeletes[0]!;
      const need = needs[0];
      return {
        report: this.buildReport(
          'delete-window-full',
          first.pid,
          need?.broker ?? first.brokerId,
          waits,
          cyclePartitions,
          this.buildReleaseAt(needs),
          allTempCandidates,
        ),
      };
    }

    // 其余情况：临时副本候选存在但全部无空闲槽位（环上无腾挪空间）。
    const firstNeed = needs[0]!;
    const noCandidateAtAll = allTempCandidates.length === 0;
    return {
      report: this.buildReport(
        noCandidateAtAll ? 'no-temp-broker' : 'cycle-no-room',
        firstNeed.pid,
        firstNeed.broker,
        waits,
        cyclePartitions,
        this.buildReleaseAt(needs),
        allTempCandidates,
      ),
    };
  }

  /**
   * 收集被「删除窗口满载」挡住的非目标副本：副本可用、不在目标中、
   * 但其 Broker 当前占用已达容量，且该分区没有待释放的 removing 副本
   * 可以在同一轮衔接。
   */
  private collectStuckDeletes(): Array<{ pid: string; brokerId: string }> {
    const stuck: Array<{ pid: string; brokerId: string }> = [];
    for (const pid of this.partitionIds) {
      const s = this.state.get(pid)!;
      const target = this.target.get(pid)!;
      for (const broker of sorted(s.available)) {
        if (target.has(broker)) continue;
        const spec = this.brokerById.get(broker)!;
        if (this.usage(broker) >= spec.capacity && s.removing.size === 0) {
          stuck.push({ pid, brokerId: broker });
        }
      }
    }
    return stuck;
  }

  private buildReleaseAt(needs: Array<{ pid: string; broker: string }>): BlockedReport['releaseAt'] {
    const brokerIds = sorted(new Set(needs.map((n) => n.broker)));
    return brokerIds.map((brokerId) => {
      const occupiedBy: string[] = [];
      for (const pid of this.partitionIds) {
        const s = this.state.get(pid)!;
        if (s.available.has(brokerId) || s.inflight.has(brokerId) || s.removing.has(brokerId)) {
          occupiedBy.push(pid);
        }
      }
      return { brokerId, occupiedBy: occupiedBy.sort() };
    });
  }

  private buildReport(
    kind: BlockedReport['kind'],
    partitionId: string,
    brokerId: string,
    waits: BlockedReport['waits'],
    cyclePartitions: string[],
    releaseAt: BlockedReport['releaseAt'],
    tempCandidates: BlockedReport['tempCandidates'] = [],
  ): BlockedReport {
    const detailMap: Record<BlockedReport['kind'], string> = {
      'cycle-no-room':
        `分区 ${partitionId} 复制到 ${brokerId} 的等待成环，且所有临时副本候选 Broker 均无空闲槽位；` +
        `需要先在报告列出的 Broker 上释放槽位`,
      'no-temp-broker':
        `分区 ${partitionId} 被阻塞，但不存在位于未覆盖故障域的 Broker 可承载临时副本；` +
        `等待关系与占用者见 waits/releaseAt`,
      'target-broker-unavailable':
        `目标 Broker ${brokerId} 已不在存活拓扑中，分区 ${partitionId} 无法推进，需要重新规划`,
      'delete-window-full':
        `分区 ${partitionId} 的迁移被删除窗口阻塞：待删除副本所在 Broker 已满载，` +
        `delete 到 release 之间副本仍占槽位，没有额外容量容纳迁移中间态；` +
        `releaseAt 给出需要先释放槽位的 Broker 及其占用者`,
    };
    return {
      kind,
      partitionId,
      brokerId,
      waits,
      cyclePartitions,
      releaseAt,
      tempCandidates,
      detail: detailMap[kind],
    };
  }

  /** 受阻时返回结构化报告；未阻塞返回 undefined。 */
  blockedReport(): BlockedReport | undefined {
    if (this.isConverged()) return undefined;
    return this.lastBlockedReport;
  }
}

/**
 * 静态执行：持续调用规划器直到收敛或确认受阻，输出完整动作轨迹。
 * 每个动作后都记录快照，供逐步核对容量与可用副本数。
 */
export function buildMigrationPlan(input: PlannerInput): MigrationPlanResult {
  const planner = new MigrationPlanner(input);
  const actions: MigrationAction[] = [];
  const trajectory: MigrationPlanResult['trajectory'] = [];
  // 动作数上界：每个 (分区, Broker) 对至多经历 复制->追平->删除->释放，
  // 再加上临时副本，取宽松上界防止异常死循环。
  const maxSteps =
    input.partitionIds.length * input.brokers.length * 4 + input.brokers.length + 10;

  let step = 0;
  while (!planner.isConverged()) {
    if (step > maxSteps) {
      throw new Error('迁移规划超过动作数上界，疑似内部状态错误');
    }
    const batch = planner.nextActions();
    if (batch.length === 0) {
      const blocked = planner.blockedReport();
      if (!blocked) {
        // 理论上不可达：无动作、未收敛却没有结构化阻塞依据，属于内部错误。
        throw new Error('规划器无动作可执行且未给出受阻依据，疑似内部状态错误');
      }
      return { status: 'blocked', actions, trajectory, blocked };
    }
    for (const action of batch) {
      planner.applyAction(action);
      actions.push(action);
      trajectory.push({ step: step++, action, snapshots: planner.snapshot() });
    }
  }
  return { status: 'complete', actions, trajectory };
}
