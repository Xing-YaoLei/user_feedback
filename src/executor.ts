/**
 * 迁移执行器：以真实存在的副本为基线，通过可控异步适配器推进迁移。
 *
 * 处理的运行时情形：
 * - 复制异步完成，完成前 inflight 副本一直占槽位；
 * - Broker 退出：剔除该 Broker 上的全部实际/进行中副本，相关复制
 *   一律失败，之后基于剩余真实副本重新规划；
 * - 新的规划请求：对当前真实状态（含 inflight 占用）重新求最优目标，
 *   再继续推进；
 * - 迟到的复制结果：结果回来时先核对请求是否仍被当前规划接纳，
 *   inflight 计入占用后再决定“接纳（转实际）”还是“清理（释放槽位）”。
 */

import { ManualReplicationAdapter, type ReplicationAdapter } from './adapter.ts';
import { planAllocation } from './allocator.ts';
import { MigrationPlanner } from './planner.ts';
import { buildClusterState, inflightEntries, parseSlotKey, slotKey, usageOf } from './state.ts';
import type {
  AllocationResult,
  Assignment,
  BlockedReport,
  BrokerId,
  BrokerSpec,
  InFlightReplica,
  MigrationAction,
  PartitionId,
  PartitionSpec,
  PlannerInput,
} from './types.ts';

export type TickOutcome =
  | { kind: 'replicate'; action: MigrationAction; requestId: string }
  | { kind: 'await'; requestId: string; partition: PartitionId; broker: BrokerId }
  | { kind: 'delete'; action: MigrationAction }
  | { kind: 'done' }
  | { kind: 'blocked'; blocked: BlockedReport }
  | { kind: 'allocation-infeasible'; reason: AllocationResult };

export interface ExecutorEvent {
  at: number;
  type: 'replicate' | 'replica-confirmed' | 'replica-rejected' | 'delete' | 'broker-down' | 'replan';
  partition?: PartitionId;
  broker?: BrokerId;
  requestId?: string;
  detail?: string;
}

export class MigrationExecutor {
  private brokers: BrokerSpec[];
  private readonly partitions: PartitionSpec[];
  /** 当前实际副本（真实存在的副本基线）。 */
  private readonly current: Record<PartitionId, BrokerId[]>;
  /** 当前进行中副本：slotKey -> requestId。 */
  private readonly inflight = new Map<string, string>();
  private target: Assignment;
  private planner!: MigrationPlanner;
  private plannerGeneration = 0;
  private readonly adapter: ReplicationAdapter;
  private tickCount = 0;
  readonly events: ExecutorEvent[] = [];

  constructor(
    brokers: BrokerSpec[],
    partitions: PartitionSpec[],
    current: Record<PartitionId, BrokerId[]>,
    target: Assignment,
    adapter?: ReplicationAdapter,
    inflight: InFlightReplica[] = [],
  ) {
    this.brokers = brokers.map((b) => ({ ...b }));
    this.partitions = partitions.map((p) => ({ ...p, costs: { ...p.costs } }));
    this.current = {};
    for (const [pid, list] of Object.entries(current)) this.current[pid] = [...list];
    for (const r of inflight) this.inflight.set(slotKey(r.partition, r.broker), r.requestId);
    this.target = cloneAssignment(target);
    this.adapter = adapter ?? new ManualReplicationAdapter();
    // 必须在所有字段赋值之后再构造规划器（inflightList 依赖 brokers/current/inflight）
    this.planner = this.newPlanner();
  }

  private inflightList(): InFlightReplica[] {
    const brokerMap = new Map(this.brokers.map((b) => [b.id, b]));
    const actual = new Map<PartitionId, Set<BrokerId>>();
    for (const [pid, list] of Object.entries(this.current)) actual.set(pid, new Set(list));
    return inflightEntries({ brokers: brokerMap, actual, inflight: this.inflight }).map((e) => ({
      partition: e.partition,
      broker: e.broker,
      requestId: e.requestId,
    }));
  }

