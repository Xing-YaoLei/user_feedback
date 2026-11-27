import { bloomPositions, identityKey } from './hash.ts';
import type {
  BloomConfig,
  GenerationInfo,
  MutationResult,
  RebuildOptions,
  RebuildPhase,
  RebuildProgress,
} from './types.ts';

/**
 * 一代计数 Bloom 向量及其簿记信息。
 */
interface Generation {
  id: number;
  config: BloomConfig;
  /** 计数向量：每个槽位记录命中它的“不同主题”数量。 */
  vector: Uint32Array;
  /** 每个已接受主题实际贡献过的槽位（去重后的位置）。 */
  contributed: Map<string, number[]>;
}

interface RebuildJob {
  candidate: Generation;
  /** sweep 阶段待处理的主题队列（重建开始时有效主题的快照）。 */
  queue: string[];
  total: number;
  phase: Exclude<RebuildPhase, 'published' | 'aborted'> | 'aborted';
  topicBudget: number;
  batchSize: number;
  /** 重建期间发生过登记/撤销的主题，drain 阶段统一对账。 */
  dirty: Set<string>;
  abortReason?: string;
}

function validateConfig(config: BloomConfig): void {
  if (!Number.isInteger(config.size) || config.size <= 0) {
    throw new RangeError(`BloomConfig.size 必须为正整数，收到: ${String(config.size)}`);
  }
  if (!Number.isInteger(config.hashes) || config.hashes <= 0) {
    throw new RangeError(`BloomConfig.hashes 必须为正整数，收到: ${String(config.hashes)}`);
  }
  if (!Number.isInteger(config.seed)) {
    throw new RangeError(`BloomConfig.seed 必须为整数，收到: ${String(config.seed)}`);
  }
}

/**
 * 联邦 Broker 使用的计数 Bloom 兴趣摘要。
 *
 * 语义要点：
 * - 登记身份为 (subscriber, topic)；同一登记重复加入/撤销无额外影响。
 * - 多个订阅者共享同一主题时，主题对向量只贡献一份，最后一个订阅者
 *   撤销后才移除该主题的贡献。
 * - 同一主题在同一哈希位置重复命中只计一次（位置去重）。
 * - 两个主题碰撞在同一槽位时各自 +1，撤销其中一个只 -1，
 *   不会把另一个主题的贡献清零（无假阴性）。
 * - 查询只访问主题对应的哈希位置。
 * - 支持分步重建（更换容量/哈希参数），重建期间登记与撤销持续生效，
 *   查询始终使用单一代次，绝不混用两代向量。
 */
export class CountingBloomSummary {
  /** 当前对外服务的代次。 */
  private current: Generation;
  /** topic -> 仍登记在该主题上的订阅者集合。 */
  private registry = new Map<string, Set<string>>();
  /** 正在进行的分步重建；不存在时为 null。 */
  private job: RebuildJob | null = null;

  constructor(config: BloomConfig) {
    validateConfig(config);
    this.current = this.createGeneration(0, config);
  }

  // ------------------------------------------------------------------
  // 代次与向量的内部工具
  // ------------------------------------------------------------------

  private createGeneration(id: number, config: BloomConfig): Generation {
    return {
      id,
      config: { ...config },
      vector: new Uint32Array(config.size),
      contributed: new Map(),
    };
  }

  private positionsOf(gen: Generation, topic: string): number[] {
    return bloomPositions(identityKey('', topic), gen.config.size, gen.config.hashes, gen.config.seed);
  }

  /**
   * 把一个主题的贡献加入代次向量。
   * 已贡献过的主题（含其去重位置）不会被重复计入。
   * 返回是否实际加入。
   */
  private addTopicTo(gen: Generation, topic: string): boolean {
    if (gen.contributed.has(topic)) {
      return false;
    }
    const positions = this.positionsOf(gen, topic);
    for (const pos of positions) {
      gen.vector[pos] += 1;
    }
    gen.contributed.set(topic, positions);
    return true;
  }

  /**
   * 从代次向量移除一个主题的贡献。
   * 仅移除它实际贡献过的位置；计数不足时抛错（内部不变量被破坏才会发生）。
   * 返回是否实际移除。
   */
  private removeTopicFrom(gen: Generation, topic: string): boolean {
    const positions = gen.contributed.get(topic);
    if (positions === undefined) {
      return false;
    }
    for (const pos of positions) {
      if (gen.vector[pos] === 0) {
        throw new Error(`内部错误：槽位 ${pos} 计数已为零，无法撤销主题 "${topic}"`);
      }
      gen.vector[pos] -= 1;
    }
    gen.contributed.delete(topic);
    return true;
  }

