/**
 * 迁移执行器：驱动 MigrationPlanner，通过可控异步适配器执行复制/删除，
 * 并处理运行期的三类扰动：
 *
 * 1. Broker 退出（handleBrokerExit）：以真实存在的副本为基线重建规划；
 * 2. 新的规划请求（replan）：同样只以当前真实副本为基线，忽略尚未确认
 *    的复制结果；
 * 3. 迟到的复制结果：先计入槽位占用，再决定接纳（追平）或清理（删除）。
 *
 * 执行器内部维护 epoch（规划代次），旧代次的异步回调不会污染新规划。
 */

import { type ReplicationAdapter, type ReplicationHandle } from './adapters.ts';
import {
  MigrationPlanner,
  type BlockedReport,
  type MigrationAction,
  type MigrationSnapshot,
  type PlannerInput,
} from './migration.ts';
import type { Assignment, BrokerSpec } from './types.ts';

export type ExecutorEvent =
  | { type: 'action'; epoch: number; action: MigrationAction }
  | { type: 'catchup'; epoch: number; partitionId: string; brokerId: string }
  | {
      type: 'replication-settled';
      epoch: number;
      partitionId: string;
      brokerId: string;
      ok: boolean;
      accepted: boolean;
    }
  | { type: 'broker-exit'; brokerId: string; epoch: number }
  | { type: 'replan'; epoch: number }
  | { type: 'blocked'; epoch: number; report: BlockedReport }
  | { type: 'converged'; epoch: number };

export interface ExecutorOptions {
  brokers: BrokerSpec[];
  partitionIds: string[];
  target: Assignment;
  /** 规划基线：各分区真实存在（已追平）的副本。 */
  initial: Assignment;
  adapter: ReplicationAdapter;
}

interface PendingDelete {
  epoch: number;
  partitionId: string;
  brokerId: string;
}

interface ActiveReplication {
  handle: ReplicationHandle;
  epoch: number;
  temporary: boolean;
}

export class MigrationExecutor {
  private planner: MigrationPlanner;
  private brokers: BrokerSpec[];
  private readonly target: Assignment;
  private readonly partitionIds: string[];
  private readonly adapter: ReplicationAdapter;
  private epoch = 0;
  private scheduling = false;
  private pendingDeletes: PendingDelete[] = [];
  /** 当前通过适配器启动、尚未 settle 的复制（跨代次保留以接收迟到结果）。 */
  private activeReplications: ActiveReplication[] = [];
  private readonly listeners = new Set<(e: ExecutorEvent) => void>();
  private convergedAnnounced = false;

  constructor(options: ExecutorOptions) {
    this.brokers = [...options.brokers].sort((a, b) => (a.id < b.id ? -1 : 1));
    this.target = options.target;
    this.partitionIds = [...options.partitionIds].sort();
    this.adapter = options.adapter;
    this.planner = new MigrationPlanner(this.buildPlannerInput(options.initial));
  }