  private newPlanner(): MigrationPlanner {
    this.plannerGeneration += 1;
    return new MigrationPlanner(
      this.brokers,
      this.partitions,
      this.current,
      this.target,
      this.inflightList(),
      `gen${this.plannerGeneration}-rep`,
    );
  }

  private buildInput(): PlannerInput {
    return {
      brokers: this.brokers,
      partitions: this.partitions,
      current: this.current,
      inflight: this.inflightList(),
    };
  }

  /** 基于当前真实状态重新求最优目标并替换规划（新的规划请求）。 */
  replan(newTarget?: Assignment): AllocationResult {
    if (newTarget) {
      this.target = cloneAssignment(newTarget);
    } else {
      const result = planAllocation(this.buildInput());
      if (!result.ok) return result;
      this.target = cloneAssignment(result.assignment);
    }
    this.planner = this.newPlanner();
    this.events.push({ at: this.tickCount, type: 'replan', detail: '基于真实副本基线重新规划' });
    return { ok: true, assignment: this.target, cost: 0 };
  }

  private addActual(partition: PartitionId, broker: BrokerId): void {
    if (!this.current[partition]) this.current[partition] = [];
    if (!this.current[partition].includes(broker)) this.current[partition].push(broker);
  }

  /**
   * 结算适配器侧已经完成的复制。
   *
   * 对每个已结算请求，先确认它是否仍以同一 requestId 占着槽位
   * （executor.inflight）。占槽位的结果一律先计入占用核对，再按
   * “当前目标是否需要该落点、Broker 是否存活、复制是否成功”决定：
   * - 三者都满足 -> 接纳，inflight 转实际副本；
   * - 否则 -> 清理，仅释放槽位，不改变实际副本基线。
   *
   * 这样即使请求是规划变更前发出的“迟到结果”，也不会被错误接纳。
   */
  private settleCompleted(): void {
    for (const req of this.adapter.settledRequests()) {
      const key = slotKey(req.partition, req.target);
      const liveRequestId = this.inflight.get(key);
      if (liveRequestId !== req.requestId) {
        // 不占当前槽位（已被故障处理/先前结算冲掉）：忽略。
        continue;
      }

      // 它确实还占着槽位：先摘下 inflight 占用，再决定接纳还是清理。
      this.inflight.delete(key);
      if (this.planner.state.inflight.get(key) === req.requestId) {
        this.planner.cancelInflight(req.partition, req.target);
      }

      const wanted = (this.target[req.partition] ?? []).includes(req.target);
      const brokerAlive = this.brokers.some((b) => b.id === req.target);
      const accept = req.succeeded && wanted && brokerAlive;

      if (accept) {
        if (this.planner.state.inflight.has(key)) {
          this.planner.confirmReplica(req.partition, req.target, req.requestId);
        } else if (!this.planner.state.actual.get(req.partition)?.has(req.target)) {
          // planner 已被重建：直接写入实际副本基线
          const set = this.planner.state.actual.get(req.partition) ?? new Set<BrokerId>();
          set.add(req.target);
          this.planner.state.actual.set(req.partition, set);
        }
        this.addActual(req.partition, req.target);
        this.events.push({
          at: this.tickCount,
          type: 'replica-confirmed',
          partition: req.partition,
          broker: req.target,
          requestId: req.requestId,
          detail: liveRequestId === req.requestId ? '复制追平，接纳为实际副本' : undefined,
        });
      } else {
        this.events.push({
          at: this.tickCount,
          type: 'replica-rejected',
          partition: req.partition,
          broker: req.target,
          requestId: req.requestId,
          detail: !req.succeeded
            ? '复制失败，释放占用槽位'
            : !wanted
              ? '迟到结果：当前目标已不需要该落点，清理占用'
              : '迟到结果：目标 Broker 已退出，清理占用',
        });
      }
    }
  }

