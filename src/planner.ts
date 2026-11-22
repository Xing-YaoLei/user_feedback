/**
 * 迁移规划器：把目标分配转换为一串可执行的
 * 复制(replicate) / 追平等待(await) / 删除(delete) 动作。
 *
 * 硬不变量：
 * - 复制中的副本（inflight）同样占用 Broker 槽位；
 * - 新副本确认追平（inflight -> actual）之后，才允许删除它所替代的
 *   旧副本；
 * - 每次“主动删除”之后，该分区的实际副本数与覆盖故障域数，都至少
 *   保留删除前相应数量与目标副本数的较小值：
 *       afterCount >= min(beforeCount, rf)
 *       afterDomains >= min(beforeDomains, rf)
 * - 允许利用临时副本腾挪：当所有需要的复制都被满 Broker 卡住、且
 *   没有进行中复制可等待时，在空闲 Broker 上为待迁移分区建立临时
 *   副本，追平后再安全删除旧副本释放槽位，从而打破迁移成环。
 *
 * 所有选择都按分区 ID、Broker ID 字典序确定化，等价输入得到等价轨迹。
 */

import {
  actualDomains,
  buildClusterState,
  domainOf,
  hasReplica,
  inflightEntries,
  slotKey,
  usageOf,
  type ClusterState,
} from './state.ts';
import type {
  Assignment,
  BlockedReport,
  BrokerId,
  BrokerSpec,
  InFlightReplica,
  MigrationAction,
  PartitionId,
  PartitionSpec,
  PlanResult,
} from './types.ts';

export class MigrationPlanner {
  readonly state: ClusterState;
  private readonly target: Assignment;
  private readonly rf: Map<PartitionId, number>;
  private readonly partitionOrder: PartitionId[];
  private readonly brokerOrder: BrokerId[];
  private seq = 0;
  private readonly idPrefix: string;

  constructor(
    brokers: BrokerSpec[],
    partitions: PartitionSpec[],
    current: Record<PartitionId, BrokerId[]>,
    target: Assignment,
    inflight: InFlightReplica[] = [],
    idPrefix = 'rep',
  ) {
    this.state = buildClusterState(brokers, current, inflight);
    this.target = target;
    this.rf = new Map(partitions.map((p) => [p.id, p.replicas]));
    this.partitionOrder = partitions.map((p) => p.id).sort((a, b) => a.localeCompare(b));
    this.brokerOrder = brokers.map((b) => b.id).sort((a, b) => a.localeCompare(b));
    this.idPrefix = idPrefix;
  }

  private nextRequestId(): string {
    this.seq += 1;
    return `${this.idPrefix}-${this.seq}`;
  }

  private targetBrokers(pid: PartitionId): Set<BrokerId> {
    return new Set(this.target[pid] ?? []);
  }

  private freeBrokers(): BrokerId[] {
    return this.brokerOrder.filter((b) => usageOf(this.state, b) < (this.state.brokers.get(b)!.capacity));
  }

