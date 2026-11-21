import { DiagnosticCollector } from './diagnostics.ts';
import { RequestScope, createAbortError } from './scope.ts';
import type {
  Interceptor,
  InterceptorContext,
  RequestOutcome,
  SpawnOptions,
} from './types.ts';

export interface DispatchOptions extends SpawnOptions {
  /** 根请求 ID；默认按 root0、root1 自动生成。 */
  id?: string;
  /** 根请求自带的取消信号；外部 abort 会传播给整条作用域树。 */
  signal?: AbortSignal;
}

/**
 * 拦截器运行时。
 *
 * - 多个根请求并发执行，上下文、取消、清理、错误集合彼此隔离；
 * - 全局维护「已记录错误」集合，保证同一异常沿多层 next 传播只记录一次；
 * - diagnostics() 是带原请求 ID 的迟到调用诊断入口。
 */
export class InterceptorRuntime {
  readonly diagnostics = new DiagnosticCollector();
  private readonly chain: Interceptor[];
  private rootCounter = 0;
  private scopeSeqCounter = 0;
  private readonly roots: RequestScope[] = [];
  /** 已记录过的对象错误（按引用去重）。 */
  private readonly seenObjectErrors = new WeakSet<object>();
  /** 已记录过的原始值错误（按值去重）。 */
  private readonly seenPrimitiveErrors = new Set<string>();

  constructor(chain: Interceptor[]) {
    this.chain = [...chain];
  }

  /** 由作用域工厂调用：创建子作用域，分配全局稳定的创建序号。 */
  createScope(parent: RequestScope | null, id: string, chain?: Interceptor[]): RequestScope {
    const scope = new RequestScope(this, parent, id, this.scopeSeqCounter++, chain ?? this.chain);
    return scope;
  }

  /** 标记错误已记录；返回 false 表示同一异常此前已记录过，应跳过。 */
  markErrorSeen(error: unknown): boolean {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      if (this.seenObjectErrors.has(error as object)) return false;
      this.seenObjectErrors.add(error as object);
      return true;
    }
    const key = `${typeof error}:${String(error)}`;
    if (this.seenPrimitiveErrors.has(key)) return false;
    this.seenPrimitiveErrors.add(key);
    return true;
  }

  /** 执行一个根请求；失败时 reject，并在 error.outcome 上附带完整结果。 */
  async dispatch(options: DispatchOptions = {}): Promise<RequestOutcome> {
    const id = options.id ?? `root${this.rootCounter++}`;
    const root = this.createScope(null, id, options.chain ?? this.chain);
    this.roots.push(root);

    if (options.signal) {
      if (options.signal.aborted) {
        root.controller.abort(options.signal.reason ?? createAbortError());
      } else {
        options.signal.addEventListener(
          'abort',
          () => root.controller.abort(options.signal!.reason ?? createAbortError()),
          { once: true },
        );
      }
    }

    const outcome = await this.runScope(root, options.init);
    return outcome;
  }

  /** 运行某个作用域并统一产出/抛出语义。 */
  async runScope(
    scope: RequestScope,
    init?: (ctx: InterceptorContext) => void | Promise<void>,
  ): Promise<RequestOutcome> {
    const outcome = await scope.run(init);
    if (outcome.mainError) {
      const error = outcome.mainError.error;
      if (error instanceof Error) {
        (error as Error & { outcome?: RequestOutcome }).outcome = outcome;
        throw error;
      }
      const wrapped = new Error(outcome.mainError.message);
      (wrapped as Error & { outcome?: RequestOutcome }).outcome = outcome;
      throw wrapped;
    }
    return outcome;
  }

  /** 取消指定根请求（连同其全部子作用域）。 */
  cancelRoot(requestId: string, reason?: unknown): boolean {
    const root = this.roots.find((r) => r.requestId === requestId);
    if (!root) return false;
    if (!root.signal.aborted) root.controller.abort(reason ?? createAbortError());
    return true;
  }

  /** 取消全部根请求。 */
  cancelAll(reason?: unknown): void {
    for (const root of this.roots) {
      if (!root.signal.aborted) root.controller.abort(reason ?? createAbortError());
    }
  }

  /** 等待全部根请求关闭（清理完成）。 */
  async settleAll(): Promise<RequestOutcome[]> {
    return Promise.all(this.roots.map((r) => r.whenClosed().then(() => r.result as RequestOutcome)));
  }

  /** 诊断入口：全部迟到调用事件。 */
  getDiagnostics(): readonly import('./types.ts').DiagnosticEvent[] {
    return this.diagnostics.all();
  }

  /** 诊断入口：按原请求 ID 查询。 */
  getDiagnosticsFor(requestId: string): readonly import('./types.ts').DiagnosticEvent[] {
    return this.diagnostics.byRequest(requestId);
  }
}
