/**
 * 副本分配与迁移规划的公共类型定义。
 *
 * 约定：
 * - Broker ID、分区 ID 均为字符串，比较时按字典序确定唯一顺序。
 * - 复制成本以「分区 -> Broker」矩阵给出，仅用于评估新落点（目标中
 *   保留的既有副本不产生复制成本）。
 */

/** 单个 Broker 的静态信息：副本槽位容量与所属故障域。 */
export interface BrokerSpec {
  id: string;
  /** 该 Broker 可承载的最大副本数（含复制中的临时副本）。 */
  capacity: number;
  /** 故障域标识，同一分区的副本不允许落在同一故障域内。 */
  faultDomain: string;
}

/** 单个分区的需求与当前实际位置。 */
export interface PartitionSpec {
  id: string;
  /** 要求达到的副本数。 */
  replicationFactor: number;
  /** 复制成本矩阵：cost[brokerId] 为把该分区复制到该 Broker 的成本。 */
  cost: Record<string, number>;
  /** 当前实际存在（已追平）的副本所在 Broker。 */
  currentReplicas: string[];
}

/** 规划输入拓扑。 */
export interface Topology {
  brokers: BrokerSpec[];
  partitions: PartitionSpec[];
}

/** 一个完整的目标分配方案：分区 -> 副本所在 Broker 列表（已排序）。 */
export type Assignment = Record<string, string[]>;

/** 不可行时返回的、可核对的阻塞依据。 */
export type InfeasibleReason =
  | {
      kind: 'insufficient-fault-domains';
      partitionId: string;
      replicationFactor: number;
      availableFaultDomains: number;
      detail: string;
    }
  | {
      kind: 'insufficient-brokers';
      partitionId: string;
      replicationFactor: number;
      availableBrokers: number;
      detail: string;
    }
  | {
      kind: 'insufficient-total-capacity';
      requiredSlots: number;
      availableSlots: number;
      detail: string;
    }
  | {
      kind: 'no-feasible-assignment';
      /** 搜索失败时，能复现阻塞的最小分区子集（按分区 ID 排序）。 */
      blockingPartitions: string[];
      /** 该子集的总副本需求与总可用槽位，便于核对容量关系。 */
      requiredSlots: number;
      availableSlots: number;
      detail: string;
    };

/** 分配求解结果。 */
export type AllocationResult =
  | {
      feasible: true;
      assignment: Assignment;
      /** 目标方案中所有新落点的复制成本之和（保留的既有副本不计成本）。 */
      totalNewReplicaCost: number;
      /** 每个分区的新落点 Broker（目标集合减去当前实际集合）。 */
      newReplicas: Assignment;
    }
  | {
      feasible: false;
      reason: InfeasibleReason;
    };
