import { ABORT_ERROR_NAME } from './types.ts';
import type {
  CleanupFn,
  DiagnosticKind,
  ErrorEntry,
  ErrorKind,
  Interceptor,
  InterceptorContext,
  RequestOutcome,
  SpawnOptions,
} from './types.ts';
import type { DiagnosticCollector } from './diagnostics.ts';
import { ResponseStream } from './response-stream.ts';
import type { InterceptorRuntime } from './runtime.ts';

/** 构造一个与 Web 约定一致的 AbortError；若已有同类 reason 则原样返回。 */
export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === ABORT_ERROR_NAME) return reason;
  const err = new Error('请求已被取消');
  err.name = ABORT_ERROR_NAME;
  return err;
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: typeof error, message: String(error) };
}

interface ErrorRecord {
  kind: ErrorKind;
  /** 同类错误内的稳定排序键：业务错误为发生序号，清理错误为清理注册序号。 */
  order: number;
  error: unknown;
}

interface CleanupEntry {
  fn: CleanupFn;
  /** 注册序号，注册越早数字越小。 */
  seq: number;
}

/**
 * 构造作用域的上下文「视图」。
 *
 - 子视图以父视图为原型：读穿透到父级，写只落在自己视图（修改视图隔离）；
 - 运行时能力（requestId/signal/response/deferCleanup/spawn 等）作为自身属性挂载，
 *   其中方法类属性不可枚举，避免污染插件的业务字段遍历。
 */
function buildContextView(scope: RequestScope, parentView: InterceptorContext | null): InterceptorContext {
  const view = Object.create(parentView ?? null) as InterceptorContext;
  Object.defineProperties(view, {
    requestId: { value: scope.requestId, enumerable: true },
    scopeId: { value: scope.id, enumerable: true },
    depth: { value: scope.depth, enumerable: true },
    signal: { value: scope.signal, enumerable: true },
    response: { value: scope.response, enumerable: true },
    closed: {
      enumerable: true,
      get: () => scope.closedFlag,
    },
    deferCleanup: { value: (fn: CleanupFn) => scope.registerCleanup(fn), enumerable: false },
    spawn: { value: (options?: SpawnOptions) => scope.spawnChild(options), enumerable: false },
    reportDiagnostic: {
      value: (kind: DiagnosticKind, message: string, detail?: unknown) =>
        scope.reportDiagnostic(kind, message, detail),
      enumerable: false,
    },
  });
  return view;
}

/**
 * 一个请求作用域：持有自己的上下文视图、取消控制器、响应流、清理队列与在途执行计数。
 */
export class RequestScope {
  readonly seq: number;
  readonly id: string;
  /** 原请求 ID：根请求与其所有后代作用域共享。 */
  readonly requestId: string;
  readonly depth: number;
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly response: ResponseStream;
  readonly ctx: InterceptorContext;
  readonly chain: Interceptor[];

  private readonly cleanups: CleanupEntry[] = [];
  private cleanupSeqCounter = 0;
  private readonly children: RequestScope[] = [];
  private childCounter = 0;
  private readonly errorRecords: ErrorRecord[] = [];
  private businessOrderCounter = 0;

  /** 在途执行数：已启动但尚未 settle 的 Promise（主要是未被 await 的 next 后续链路）。 */
  private pendingCount = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly closedWaiters: Array<() => void> = [];

  closedFlag = false;
  private cleanupRanCount = 0;
  private outcome: RequestOutcome | null = null;
  private readonly parentAbortListener: (() => void) | null;

  private readonly runtime: InterceptorRuntime;
  private readonly parent: RequestScope | null;

  constructor(
    runtime: InterceptorRuntime,
    parent: RequestScope | null,
    id: string,
    seq: number,
    chain: Interceptor[],
  ) {
    this.runtime = runtime;
    this.parent = parent;
    this.seq = seq;
    this.id = id;
    this.requestId = parent ? parent.requestId : id;
    this.depth = parent ? parent.depth + 1 : 0;
    this.chain = chain;
    this.signal = this.controller.signal;
    this.response = new ResponseStream(this.requestId, this.id, runtime.diagnostics);
    this.ctx = buildContextView(this, parent ? parent.ctx : null);

    // 取消向下传播：父级 abort 时用同一 reason 中止本作用域。
    if (parent) {
      this.parentAbortListener = () => {
        if (!this.signal.aborted) this.controller.abort(parent.signal.reason);
      };
      if (parent.signal.aborted) {
        this.controller.abort(parent.signal.reason);
        this.parentAbortListener = null;
      } else {
        parent.signal.addEventListener('abort', this.parentAbortListener, { once: true });
      }
    } else {
      this.parentAbortListener = null;
    }
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get result(): RequestOutcome | null {
    return this.outcome;
  }

  /**
   * 跟踪一段在途执行。
   *
   * 即使插件提前返回、没有 await 这段 Promise，运行模块仍然通过 pendingCount 跟踪它，
   * 清理边界会等待它真正退出；同时挂兜底 catch，避免游离 Promise 触发 unhandledRejection。
   */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pendingCount++;
    const tracked = promise.then(
      (value) => {
        this.settlePending();
        return value;
      },
      (error) => {
        this.settlePending();
        throw error;
      },
    );
    tracked.catch(() => {});
    return tracked;
  }

