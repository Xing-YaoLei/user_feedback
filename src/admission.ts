/**
 * 自适应 RPC 准入控制模块。
 *
 * 核心语义：
 * - 请求在开始执行时绑定当前采样轮；每轮取最先完成的 N 个成功调用的延迟作为样本。
 * - 延迟以整数纳秒计，最小记 1；失败与取消不产生延迟样本。
 * - p90 = 排序后向上取整的百分位（ceil(0.9 * n)，1 基）。
 * - 基线 = 含本轮在内最近 K 个已封轮 p90 的最小值。
 * - p90 <= baseline * (1 + tolerance) 时上限 +1；否则
 *   limit = floor(本轮起始上限 * baseline / p90)，并夹在 [minLimit, maxLimit]。
 * - 封轮后旧轮迟到结果不参与新轮计算，但仍正常释放执行占用。
 * - 缩容不取消在途调用；占用降到新上限以下才继续派发。
 * - 等待按到达顺序（FIFO），可取消并有独立期限；执行中取消需等适配器实际退出才归还名额。
 */

/** 单调时钟，返回整数纳秒。 */
export interface MonotonicClock {
  nowNs(): bigint;
}

/** 基于 process.hrtime 的真实单调时钟。 */
export const systemClock: MonotonicClock = {
  nowNs: () => process.hrtime.bigint(),
};

/** 调用方提供的执行适配器。 */
export interface ExecutionAdapter<Req, Res> {
  execute(req: Req, signal: AbortSignal): Promise<Res> | Res;
}

/** 非负有理数，num/den，den > 0，num >= 0。 */
export interface Rational {
  readonly num: number | bigint;
  readonly den: number | bigint;
}

export interface AdmissionConfig {
  /** 初始并发上限。 */
  readonly initialLimit: number;
  /** 并发下限。 */
  readonly minLimit: number;
  /** 并发上限。 */
  readonly maxLimit: number;
  /** 每轮有效样本数 N。 */
  readonly samplesPerRound: number;
  /** 基线保留轮数 K。 */
  readonly baselineRounds: number;
  /** 延迟容忍比例（非负有理数）。 */
  readonly tolerance: Rational;
}

export interface SubmitOptions {
  /** 取消信号：等待中取消立即出队；执行中取消立即拒绝调用方，但名额等适配器退出才归还。 */
  readonly signal?: AbortSignal;
  /** 等待截止时刻（单调时钟绝对纳秒），仅约束排队等待阶段。 */
  readonly deadlineNs?: bigint | number;
  /** 相对等待期限（纳秒），与 deadlineNs 二选一。 */
  readonly timeoutNs?: bigint | number;
}

/** 每轮封轮时输出的报告：样本、基线、上限与真实在途占用。 */
export interface RoundReport {
  readonly roundId: number;
  /** 本轮样本（成功调用延迟，整数纳秒，按完成顺序）。 */
  readonly samplesNs: readonly bigint[];
  readonly p90Ns: bigint;
  readonly baselineNs: bigint;
  /** 本轮起始上限。 */
  readonly startLimit: number;
  /** 封轮决议后的新上限。 */
  readonly limit: number;
  /** 封轮时刻的真实在途占用。 */
  readonly occupancy: number;
  /** 封轮时刻的排队等待数。 */
  readonly waiting: number;
}

export interface Snapshot {
  readonly limit: number;
  readonly occupancy: number;
  readonly waiting: number;
  readonly openRoundId: number | null;
  readonly sealedRoundCount: number;
}