  private isTopicActive(topic: string): boolean {
    const subs = this.registry.get(topic);
    return subs !== undefined && subs.size > 0;
  }

  // ------------------------------------------------------------------
  // 登记 / 撤销
  // ------------------------------------------------------------------

  /**
   * 登记一个订阅者对某主题的兴趣。重复登记无额外影响。
   * 重建期间同时作用于当前代次与候选代次（候选在 drain 时对账）。
   */
  register(subscriber: string, topic: string): MutationResult {
    let subs = this.registry.get(topic);
    const existed = subs !== undefined && subs.has(subscriber);

    if (!existed) {
      if (subs === undefined) {
        subs = new Set<string>();
        this.registry.set(topic, subs);
      }
      subs.add(subscriber);
      // 主题从无订阅者变为有订阅者：对当前代次向量产生一份新贡献
      if (subs.size === 1) {
        this.addTopicTo(this.current, topic);
      }
    }

    if (this.job !== null) {
      this.job.dirty.add(topic);
    }

    return {
      changed: !existed,
      topicActive: true,
      subscriberCount: this.registry.get(topic)!.size,
    };
  }

  /**
   * 撤销一个订阅者对某主题的兴趣。重复撤销无额外影响。
   * 仅当最后一个订阅者撤销时才移除该主题对向量的贡献。
   */
  unregister(subscriber: string, topic: string): MutationResult {
    const subs = this.registry.get(topic);
    const existed = subs !== undefined && subs.has(subscriber);

    if (existed) {
      subs!.delete(subscriber);
      if (subs!.size === 0) {
        // 最后一个订阅者离开：移除主题贡献（碰撞槽位只减 1，不清零他人）
        this.registry.delete(topic);
        this.removeTopicFrom(this.current, topic);
      }
    }

    if (this.job !== null) {
      this.job.dirty.add(topic);
    }

    const remaining = this.registry.get(topic)?.size ?? 0;
    return {
      changed: existed,
      topicActive: remaining > 0,
      subscriberCount: remaining,
    };
  }

  // ------------------------------------------------------------------
  // 查询：只访问对应哈希位置，且一次查询只读取一个代次
  // ------------------------------------------------------------------

  /**
   * 当前代次下某主题是否“可能有订阅”。
   * 所有对应哈希位置计数均 > 0 才返回 true（允许假阳性，绝不假阴性）。
   */
  hasSubscription(topic: string): boolean {
    // 在一次查询内固定代次快照，重建发布不会让本次查询混用两代向量
    const gen = this.current;
    return this.queryGeneration(gen, topic);
  }

  private queryGeneration(gen: Generation, topic: string): boolean {
    const positions = this.positionsOf(gen, topic);
    for (const pos of positions) {
      if (gen.vector[pos] === 0) {
        return false;
      }
    }
    return true;
  }

  /** 主题当前的订阅者数量。 */
  subscriberCount(topic: string): number {
    return this.registry.get(topic)?.size ?? 0;
  }

  /** 当前是否仍有有效订阅主题。 */
  get hasActiveTopics(): boolean {
    return this.registry.size > 0;
  }

  /** 当前有效主题数量。 */
  get activeTopicCount(): number {
    return this.registry.size;
  }

  // ------------------------------------------------------------------
  // 代次信息与参考向量对照
  // ------------------------------------------------------------------

  get generationId(): number {
    return this.current.id;
  }

  get config(): BloomConfig {
    return { ...this.current.config };
  }

  getGenerationInfo(): GenerationInfo {
    let sum = 0;
    for (const v of this.current.vector) {
      sum += v;
    }
    return {
      generation: this.current.id,
      config: { ...this.current.config },
      vectorSum: sum,
    };
  }

  /**
   * 用当前有效主题集合按指定配置“直接重建”出参考向量。
   * 不依赖任何增量簿记，用于与当前/候选代次逐项对照。
   */
  buildReferenceVector(config: BloomConfig = this.current.config): Uint32Array {
    validateConfig(config);
    const ref = new Uint32Array(config.size);
    for (const topic of this.registry.keys()) {
      const positions = bloomPositions(
        identityKey('', topic),
        config.size,
        config.hashes,
        config.seed,
      );
      const seen = new Set<number>();
      for (const pos of positions) {
        if (!seen.has(pos)) {
          seen.add(pos);
          ref[pos] += 1;
        }
      }
    }
    return ref;
  }