  /** 推进一个调度步。 */
  tick(): TickOutcome {
    this.tickCount += 1;
    this.settleCompleted();
    if (this.planner.isDone()) return { kind: 'done' };

    const step = this.planner.nextStep();
    if (step.type === 'done') return { kind: 'done' };
    if ('kind' in step && step.kind === 'blocked') return { kind: 'blocked', blocked: step };

    if (step.type === 'replicate') {
      const requestId = this.planner.state.inflight.get(slotKey(step.partition, step.target))!;
      this.inflight.set(slotKey(step.partition, step.target), requestId);
      this.adapter.replicate(requestId, step.partition, step.source, step.target);
      this.events.push({
        at: this.tickCount,
        type: 'replicate',
        partition: step.partition,
        broker: step.target,
        requestId,
        detail: step.temporary ? '临时副本腾挪' : '目标复制',
      });
      return { kind: 'replicate', action: step, requestId };
    }

    if (step.type === 'await') {
      return { kind: 'await', requestId: step.requestId, partition: step.partition, broker: step.broker };
    }

    // delete：从真实基线与规划器状态中同步移除。
    const list = this.current[step.partition] ?? [];
    const idx = list.indexOf(step.broker);
    if (idx >= 0) list.splice(idx, 1);
    this.planner.state.actual.get(step.partition)?.delete(step.broker);
    this.events.push({ at: this.tickCount, type: 'delete', partition: step.partition, broker: step.broker });
    return { kind: 'delete', action: step };
  }

  /**
   * Broker 退出：该 Broker 上的实际副本与进行中复制全部消失，
   * 适配器相关请求失败，然后基于剩余真实副本重新规划。
   * 返回重新分配的结果（可能不可行，调用方可核对阻塞依据）。
   */
  brokerDown(broker: BrokerId): AllocationResult {
    this.tickCount += 1;
    const failedIds = this.adapter.brokerDown(broker);
    for (const pid of Object.keys(this.current)) {
      this.current[pid] = this.current[pid].filter((b) => b !== broker);
    }
    for (const key of [...this.inflight.keys()]) {
      if (parseSlotKey(key).broker === broker) this.inflight.delete(key);
    }
    this.brokers = this.brokers.filter((b) => b.id !== broker);
    this.events.push({
      at: this.tickCount,
      type: 'broker-down',
      broker,
      detail: `失败请求: ${failedIds.join(', ') || '无'}`,
    });

    const result = planAllocation(this.buildInput());
    if (!result.ok) {
      this.planner = this.newPlanner();
      return result;
    }
    return this.replan(result.assignment);
  }

  /** 连续推进直到 done / blocked / 需要等待外部复制结果。 */
  runUntilWaiting(maxTicks = 1000): TickOutcome {
    let last: TickOutcome | null = null;
    for (let i = 0; i < maxTicks; i++) {
      const outcome = this.tick();
      last = outcome;
      if (
        outcome.kind === 'done'
        || outcome.kind === 'blocked'
        || outcome.kind === 'await'
        || outcome.kind === 'allocation-infeasible'
      ) {
        return outcome;
      }
    }
    throw new Error(`runUntilWaiting 超过 ${maxTicks} 步仍未稳定`);
  }

  getTarget(): Assignment {
    return cloneAssignment(this.target);
  }

  getCurrent(): Record<PartitionId, BrokerId[]> {
    const out: Record<PartitionId, BrokerId[]> = {};
    for (const [pid, list] of Object.entries(this.current)) {
      out[pid] = [...list].sort((x, y) => x.localeCompare(y));
    }
    return out;
  }

  getInflight(): InFlightReplica[] {
    return this.inflightList();
  }

  getAdapter(): ReplicationAdapter {
    return this.adapter;
  }

  /** 容量不变量自检：实际 + 进行中占用不超过任一存活 Broker 容量。 */
  assertCapacityHolds(): void {
    const state = buildClusterState(this.brokers, this.current, this.inflightList());
    for (const b of this.brokers) {
      const used = usageOf(state, b.id);
      if (used > b.capacity) {
        throw new Error(`容量不变量被破坏: Broker ${b.id} 占用 ${used} > 容量 ${b.capacity}`);
      }
    }
  }
}

function cloneAssignment(a: Assignment): Assignment {
  const out: Assignment = {};
  for (const [pid, list] of Object.entries(a)) {
    out[pid] = [...list].sort((x, y) => x.localeCompare(y));
  }
  return out;
}
