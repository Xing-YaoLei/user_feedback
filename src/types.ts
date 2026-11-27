/**
 * 计数 Bloom 兴趣摘要的公共类型。
 */

/** 哈希参数与向量容量，由调用方指定。 */
export interface BloomConfig {
  /** 计数向量长度（位/槽数量），必须为正整数。 */
  size: number;
  /** 每个主题命中的哈希位置数量，必须为正整数。 */
  hashes: number;
  /** Murmur3 基础种子；更换种子等价于更换整套哈希参数。 */
  seed: number;
}

/** 一次登记/撤销操作的结果。 */
export interface MutationResult {
  /** 该订阅者此前是否已登记在该主题上（登记）/ 是否实际存在（撤销）。 */
  changed: boolean;
  /** 操作后该主题是否仍有至少一个订阅者。 */
  topicActive: boolean;
  /** 操作后该主题上的订阅者数量。 */
  subscriberCount: number;
}

/** 重建所处的阶段。 */
export type RebuildPhase = 'sweep' | 'drain' | 'paused' | 'aborted' | 'published';

/** 发起分步重建时的预算与节奏控制。 */
export interface RebuildOptions {
  /**
   * 候选向量可接受的不同有效主题数量上限。
   * 当候选占用（已接受主题数）超过该预算时，候选被明确中止，
   * 已经在当前（旧）代次上接受的登记继续有效。
   */
  topicBudget?: number;
  /** 每个 step() 在 sweep 阶段最多处理的主题数量，默认 1。 */
  batchSize?: number;
}

/** 重建进度快照。 */
export interface RebuildProgress {
  phase: RebuildPhase;
  /** sweep 阶段剩余待处理的主题数。 */
  remaining: number;
  /** 开始重建时纳入扫描的主题总数。 */
  total: number;
  /** 候选已经接受的不同有效主题数。 */
  accepted: number;
  /** 重建期间挂起、将在 drain 阶段对账的脏主题数。 */
  pendingChanges: number;
  /** 中止原因（仅在 aborted 时存在）。 */
  abortReason?: string;
}

/** 代次描述信息。 */
export interface GenerationInfo {
  /** 代次编号，初始为 0，每次成功发布后递增。 */
  generation: number;
  config: BloomConfig;
  /** 该代次向量当前的槽位总和（诊断用）。 */
  vectorSum: number;
}