  /** 等待所有已启动的在途执行全部退出（可重入，期间允许新增在途执行）。 */
  async whenIdle(): Promise<void> {
    while (this.pendingCount > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  /** 等待作用域关闭（清理完成）。 */
  whenClosed(): Promise<void> {
    if (this.closedFlag) return Promise.resolve();
    return new Promise<void>((resolve) => this.closedWaiters.push(resolve));
  }

  /** 登记异步清理动作；作用域关闭后的迟到登记走诊断入口并被拒绝。 */
  registerCleanup(fn: CleanupFn): () => void {
    if (this.closedFlag) {
      this.reportDiagnostic('late-cleanup', '作用域已关闭，迟到登记的清理动作被拒绝');
      return () => {};
    }
    const entry: CleanupEntry = { fn, seq: this.cleanupSeqCounter++ };
    this.cleanups.push(entry);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const index = this.cleanups.indexOf(entry);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
  }

  /** 发起经过同一套拦截器的子请求。 */
  spawnChild(options: SpawnOptions = {}): Promise<RequestOutcome> {
    // 取消优先：已取消的作用域停止接收新的子请求，统一以 AbortError 拒绝。
    if (this.signal.aborted) {
      return Promise.reject(createAbortError(this.signal.reason));
    }
    // 未取消但已关闭（正常结束后的迟到调用）：走诊断入口。
    if (this.closedFlag) {
      const err = new Error(`作用域 ${this.id} 已关闭，不能再发起子请求`);
      err.name = 'LateCallError';
      this.reportDiagnostic('late-failure', '关闭后迟到的子请求被拒绝', err);
      return Promise.reject(err);
    }

    const childId = options.id ?? `${this.id}>child${this.childCounter++}`;
    const child = this.runtime.createScope(this, childId, options.chain ?? this.chain);
    this.children.push(child);

    // 注意：不能用 this.track(childRun) —— 子作用域生命周期由其自身 run() 跟踪，
    // 父作用域 close 时通过 child.whenClosed() 等待；若再计入父级 pendingCount，
    // 父 whenIdle 会等待一个需要父关闭才能完成的 Promise，形成自等待死锁。
    const childRun = this.runtime.runScope(child, options.init);
    // 同步挂兜底处理器（同一 Promise），杜绝调用方延迟 await 时的 unhandledRejection。
    childRun.then(
      () => {},
      () => {},
    );
    // 非 async 包装：返回的 Promise 与 childRun 同构，reject 时已自带处理器。
    return childRun.then(
      (outcome) => outcome,
      (error: unknown) => {
        if (error instanceof Error && child.result) {
          (error as Error & { outcome?: RequestOutcome }).outcome = child.result;
        }
        throw error;
      },
    );
  }

  /** 供上下文视图调用的诊断入口，自动附带原请求 ID 与作用域 ID。 */
  reportDiagnostic(kind: DiagnosticKind, message: string, detail?: unknown): void {
    this.runtime.diagnostics.report(kind, this.requestId, this.id, message, detail);
  }

  /** 记录业务错误；同一异常沿多层 next 传播只记录一次（运行时级别按引用去重）。 */
  recordBusinessError(error: unknown): void {
    if (!this.runtime.markErrorSeen(error)) return;
    this.errorRecords.push({ kind: 'business', order: this.businessOrderCounter++, error });
  }

  private recordCleanupError(error: unknown, regSeq: number): void {
    if (!this.runtime.markErrorSeen(error)) return;
    this.errorRecords.push({ kind: 'cleanup', order: regSeq, error });
  }

  /** 作用域主入口：执行插件链 → 等待在途执行退出 → 分层清理 → 产出结果。 */
  async run(init?: (ctx: InterceptorContext) => void | Promise<void>): Promise<RequestOutcome> {
    try {
      if (init) await init(this.ctx);
      // 顶层链不重复 track：链内每个被调用的 next 已各自计入在途跟踪。
      await this.dispatchLayer(0);
    } catch (error) {
      // 正常情况下 dispatchLayer 内已记录；这里覆盖 init 失败等兜底路径。
      this.recordBusinessError(error);
    }

    await this.whenIdle();
    await this.close();
    return this.outcome as RequestOutcome;
  }

  /**
   * 洋葱模型分层调度。
   * 每个 next 只允许调用一次；关闭后的迟到 next 调用走诊断入口并返回 rejected Promise。
   */
  private dispatchLayer(index: number): Promise<void> {
    if (index >= this.chain.length) return Promise.resolve();
    const plugin = this.chain[index];
    let called = false;

    const next = (): Promise<void> => {
      if (called) {
        const err = new Error(
          `作用域 ${this.id} 第 ${index} 层的 next 被重复调用，每个 next 只允许调用一次`,
        );
        err.name = 'DoubleNextError';
        if (this.closedFlag) {
          this.reportDiagnostic('late-next', err.message);
        }
        return Promise.reject(err);
      }
      called = true;
      // 即使插件没有 await 这个 next（提前返回），后续链路也作为在途执行被跟踪，
      // 清理边界会等待它真正退出；track 内部挂了兜底 catch，游离拒绝不会变成 unhandledRejection。
      return this.track(this.dispatchLayer(index + 1));
    };

    return (async () => {
      try {
        await plugin(this.ctx, next, this.signal);
      } catch (error) {
        // 业务错误在抛出的第一层记录；rethrow 后沿多层 next 传播时因去重只保留一次。
        this.recordBusinessError(error);
        throw error;
      }
    })();
  }

  /**
   * 清理边界，严格按需求顺序：
   * 1. 等待本身的全部在途执行退出；
   * 2. 先清理子作用域（子作用域内部递归遵循同一顺序）；
   * 3. 等待仍在输出的响应流终结（取消时销毁）；
   * 4. 本作用域清理动作按逆注册顺序逐个 await；
   * 5. 标记关闭并唤醒等待者。
   */
  private async close(): Promise<void> {
    if (this.closedFlag) return;

    await this.whenIdle();

    // 子作用域的关闭由其自身 run 驱动；这里显式等待，保证先子后父。
    for (const child of [...this.children]) {
      await child.whenClosed();
    }

    if (this.response.started && !this.response.isTerminal) {
      if (this.signal.aborted) {
        this.reportDiagnostic(
          'stream-destroyed-on-cleanup',
          '清理边界到达时响应流仍在输出，按取消信号销毁',
        );
        this.response.destroy(this.signal.reason);
      } else {
        // 响应已经开始输出后发生业务失败：以流错误结束流，并保留清理诊断。
        const firstBusiness = this.errorRecords.find((r) => r.kind === 'business');
        if (firstBusiness) {
          this.response.fail(firstBusiness.error);
        }
      }
      await this.response.waitForEnd();
    }

    // 逆注册顺序等待清理完成。
    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      const entry = this.cleanups[i];
      try {
        await entry.fn();
      } catch (error) {
        this.recordCleanupError(error, entry.seq);
      }
      this.cleanupRanCount++;
    }

    if (this.parentAbortListener && this.parent) {
      this.parent.signal.removeEventListener('abort', this.parentAbortListener);
    }

    this.closedFlag = true;
    this.outcome = this.buildOutcome();
    const waiters = this.closedWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private buildOutcome(): RequestOutcome {
    // 稳定排序规则（每个作用域独立排序，ErrorEntry 上携带 scopeSeq 供跨作用域汇总）：
    // 1) 业务错误优先于清理错误；
    // 2) 同类错误按作用域内稳定序号升序：业务错误为发生序号、清理错误为清理注册序号；
    //    跨作用域汇总时再以 ErrorEntry.scopeSeq（作用域创建序号）为首要稳定键。
    const sorted = [...this.errorRecords].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'business' ? -1 : 1;
      return a.order - b.order;
    });

    const errors: ErrorEntry[] = sorted.map((record) => {
      const { name, message } = describeError(record.error);
      return {
        kind: record.kind,
        scopeSeq: this.seq,
        order: record.order,
        error: record.error,
        name,
        message,
      };
    });

    const hasBusinessError = errors.some((e) => e.kind === 'business');
    const status = this.resolveStatus(hasBusinessError);

    return {
      requestId: this.requestId,
      scopeId: this.id,
      status,
      mainError: errors[0] ?? null,
      additionalErrors: errors.slice(1),
      errors,
      diagnostics: [...this.runtime.diagnostics.byScope(this.id)],
      scopeSeq: this.seq,
      responseStarted: this.response.started,
      responseEnded: this.response.terminalState,
      responseTerminationCount: this.response.terminationCount,
      cleanupCount: this.cleanupRanCount,
    };
  }

  private resolveStatus(hasBusinessError: boolean): RequestOutcome['status'] {
    if (hasBusinessError) return this.signal.aborted ? 'aborted' : 'failed';
    if (this.errorRecords.some((r) => r.kind === 'cleanup')) return 'failed';
    return this.signal.aborted ? 'cancelled' : 'completed';
  }

  private settlePending(): void {
    this.pendingCount--;
    if (this.pendingCount === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}