  /**
   * 当前代次计数与“按当前有效主题集合直接重建”的参考向量逐项对照。
   */
  verifyCurrent(): boolean {
    const ref = this.buildReferenceVector(this.current.config);
    return this.vectorsEqual(this.current.vector, ref);
  }

  /**
   * 候选代次计数与其配置下的直接重建参考向量逐项对照。
   * 仅在重建进行中可用。
   */
  verifyCandidate(): boolean {
    if (this.job === null) {
      throw new Error('当前没有进行中的重建，无法校验候选向量');
    }
    const candidate = this.job.candidate;
    const ref = this.buildReferenceVector(candidate.config);
    return this.vectorsEqual(candidate.vector, ref);
  }

  private vectorsEqual(a: Uint32Array, b: Uint32Array): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  /** 返回当前代次向量的副本（诊断/对照用）。 */
  snapshotVector(): Uint32Array {
    return new Uint32Array(this.current.vector);
  }

  /** 返回候选代次向量的副本（重建进行中可用）。 */
  snapshotCandidateVector(): Uint32Array {
    if (this.job === null) {
      throw new Error('当前没有进行中的重建，无法读取候选向量');
    }
    return new Uint32Array(this.job.candidate.vector);
  }

  /** 用候选代次（而非当前代次）回答一次查询，用于验证两代查询不混用。 */
  queryCandidate(topic: string): boolean {
    if (this.job === null) {
      throw new Error('当前没有进行中的重建，无法查询候选向量');
    }
    return this.queryGeneration(this.job.candidate, topic);
  }

  // ------------------------------------------------------------------
  // 分步重建
  // ------------------------------------------------------------------

  /**
   * 发起一次分步重建，更换容量和/或哈希参数。
   * 重建期间所有登记/撤销继续作用于当前代次，查询仍走旧代次；
   * 发布（publishRebuild）之后查询才切换到新摘要。
   */
  startRebuild(newConfig: BloomConfig, options: RebuildOptions = {}): RebuildProgress {
    if (this.job !== null) {
      throw new Error('已有进行中的重建，请先发布、放弃或等待其中止');
    }
    validateConfig(newConfig);

    const candidate = this.createGeneration(this.current.id + 1, newConfig);
    const queue = Array.from(this.registry.keys());
    const topicBudget = options.topicBudget ?? Number.POSITIVE_INFINITY;
    const batchSize = options.batchSize ?? 1;
    if (topicBudget !== Number.POSITIVE_INFINITY && (!Number.isInteger(topicBudget) || topicBudget < 0)) {
      throw new RangeError(`topicBudget 必须为非负整数，收到: ${String(topicBudget)}`);
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError(`batchSize 必须为正整数，收到: ${String(batchSize)}`);
    }

    this.job = {
      candidate,
      queue,
      total: queue.length,
      phase: 'sweep',
      topicBudget,
      batchSize,
      dirty: new Set<string>(),
    };

    return this.getProgress();
  }

  /**
   * 推进一步重建。sweep 阶段按 batchSize 扫描快照中的主题，
   * 扫描完成后进入 drain，对重建期间的全部登记/撤销做一次对账。
   * 候选占用超过预算时明确中止候选：旧代次与已接受登记继续有效。
   */
  stepRebuild(): RebuildProgress {
    const job = this.job;
    if (job === null) {
      throw new Error('当前没有进行中的重建');
    }
    if (job.phase === 'paused') {
      throw new Error('重建已暂停，请先 resumeRebuild()');
    }
    if (job.phase === 'aborted' || job.phase === 'drain') {
      if (job.phase === 'drain') {
        this.drain(job);
      }
      return this.getProgress();
    }

    // sweep：本步处理至多 batchSize 个快照主题
    let processed = 0;
    while (processed < job.batchSize && job.queue.length > 0) {
      const topic = job.queue.shift()!;
      processed += 1;
      // 仅当主题在当前有效集合中时才让候选接受它
      if (this.isTopicActive(topic)) {
        if (job.candidate.contributed.size >= job.topicBudget) {
          this.abortJob(`候选占用超过重建预算 topicBudget=${job.topicBudget}`);
          return this.getProgress();
        }
        this.addTopicTo(job.candidate, topic);
      }
    }

    if (job.queue.length === 0) {
      this.drain(job);
    }
    return this.getProgress();
  }

