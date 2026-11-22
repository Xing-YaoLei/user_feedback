/**
 * 副本分配与迁移规划模块的公共类型定义。
 *
 * 约定：
 * - Broker ID、分区 ID、故障域 ID 均为字符串；
 * - 复制成本为非负数字（number，NaN/负数由输入校验拒绝）；
 * - 同一分区的副本必须分布在不同 Broker 与不同故障域上；
 * - “实际副本”指已被 Broker 确认持有的副本；“进行中副本(inflight)”指
 *   复制请求已发出但尚未确认追平的副本，进行中副本同样占用槽位，
 *   但不计入“可用副本数 / 覆盖故障域数”。
 */

export type BrokerId = string;
export type PartitionId = string;
export type DomainId = string;

/** Broker 描述：副本槽位容量与所属故障域。 */
export interface BrokerSpec {
  id: BrokerId;
  domain: DomainId;
  /** 该 Broker 可承载的副本总数上限（实际副本 + 进行中副本）。 */
  capacity: number;
}

/** 单个分区的输入参数。 */
export interface PartitionSpec {
  id: PartitionId;
  /** 目标副本数（replication factor）。 */
  replicas: number;
  /**
   * 复制成本矩阵：costs[brokerId] 表示把该分区的一个新副本落到该 Broker
   * 所需的复制成本。最终目标中“新落点”（相对当前基线不存在的落点）的
   * 成本之和即方案优化目标。
   */
  costs: Record<BrokerId, number>;
}

/** 进行中（尚未确认追平）的副本，同样占用 Broker 槽位。 */
export interface InFlightReplica {
  partition: PartitionId;
  broker: BrokerId;
  /** 发起该复制的适配器请求标识，用于与迟到结果对账。 */
  requestId: string;
}

/** 分配器/规划器的完整输入。 */
export interface PlannerInput {
  brokers: BrokerSpec[];
  partitions: PartitionSpec[];
  /** 当前实际存在的副本：partition -> Broker ID 列表。 */
  current: Record<PartitionId, BrokerId[]>;
  /** 当前进行中的复制（可选，重新规划时需要带上以计入槽位占用）。 */
  inflight?: InFlightReplica[];
}

/** 一个可行的目标分配：partition -> 排序后的 Broker ID 列表。 */
export type Assignment = Record<PartitionId, BrokerId[]>;

/** 分配不可行时返回的、可核对的阻塞依据。 */
export interface InfeasibleReason {
  kind:
    | 'rf-exceeds-live-brokers'
    | 'not-enough-failure-domains'
    | 'capacity'
    | 'no-broker-available';
  partition: PartitionId | null;
  message: string;
  /**
   * kind === 'capacity' 时给出的 Hall 阻塞见证：
   * 把这些分区作为一个集合，它们需要的副本数超过了其可用 Broker
   * 的剩余槽位总和。
   */
  witness?: {
    partitions: PartitionId[];
    requiredSlots: number;
    availableBrokers: BrokerId[];
    availableSlots: number;
  };
  /** kind === 'not-enough-failure-domains' 时给出的域相关数据。 */
  domains?: {
    required: number;
    available: number;
    availableDomains: DomainId[];
  };
}

export type AllocationResult =
  | { ok: true; assignment: Assignment; cost: number }
  | { ok: false; reason: InfeasibleReason };

// ---------------------------------------------------------------------------
// 迁移动作
// ---------------------------------------------------------------------------

export type ActionType = 'replicate' | 'await' | 'delete';

/** 复制动作：在目标 Broker 上为分区创建一个新副本（异步，完成前为 inflight）。 */
export interface ReplicateAction {
  type: 'replicate';
  partition: PartitionId;
  source: BrokerId;
  target: BrokerId;
  /** 若该副本是为打破迁移死锁而建的临时副本，标记为 true。 */
  temporary: boolean;
}

/** 等待某个进行中复制确认追平。 */
export interface AwaitAction {
  type: 'await';
  requestId: string;
  partition: PartitionId;
  broker: BrokerId;
}

/** 删除一个实际存在的副本（进行中副本的清理走适配器 cancel，不在此列）。 */
export interface DeleteAction {
  type: 'delete';
  partition: PartitionId;
  broker: BrokerId;
  /** 删除前该分区的实际副本数（轨迹核对用）。 */
  beforeReplicaCount: number;
  /** 删除前该分区实际副本覆盖的故障域数（轨迹核对用）。 */
  beforeDomainCount: number;
  /** 删除后必须保住的副本数下限：min(删除前数量, 目标副本数)。 */
  retainedFloor: number;
  /** 删除后必须保住的故障域数下限：min(删除前域数, 目标副本数)。 */
  retainedDomainFloor: number;
}

export type MigrationAction = ReplicateAction | AwaitAction | DeleteAction;

/**
 * 迁移无法继续推进时返回的受阻关系。
 * pending 描述“谁需要复制到哪里、卡在哪个满 Broker 上”；
 * fullBrokers 给出需要释放槽位的位置及当前占用者。
 */
export interface BlockedReport {
  kind: 'blocked';
  reason: 'no-free-slot' | 'no-source-replica';
  message: string;
  pending: Array<{
    partition: PartitionId;
    targetBroker: BrokerId;
    /** 该 Broker 上阻止复制的占用（实际/进行中副本）。 */
    occupiedBy: Array<{ partition: PartitionId; broker: BrokerId; inflight: boolean }>;
  }>;
  fullBrokers: Array<{
    broker: BrokerId;
    capacity: number;
    occupants: Array<{ partition: PartitionId; inflight: boolean }>;
    /** 为推进迁移至少需要在该 Broker 上释放的槽位数。 */
    mustRelease: number;
  }>;
}

export type PlanResult =
  | { ok: true; actions: MigrationAction[] }
  | { ok: false; blocked: BlockedReport };