  /** 分区尚未满足的目标落点（目标里有、当前实际与进行中都没有）。 */
  private missingPlacements(pid: PartitionId): BrokerId[] {
    return [...this.targetBrokers(pid)]
      .filter((b) => !hasReplica(this.state, pid, b))
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * 尝试一次直接复制：按分区 ID、目标 Broker ID 的确定性顺序，
   * 找一个有空闲槽位且有实际副本可作源的缺失落点。
   */
  private tryDirectReplicate(): MigrationAction | null {
    for (const pid of this.partitionOrder) {
      const actual = [...(this.state.actual.get(pid) ?? [])].sort((a, b) => a.localeCompare(b));
      if (actual.length === 0) continue;
      for (const broker of this.missingPlacements(pid)) {
        if (usageOf(this.state, broker) >= this.state.brokers.get(broker)!.capacity) continue;
        const source = actual[0];
        this.state.inflight.set(slotKey(pid, broker), this.nextRequestId());
        return { type: 'replicate', partition: pid, source, target: broker, temporary: false };
      }
    }
    return null;
  }

  /**
   * 主动删除一个“多余且不在目标中”的实际副本。
   * 同时校验副本数与故障域数两条安全下限。
   */
  private trySafeDelete(): MigrationAction | null {
    for (const pid of this.partitionOrder) {
      const rf = this.rf.get(pid) ?? 0;
      const actualSet = this.state.actual.get(pid) ?? new Set<BrokerId>();
      const targets = this.targetBrokers(pid);
      const beforeCount = actualSet.size;
      const beforeDomains = actualDomains(this.state, pid);
      const countFloor = Math.min(beforeCount, rf);
      const domainFloor = Math.min(beforeDomains.size, rf);
      const candidates = [...actualSet]
        .filter((b) => !targets.has(b))
        .sort((a, b) => a.localeCompare(b));
      for (const broker of candidates) {
        if (beforeCount - 1 < countFloor) continue;
        const domain = domainOf(this.state, broker);
        // 该域是否还有别的实际副本；没有的话删除会使覆盖域数减一。
        const domainStillCovered = [...actualSet]
          .some((b) => b !== broker && domainOf(this.state, b) === domain);
        const afterDomains = beforeDomains.size - (domainStillCovered ? 0 : 1);
        if (afterDomains < domainFloor) continue;

        actualSet.delete(broker);
        return {
          type: 'delete',
          partition: pid,
          broker,
          beforeReplicaCount: beforeCount,
          beforeDomainCount: beforeDomains.size,
          retainedFloor: countFloor,
          retainedDomainFloor: domainFloor,
        };
      }
    }
    return null;
  }

  /**
   * 用临时副本打破迁移成环：
   * 选择一个仍有缺失落点的分区，在有空闲槽位的 Broker 上建立临时副本
   * （该 Broker 不能已经持有该分区的实际/进行中副本）。
   * 优先选择完全空闲的 Broker，保证临时副本真正“腾挪”出槽位；
   * 临时副本追平后，旧副本即可满足安全护栏被删除，腾出目标槽位。
   */
  private tryTemporaryReplica(): MigrationAction | null {
    const free = this.freeBrokers();
    if (free.length === 0) return null;
    const emptyFirst = [
      ...free.filter((b) => usageOf(this.state, b) === 0),
      ...free.filter((b) => usageOf(this.state, b) > 0),
    ];
    for (const pid of this.partitionOrder) {
      const missing = this.missingPlacements(pid);
      if (missing.length === 0) continue;
      const actual = [...(this.state.actual.get(pid) ?? [])].sort((a, b) => a.localeCompare(b));
      if (actual.length === 0) continue;
      for (const broker of emptyFirst) {
        if (hasReplica(this.state, pid, broker)) continue;
        const source = actual[0];
        this.state.inflight.set(slotKey(pid, broker), this.nextRequestId());
        return { type: 'replicate', partition: pid, source, target: broker, temporary: true };
      }
    }
    return null;
  }

  private buildBlockedReport(noSource: boolean): BlockedReport {
    const fullBrokers: BlockedReport['fullBrokers'] = [];
    const fullSet = new Set<BrokerId>();
    const pending: BlockedReport['pending'] = [];

    for (const pid of this.partitionOrder) {
      for (const broker of this.missingPlacements(pid)) {
        const spec = this.state.brokers.get(broker)!;
        const occupiedBy: BlockedReport['pending'][number]['occupiedBy'] = [];
        for (const [otherPid, set] of this.state.actual) {
          if (set.has(broker)) occupiedBy.push({ partition: otherPid, broker, inflight: false });
        }
        for (const entry of inflightEntries(this.state)) {
          if (entry.broker === broker) {
            occupiedBy.push({ partition: entry.partition, broker, inflight: true });
          }
        }
        occupiedBy.sort((a, b) =>
          a.partition.localeCompare(b.partition) || a.broker.localeCompare(b.broker));
        pending.push({ partition: pid, targetBroker: broker, occupiedBy });
        if (usageOf(this.state, broker) >= spec.capacity && !fullSet.has(broker)) {
          fullSet.add(broker);
          const occupants = occupiedBy.map((o) => ({ partition: o.partition, inflight: o.inflight }));
          fullBrokers.push({ broker, capacity: spec.capacity, occupants, mustRelease: 1 });
        }
      }
    }
    fullBrokers.sort((a, b) => a.broker.localeCompare(b.broker));

    const message = noSource
      ? '存在没有任何实际副本的分区，无法发起复制（需要先恢复该分区的副本源）'
      : `所有待复制落点都被占满且无进行中复制可等待，需要在 Broker [${fullBrokers
          .map((b) => b.broker)
          .join(', ')}] 上释放槽位；可通过临时副本腾挪或删除多余副本推进`;
    return {
      kind: 'blocked',
      reason: noSource ? 'no-source-replica' : 'no-free-slot',
      message,
      pending,
      fullBrokers,
    };
  }

  /**
   * 计算下一个动作。推进顺序：
   * 1) 直接复制缺失的目标副本；
   * 2) 安全删除多余的非目标副本——删除护栏（副本数/故障域数下限）
   *    本身保证：只有替代的新副本已经确认追平、实际副本数足够时，
   *    旧副本才可能通过检查被删除，因此无需用 await 阻塞删除；
   * 3) 用临时副本打破成环；
   * 4) 没有任何可立即推进的实体动作时，等待一个进行中复制追平；
   * 5) 无法推进 -> blocked 报告。
   */
  nextStep(): MigrationAction | BlockedReport | { type: 'done' } {
    if (this.isDone()) return { type: 'done' };

    const direct = this.tryDirectReplicate();
    if (direct) return direct;

    const del = this.trySafeDelete();
    if (del) return del;

    const temp = this.tryTemporaryReplica();
    if (temp) return temp;

    const inflight = inflightEntries(this.state).sort((a, b) =>
      a.partition.localeCompare(b.partition)
      || a.broker.localeCompare(b.broker)
      || a.requestId.localeCompare(b.requestId));
    if (inflight.length > 0) {
      const first = inflight[0];
      return { type: 'await', requestId: first.requestId, partition: first.partition, broker: first.broker };
    }

    const noSource = this.partitionOrder.some(
      (pid) => this.missingPlacements(pid).length > 0 && (this.state.actual.get(pid)?.size ?? 0) === 0,
    );
    return this.buildBlockedReport(noSource);
  }

  /** 适配器确认复制追平：进行中副本转为实际副本。 */
  confirmReplica(partition: PartitionId, broker: BrokerId, requestId: string): void {
    const key = slotKey(partition, broker);
    const current = this.state.inflight.get(key);
    if (current === undefined) {
      throw new Error(`没有对应的进行中复制: 分区 ${partition} Broker ${broker}`);
    }
    if (current !== requestId) {
      throw new Error(`requestId 不匹配: 期望 ${current}，收到 ${requestId}`);
    }
    this.state.inflight.delete(key);
    let set = this.state.actual.get(partition);
    if (!set) {
      set = new Set<BrokerId>();
      this.state.actual.set(partition, set);
    }
    set.add(broker);
  }

  /** 适配器取消/失败一个进行中复制：释放它占用的槽位。 */
  cancelInflight(partition: PartitionId, broker: BrokerId): void {
    this.state.inflight.delete(slotKey(partition, broker));
  }

  isDone(): boolean {
    for (const pid of this.partitionOrder) {
      const actual = this.state.actual.get(pid) ?? new Set<BrokerId>();
      const targets = this.targetBrokers(pid);
      if (actual.size !== targets.size) return false;
      for (const b of targets) if (!actual.has(b)) return false;
      for (const b of actual) if (!targets.has(b)) return false;
    }
    return this.state.inflight.size === 0;
  }

  /**
   * 静态便捷方法：在“复制总能成功、追平即时确认”的理想模型下
   * 生成完整动作序列（测试与离线规划使用）。
   */
  static computePlan(
    brokers: BrokerSpec[],
    partitions: PartitionSpec[],
    current: Record<PartitionId, BrokerId[]>,
    target: Assignment,
    inflight: InFlightReplica[] = [],
  ): PlanResult {
    const planner = new MigrationPlanner(brokers, partitions, current, target, inflight);
    const actions: MigrationAction[] = [];
    const maxSteps = 10_000;
    for (let i = 0; i < maxSteps; i++) {
      const step = planner.nextStep();
      if (step.type === 'done') return { ok: true, actions };
      if ('kind' in step && step.kind === 'blocked') return { ok: false, blocked: step };
      actions.push(step);
      if (step.type === 'replicate') {
        // 理想模型：复制立即追平。显式产出 await 动作，使动作轨迹完整
        // （replicate 占用槽位 -> await 追平转实际 -> 之后才可删除旧副本）。
        const requestId = planner.state.inflight.get(slotKey(step.partition, step.target))!;
        actions.push({
          type: 'await',
          requestId,
          partition: step.partition,
          broker: step.target,
        });
        planner.confirmReplica(step.partition, step.target, requestId);
      }
    }
    throw new Error('迁移规划超过最大步数，疑似存在无法收敛的循环');
  }
}