  /**
   * drain：把重建期间挂起的所有变更一次性对账到候选，
   * 使候选恰好反映“当前有效主题集合”。每个脏主题只对账一次。
   */
  private drain(job: RebuildJob): void {
    job.phase = 'drain';
    for (const topic of job.dirty) {
      const shouldHave = this.isTopicActive(topic);
      const has = job.candidate.contributed.has(topic);
      if (shouldHave && !has) {
        if (job.candidate.contributed.size >= job.topicBudget) {
          this.abortJob(`候选占用超过重建预算 topicBudget=${job.topicBudget}`);
          return;
        }
        this.addTopicTo(job.candidate, topic);
      } else if (!shouldHave && has) {
        this.removeTopicFrom(job.candidate, topic);
      }
    }
    job.dirty.clear();
  }

  private abortJob(reason: string): void {
    const job = this.job;
    if (job === null) {
      return;
    }
    job.phase = 'aborted';
    job.abortReason = reason;
  }

  /** 暂停重建（暂停期间 stepRebuild 被拒绝，登记/撤销仍正常）。 */
  pauseRebuild(): RebuildProgress {
    const job = this.job;
    if (job === null) {
      throw new Error('当前没有进行中的重建');
    }
    if (job.phase === 'sweep' || job.phase === 'drain') {
      job.phase = 'paused';
    }
    return this.getProgress();
  }

  /** 继续被暂停的重建，返回其原本所处阶段。 */
  resumeRebuild(): RebuildProgress {
    const job = this.job;
    if (job === null) {
      throw new Error('当前没有进行中的重建');
    }
    if (job.phase !== 'paused') {
      throw new Error(`重建不处于暂停状态，当前阶段: ${job.phase}`);
    }
    // drain 已完成对账则保持 drain；否则回到 sweep
    job.phase = job.queue.length > 0 ? 'sweep' : 'drain';
    return this.getProgress();
  }

  /**
   * 放弃重建：候选向量被丢弃，当前代次不受影响，
   * 重建期间已经接受的登记/撤销在当前代次上继续有效。
   */
  abortRebuild(): RebuildProgress {
    const job = this.job;
    if (job === null) {
      throw new Error('当前没有进行中的重建');
    }
    const progress = this.getProgress();
    this.job = null; // 释放候选向量
    return { ...progress, phase: 'aborted', abortReason: job.abortReason ?? '调用方主动放弃' };
  }

  /**
   * 发布重建：校验候选与直接重建参考向量逐项一致后切换代次。
   * 切换后全部查询改用包含已接受变更的新摘要，旧向量随即释放。
   * 若候选已中止或校验失败，抛出异常且不影响当前代次。
   */
  publishRebuild(): GenerationInfo {
    const job = this.job;
    if (job === null) {
      throw new Error('当前没有进行中的重建');
    }
    if (job.phase === 'aborted') {
      throw new Error(`候选已中止，无法发布: ${job.abortReason ?? '未知原因'}`);
    }
    if (job.phase !== 'drain' || job.queue.length > 0 || job.dirty.size > 0) {
      throw new Error(`重建尚未完成，当前阶段: ${job.phase}，请继续 stepRebuild()`);
    }

    const ref = this.buildReferenceVector(job.candidate.config);
    if (!this.vectorsEqual(job.candidate.vector, ref)) {
      throw new Error('候选向量与直接重建的参考向量不一致，拒绝发布');
    }

    const old = this.current;
    this.current = job.candidate;
    this.job = null;
    // 旧向量及其 contributed 簿记在本次引用释放后可被 GC 回收
    old.vector = new Uint32Array(0);
    old.contributed.clear();

    return this.getGenerationInfo();
  }

  getRebuildProgress(): RebuildProgress | null {
    return this.job === null ? null : this.getProgress();
  }

  private getProgress(): RebuildProgress {
    const job = this.job!;
    return {
      phase: job.phase,
      remaining: job.queue.length,
      total: job.total,
      accepted: job.candidate.contributed.size,
      pendingChanges: job.dirty.size,
      abortReason: job.abortReason,
    };
  }
}