export class CancelledError extends Error {
  constructor(message = 'request cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export class DeadlineExceededError extends Error {
  constructor(message = 'wait deadline exceeded') {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

type Outcome<Res> =
  | { readonly ok: true; readonly value: Res }
  | { readonly ok: false; readonly error: unknown };

interface Round {
  id: number;
  startLimit: number;
  samplesNs: bigint[];
  sealed: boolean;
}

interface Execution {
  round: Round;
  startNs: bigint;
}

type WaiterState = 'waiting' | 'executing' | 'finished';

interface Waiter<Req, Res> {
  req: Req;
  resolve: (value: Res) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
  deadlineNs: bigint | null;
  abort: AbortController;
  state: WaiterState;
  cancelled: boolean;
  callerSettled: boolean;
  execution: Execution | null;
}

function toBigIntPart(value: number | bigint, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  throw new TypeError(`${name} must be an integer or bigint`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

export class AdmissionController<Req = unknown, Res = unknown> {
  private readonly config: AdmissionConfig;
  private readonly adapter: ExecutionAdapter<Req, Res>;
  private readonly clock: MonotonicClock;
  private readonly onRoundSealed: ((report: RoundReport) => void) | undefined;

  private readonly tolNum: bigint;
  private readonly tolDen: bigint;

  private limit: number;
  private occupancyCount = 0;
  private readonly queue: Array<Waiter<Req, Res>> = [];
  private openRound: Round | null = null;
  private nextRoundId = 1;
  private readonly sealedP90s: bigint[] = [];
  private readonly reports: RoundReport[] = [];

  constructor(
    config: AdmissionConfig,
    adapter: ExecutionAdapter<Req, Res>,
    clock: MonotonicClock,
    onRoundSealed?: (report: RoundReport) => void,
  ) {
    assertPositiveInteger(config.minLimit, 'minLimit');
    assertPositiveInteger(config.maxLimit, 'maxLimit');
    assertPositiveInteger(config.initialLimit, 'initialLimit');
    assertPositiveInteger(config.samplesPerRound, 'samplesPerRound');
    assertPositiveInteger(config.baselineRounds, 'baselineRounds');
    if (config.minLimit > config.maxLimit) {
      throw new TypeError('minLimit must not exceed maxLimit');
    }
    if (config.initialLimit < config.minLimit || config.initialLimit > config.maxLimit) {
      throw new TypeError('initialLimit must be within [minLimit, maxLimit]');
    }
    this.tolNum = toBigIntPart(config.tolerance.num, 'tolerance.num');
    this.tolDen = toBigIntPart(config.tolerance.den, 'tolerance.den');
    if (this.tolNum < 0n) throw new TypeError('tolerance.num must be non-negative');
    if (this.tolDen <= 0n) throw new TypeError('tolerance.den must be positive');

    this.config = config;
    this.adapter = adapter;
    this.clock = clock;
    this.onRoundSealed = onRoundSealed;
    this.limit = config.initialLimit;
  }

  /** 提交一个请求；按到达顺序排队，获得名额后开始执行并绑定当前采样轮。 */
  submit(req: Req, opts: SubmitOptions = {}): Promise<Res> {
    let deadlineNs: bigint | null = null;
    if (opts.deadlineNs !== undefined) {
      deadlineNs = BigInt(opts.deadlineNs);
    } else if (opts.timeoutNs !== undefined) {
      deadlineNs = this.clock.nowNs() + BigInt(opts.timeoutNs);
    }

    if (opts.signal?.aborted) {
      return Promise.reject(new CancelledError());
    }
    if (deadlineNs !== null && this.clock.nowNs() >= deadlineNs) {
      return Promise.reject(new DeadlineExceededError());
    }

    return new Promise<Res>((resolve, reject) => {
      const waiter: Waiter<Req, Res> = {
        req,
        resolve,
        reject,
        signal: opts.signal ?? null,
        onAbort: null,
        deadlineNs,
        abort: new AbortController(),
        state: 'waiting',
        cancelled: false,
        callerSettled: false,
        execution: null,
      };
      if (opts.signal) {
        const onAbort = () => this.cancel(waiter);
        waiter.onAbort = onAbort;
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }

  /**
   * 回收已逾期的等待者（按单调时钟判断）。派发路径上也会检查期限；
   * 若系统长时间无事件，可周期性调用本方法触发逾期拒绝。返回回收数量。
   */
  reapExpiredWaiters(): number {
    const now = this.clock.nowNs();
    let reaped = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const w = this.queue[i];
      if (w.callerSettled) {
        this.queue.splice(i, 1);
        continue;
      }
      if (w.deadlineNs !== null && now >= w.deadlineNs) {
        this.queue.splice(i, 1);
        w.state = 'finished';
        w.callerSettled = true;
        this.detach(w);
        w.reject(new DeadlineExceededError());
        reaped++;
      }
    }
    return reaped;
  }

  /** 当前真实状态：生效上限、在途占用、排队数、开放轮与已封轮数。 */
  snapshot(): Snapshot {
    return {
      limit: this.limit,
      occupancy: this.occupancyCount,
      waiting: this.queue.filter((w) => !w.callerSettled).length,
      openRoundId: this.openRound?.id ?? null,
      sealedRoundCount: this.reports.length,
    };
  }

  /** 已封轮的全部报告（逐轮样本、基线、上限、占用）。 */
  roundReports(): readonly RoundReport[] {
    return this.reports;
  }

  private cancel(w: Waiter<Req, Res>): void {
    if (w.callerSettled) return;
    w.cancelled = true;
    w.callerSettled = true;
    this.detach(w);
    if (w.state === 'waiting') {
      w.state = 'finished';
      const i = this.queue.indexOf(w);
      if (i >= 0) this.queue.splice(i, 1);
    }
    // 执行中取消：立即拒绝调用方，但名额占用保持到适配器实际退出（finishExecution）。
    w.reject(new CancelledError());
  }

  private detach(w: Waiter<Req, Res>): void {
    if (w.signal !== null && w.onAbort !== null) {
      w.signal.removeEventListener('abort', w.onAbort);
    }
    w.onAbort = null;
  }

  /** 按到达顺序派发：占用低于当前上限才放行；跳过已取消/已逾期的等待者。 */
  private pump(): void {
    while (this.occupancyCount < this.limit) {
      const w = this.queue.shift();
      if (w === undefined) break;
      if (w.callerSettled) continue;
      if (w.deadlineNs !== null && this.clock.nowNs() >= w.deadlineNs) {
        w.state = 'finished';
        w.callerSettled = true;
        this.detach(w);
        w.reject(new DeadlineExceededError());
        continue;
      }
      this.startExecution(w);
    }
  }

  private startExecution(w: Waiter<Req, Res>): void {
    this.occupancyCount++;
    if (this.openRound === null) {
      this.openRound = {
        id: this.nextRoundId++,
        startLimit: this.limit,
        samplesNs: [],
        sealed: false,
      };
    }
    const round = this.openRound;
    const startNs = this.clock.nowNs();
    w.state = 'executing';
    w.execution = { round, startNs };

    let outcome: Promise<Res> | Res;
    try {
      outcome = this.adapter.execute(w.req, w.abort.signal);
    } catch (error) {
      // 适配器同步崩溃：按失败处理，立即归还名额，不产生样本。
      this.finishExecution(w, { ok: false, error });
      return;
    }
    Promise.resolve(outcome).then(
      (value) => this.finishExecution(w, { ok: true, value }),
      (error) => this.finishExecution(w, { ok: false, error }),
    );
  }

  private finishExecution(w: Waiter<Req, Res>, outcome: Outcome<Res>): void {
    if (w.state !== 'executing') return;
    w.state = 'finished';
    const exec = w.execution;
    w.execution = null;
    // 无论成功/失败/取消/迟到，适配器退出即归还名额。
    this.occupancyCount--;

    if (!w.cancelled && outcome.ok && exec !== null) {
      let latency = this.clock.nowNs() - exec.startNs;
      if (latency < 1n) latency = 1n; // 整数纳秒，最小记一
      const round = exec.round;
      if (!round.sealed) {
        // 仅未封轮时计入样本；封轮后迟到结果只释放占用，不改变决议。
        round.samplesNs.push(latency);
        if (round.samplesNs.length >= this.config.samplesPerRound) {
          this.sealRound(round);
        }
      }
    }

    if (!w.callerSettled) {
      w.callerSettled = true;
      this.detach(w);
      if (outcome.ok) w.resolve(outcome.value);
      else w.reject(outcome.error);
    }
    this.pump();
  }

  private sealRound(round: Round): void {
    round.sealed = true;
    if (this.openRound === round) this.openRound = null;

    const sorted = [...round.samplesNs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // p90：排序后向上取整的百分位（1 基）。
    const idx = Math.ceil((sorted.length * 9) / 10) - 1;
    const p90 = sorted[idx];
    this.sealedP90s.push(p90);

    // 基线：含本轮在内最近 K 个已封轮 p90 的最小值。
    const window = this.sealedP90s.slice(-this.config.baselineRounds);
    let baseline = window[0];
    for (const v of window) if (v < baseline) baseline = v;

    const startLimit = round.startLimit;
    let limit: number;
    if (p90 * this.tolDen <= baseline * (this.tolDen + this.tolNum)) {
      // p90 <= baseline * (1 + tolerance)：上限增加一（不越上限）。
      limit = Math.min(startLimit + 1, this.config.maxLimit);
    } else {
      // limit = floor(本轮起始上限 * baseline / p90)，夹在配置上下限中。
      const scaled = (BigInt(startLimit) * baseline) / p90;
      limit = Number(scaled);
      if (limit < this.config.minLimit) limit = this.config.minLimit;
      if (limit > this.config.maxLimit) limit = this.config.maxLimit;
    }
    this.limit = limit;

    const report: RoundReport = {
      roundId: round.id,
      samplesNs: [...round.samplesNs],
      p90Ns: p90,
      baselineNs: baseline,
      startLimit,
      limit,
      occupancy: this.occupancyCount,
      waiting: this.queue.filter((w) => !w.callerSettled).length,
    };
    this.reports.push(report);
    this.onRoundSealed?.(report);
  }
}