  onEvent(listener: (e: ExecutorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ExecutorEvent): void {
    for (const l of this.listeners) l(event);
  }

  private buildPlannerInput(initial: Assignment): PlannerInput {
    return {
      brokers: this.brokers,
      partitionIds: this.partitionIds,
      target: this.target,
      initial,
    };
  }

  /** 当前规划代次（每次 replan / Broker 退出后递增）。 */
  currentEpoch(): number {
    return this.epoch;
  }

  /** 当前规划器快照（测试可据此核对槽位与副本状态）。 */
  snapshot(): MigrationSnapshot[] {
    return this.planner.snapshot();
  }

  isConverged(): boolean {
    return this.planner.isConverged() && this.pendingDeletes.length === 0;
  }

  /** 启动调度循环（幂等）。 */
  kick(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    queueMicrotask(() => this.schedule());
  }

  private schedule(): void {
    this.scheduling = false;
    if (this.isConverged()) {
      if (!this.convergedAnnounced) {
        this.convergedAnnounced = true;
        this.emit({ type: 'converged', epoch: this.epoch });
      }
      return;
    }
    this.convergedAnnounced = false;

    let actions: MigrationAction[];
    try {
      actions = this.planner.nextActions();
    } catch (err) {
      this.emit({
        type: 'blocked',
        epoch: this.epoch,
        report: {
          kind: 'target-broker-unavailable',
          partitionId: this.partitionIds[0] ?? '',
          brokerId: '',
          waits: [],
          cyclePartitions: [],
          releaseAt: [],
          tempCandidates: [],
          detail: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }

    if (actions.length === 0) {
      const report = this.planner.blockedReport();
      if (report) this.emit({ type: 'blocked', epoch: this.epoch, report });
      return;
    }

    let needsLaterKick = false;
    for (const action of actions) {
      // release 由执行器自身的删除确认回调（releaseRemoval）驱动，
      // 规划器给出的 release 动作在这里忽略。
      if (action.type === 'release') {
        continue;
      }

      // catchup 不由调度循环主动执行：真实系统中追平发生在复制异步
      // 完成之后，由 onReplicationSettled 回调驱动。规划器状态里的
      // inflight 副本会一直占槽位，直到回调确认追平或中止。
      if (action.type === 'catchup') {
        continue;
      }

      // 动作先落规划器状态（复制中副本立即计入槽位占用）。
      this.planner.applyAction(action);
      this.emit({ type: 'action', epoch: this.epoch, action });

      if (action.type === 'delete') {
        const record: PendingDelete = {
          epoch: this.epoch,
          partitionId: action.partitionId,
          brokerId: action.brokerId,
        };
        this.pendingDeletes.push(record);
        this.adapter
          .deleteReplica(action.partitionId, action.brokerId)
          .then(() => {
            // 仅当代次仍匹配时释放槽位；旧代次的迟到确认由新规划基线吸收。
            if (record.epoch === this.epoch) {
              this.planner.releaseRemoval(action.partitionId, action.brokerId);
              this.pendingDeletes = this.pendingDeletes.filter((d) => d !== record);
              this.kick();
            } else {
              this.pendingDeletes = this.pendingDeletes.filter((d) => d !== record);
            }
          })
          .catch((err) => {
            this.pendingDeletes = this.pendingDeletes.filter((d) => d !== record);
            throw err;
          });
        continue;
      }

      // replicate：通过适配器启动可控异步复制。
      const handle = this.adapter.startReplication(action.partitionId, action.brokerId);
      this.activeReplications.push({
        handle,
        epoch: this.epoch,
        temporary: action.temporary === true,
      });
      this.attachReplication(handle, action.temporary === true);
      needsLaterKick = true;
    }

    if (needsLaterKick) this.kick();
  }

  private attachReplication(handle: ReplicationHandle, temporary: boolean): void {
    const epochAtStart = this.epoch;
    const { partitionId, brokerId } = handle;
    handle.done.then((ok) => {
      this.activeReplications = this.activeReplications.filter(
        (a) => a.handle !== handle,
      );
      this.onReplicationSettled(epochAtStart, partitionId, brokerId, ok, temporary);
    });
  }

  /**
   * 处理复制结果（含迟到结果）。
   * 规则：结果到达时先核对/计入槽位占用，再决定接纳（追平）还是清理。
   * - 失败：inflight 副本从未成为可用副本，直接中止并释放槽位；
   * - 成功且仍在目标内：追平接纳；
   * - 成功但已过期（重新规划改了目标 / Broker 退出）：先登记占用，
   *   再立即清理，并通知适配器删除真实复制出来的副本。
   */
  private onReplicationSettled(
    startedAtEpoch: number,
    partitionId: string,
    brokerId: string,
    ok: boolean,
    temporary: boolean,
  ): void {
    const state = this.planner.snapshot().find((s) => s.partitionId === partitionId)!;
    const alive = this.brokers.some((b) => b.id === brokerId);
    const isInflight = state.inflightReplicas.includes(brokerId);
    const isAvailable = state.availableReplicas.includes(brokerId);
    const isRemoving = state.removingReplicas.includes(brokerId);

    if (!ok) {
      // 失败结果：当前代次仍在等待该副本时，中止 inflight 并释放槽位，
      // 下一轮调度会自动重试；状态中已不存在则安全忽略。
      if (startedAtEpoch === this.epoch && isInflight) {
        this.planner.abortInflight(partitionId, brokerId);
      }
      this.emit({
        type: 'replication-settled',
        epoch: this.epoch,
        partitionId,
        brokerId,
        ok: false,
        accepted: false,
      });
      this.kick();
      return;
    }

    // 成功结果，且副本已是可用状态（重复/迟到通知）：幂等视为接纳。
    if (isAvailable) {
      this.emit({
        type: 'replication-settled',
        epoch: this.epoch,
        partitionId,
        brokerId,
        ok: true,
        accepted: true,
      });
      return;
    }

    if (isRemoving || !alive) {
      // 正处于删除流程，或落点 Broker 已退出：无法接纳。
      // Broker 退出时只做本地状态清理；删除流程中由原删除动作负责适配器。
      if (isInflight) this.planner.abortInflight(partitionId, brokerId);
      this.emit({
        type: 'replication-settled',
        epoch: this.epoch,
        partitionId,
        brokerId,
        ok: true,
        accepted: false,
      });
      this.kick();
      return;
    }

    if (isInflight) {
      // 正常路径：先计入占用（applyAction 已在下发时完成），确认追平接纳。
      this.planner.applyAction({ type: 'catchup', partitionId, brokerId });
      this.emit({ type: 'catchup', epoch: this.epoch, partitionId, brokerId });
      this.emit({
        type: 'replication-settled',
        epoch: this.epoch,
        partitionId,
        brokerId,
        ok: true,
        accepted: true,
      });
      this.kick();
      return;
    }

    // 迟到的成功结果：规划器状态中已无该副本（重新规划改变了目标）。
    // 先登记为 inflight 计入占用，再按当前目标决定接纳或清理。
    const stillWanted =
      (this.target[partitionId] ?? []).includes(brokerId) ||
      (temporary && this.partitionUsesBroker(partitionId, brokerId));
    if (stillWanted) {
      this.planner.applyAction({ type: 'replicate', partitionId, brokerId });
      this.planner.applyAction({ type: 'catchup', partitionId, brokerId });
      this.emit({ type: 'catchup', epoch: this.epoch, partitionId, brokerId });
      this.emit({
        type: 'replication-settled',
        epoch: this.epoch,
        partitionId,
        brokerId,
        ok: true,
        accepted: true,
      });
    } else {
      // 不再需要：登记占用后立即中止并通知适配器清理真实副本。
      this.planner.applyAction({ type: 'replicate', partitionId, brokerId });
      this.planner.abortInflight(partitionId, brokerId);
      void this.adapter.deleteReplica(partitionId, brokerId);
      this.emit({
        type: 'replication-settled',
        epoch: this.epoch,
        partitionId,
        brokerId,
        ok: true,
        accepted: false,
      });
    }
    this.kick();
  }

  private partitionUsesBroker(partitionId: string, brokerId: string): boolean {
    const snap = this.planner.snapshot().find((s) => s.partitionId === partitionId);
    if (!snap) return false;
    return (
      snap.availableReplicas.includes(brokerId) ||
      snap.inflightReplicas.includes(brokerId) ||
      snap.removingReplicas.includes(brokerId)
    );
  }

  /**
   * Broker 退出：丢弃该 Broker 上的一切状态（可用/复制中/待删除），
   * 中止其上复制，然后以剩余真实副本为基线重新规划。
   */
  handleBrokerExit(brokerId: string): void {
    // 中止落在该 Broker 上的在途复制（结果到达时按过期结果处理）。
    this.cancelStaleReplications(brokerId);

    this.brokers = this.brokers.filter((b) => b.id !== brokerId);
    const baseline = this.realReplicaBaseline().map((entry) => {
      entry.replicas = entry.replicas.filter((b) => b !== brokerId);
      return entry;
    });
    this.pendingDeletes = this.pendingDeletes.filter((d) => d.brokerId !== brokerId);
    this.rebuildPlanner(baseline);
    this.emit({ type: 'broker-exit', brokerId, epoch: this.epoch });
    this.kick();
  }

  /**
   * 新的规划请求：只以当前真实存在（已追平）的副本为基线，
   * 复制中、待删除的副本都不进入新基线。
   *
   * 注意：在途的适配器复制不主动取消——真实系统中复制可能仍在后台进行，
   * 其迟到结果到达时先计入占用，再按新目标决定接纳或清理（见
   * onReplicationSettled）。需要强制中止时由调用方通过 Broker 退出触发。
   */
  replan(newTarget: Assignment, newBrokers?: BrokerSpec[]): void {
    if (newBrokers) {
      this.brokers = [...newBrokers].sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    for (const pid of this.partitionIds) {
      this.target[pid] = [...(newTarget[pid] ?? [])].sort();
    }
    const baseline = this.realReplicaBaseline();
    this.pendingDeletes = [];
    this.rebuildPlanner(baseline);
    this.emit({ type: 'replan', epoch: this.epoch });
    this.kick();
  }

  /**
   * 取消所有在途复制。Broker 退出时只取消落在退出 Broker 上的；
   * 重新规划时取消全部。取消通过适配器句柄完成，done 以失败 settle，
   * 回调再按代次/状态决定忽略或清理。
   */
  private cancelStaleReplications(brokerId?: string): void {
    const stale = this.activeReplications.filter(
      (a) => brokerId === undefined || a.handle.brokerId === brokerId,
    );
    for (const entry of stale) {
      void entry.handle.cancel();
    }
  }

  /** 当前真实存在（已追平）的副本基线。 */
  private realReplicaBaseline(): Array<{ partitionId: string; replicas: string[] }> {
    return this.planner.snapshot().map((s) => ({
      partitionId: s.partitionId,
      replicas: [...s.availableReplicas],
    }));
  }

  private rebuildPlanner(
    baseline: Array<{ partitionId: string; replicas: string[] }>,
  ): void {
    const initial: Assignment = {};
    for (const entry of baseline) initial[entry.partitionId] = entry.replicas;
    this.epoch += 1;
    this.convergedAnnounced = false;
    this.planner = new MigrationPlanner(this.buildPlannerInput(initial));
  }
}
