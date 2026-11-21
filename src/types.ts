/**
 * 拦截器运行模块的公共类型定义。
 *
 * 设计约定：
 * - 每个请求（根请求或子请求）对应一个「作用域」RequestScope；
 * - 插件 (Interceptor) 接收三个参数：上下文 ctx、单次调用的 next、取消信号 signal；
 * - 清理动作通过 ctx.deferCleanup 登记，按作用域内逆注册顺序 await；
 * - 子请求通过 ctx.spawn 发起，继承父上下文并拥有独立的修改视图。
 */

/** 取消传播使用的错误名称，与 Web AbortController 约定一致。 */
export const ABORT_ERROR_NAME = 'AbortError';

/** 清理动作：可返回 Promise，运行模块会等待其完成。 */
export type CleanupFn = () => void | Promise<void>;

/** 下一层 next 的类型：只允许调用一次，返回后续链路的完成 Promise。 */
export type NextFn = () => Promise<void>;

/** 一次执行的结果状态。 */
export type OutcomeStatus =
  | 'completed' // 整条链路正常完成
  | 'failed' // 发生业务错误
  | 'cancelled' // 因取消信号而中止
  | 'aborted'; // 取消时仍有在途执行，整体被中止（含迟到失败）

/** 错误类别：业务错误优先于清理错误。 */
export type ErrorKind = 'business' | 'cleanup';

/** 排序后保留下来的错误条目（保留原始错误对象与稳定排序信息）。 */
export interface ErrorEntry {
  kind: ErrorKind;
  /** 产生该错误的作用域创建序号。 */
  scopeSeq: number;
  /**
   * 作用域内的稳定序号：
   * - 业务错误：发生先后的登记序号；
   * - 清理错误：对应清理动作的注册序号（数字越小注册越早）。
   */
  order: number;
  /** 原始错误对象（同一异常沿多层 next 传播时，此处始终是同一个对象引用）。 */
  error: unknown;
  /** 便于断言/展示的快照信息，不依赖 Error 的不可枚举属性。 */
  message: string;
  name: string;
}

/** 迟到调用诊断事件的类别。 */
export type DiagnosticKind =
  | 'late-failure' // 作用域关闭后，在途执行才以失败告终
  | 'late-next' // 作用域关闭后再次调用 next
  | 'late-cleanup' // 作用域关闭后才登记清理动作
  | 'late-stream-end' // 流终结后再次尝试 end/error 终结
  | 'stream-destroyed-on-cleanup'; // 清理边界到达时仍在输出的流被销毁

/** 迟到调用诊断事件，全部带原请求 ID（以及具体作用域 ID）。 */
export interface DiagnosticEvent {
  kind: DiagnosticKind;
  /** 原请求 ID：沿调用链始终可追溯到最初的根请求。 */
  requestId: string;
  /** 具体产生事件的作用域 ID。 */
  scopeId: string;
  message: string;
  detail?: unknown;
  at: number;
}

/** 一个请求（作用域）执行结束后的完整结果。 */
export interface RequestOutcome {
  requestId: string;
  scopeId: string;
  status: OutcomeStatus;
  /** 主错误：业务错误优先；同类按作用域创建序号与注册序号稳定排序后的第一个。 */
  mainError: ErrorEntry | null;
  /** 附加错误：除主错误外的其余错误，保持同一稳定排序。 */
  additionalErrors: ErrorEntry[];
  /** 本作用域产生的全部错误（含主错误），已按稳定顺序排列并去重。 */
  errors: ErrorEntry[];
  /** 本请求执行过程中（含关闭后的迟到事件）产生的诊断。 */
  diagnostics: DiagnosticEvent[];
  /** 响应流是否曾开始输出。 */
  responseStarted: boolean;
  /** 响应流的终结方式；null 表示从未开始输出。 */
  responseEnded: 'end' | 'error' | 'destroyed' | null;
  /** 响应终结次数：正确实现下恒为 0 或 1。 */
  responseTerminationCount: number;
  /** 该作用域内实际执行的清理动作数量（不含被拒绝的迟到登记）。 */
  cleanupCount: number;
  /** 作用域创建序号，根请求从 0 开始。 */
  scopeSeq: number;
}

/** 发起子请求时的可选参数。 */
export interface SpawnOptions {
  /** 子请求自己的标识后缀；默认自动生成 `:child<n>`。 */
  id?: string;
  /** 在子请求自己的上下文视图上执行的初始化函数，可写入只属于子请求的数据。 */
  init?: (ctx: InterceptorContext) => void | Promise<void>;
  /** 覆盖默认链路（测试或特殊场景使用）。 */
  chain?: Interceptor[];
}

/**
 * 拦截器上下文。
 *
 * 除固定的运行时能力外，允许插件自由挂载业务字段（字符串索引签名）。
 * 子请求通过原型链继承父上下文：读操作穿透到父级，写操作只落在自己的视图上。
 */
export interface InterceptorContext {
  /** 当前请求 ID（根请求 ID，子请求与其根请求共享该值）。 */
  readonly requestId: string;
  /** 当前作用域 ID（子请求拥有独立 ID）。 */
  readonly scopeId: string;
  /** 当前作用域在根请求内的嵌套深度，根请求为 0。 */
  readonly depth: number;
  /** 取消信号：父级取消会向下传播。 */
  readonly signal: AbortSignal;
  /** 响应输出流，每个作用域独立拥有一个。 */
  readonly response: import('./response-stream.ts').ResponseStream;
  /** 登记一个异步清理动作，返回注销句柄（正常流程无需调用）。 */
  deferCleanup(fn: CleanupFn): () => void;
  /**
   * 发起经过同一套拦截器的子请求。
   * 成功返回子请求结果；失败时 reject，且 error 上附带 outcome 字段。
   * 父级取消后调用会立即以 AbortError 拒绝，且不再接收新的子请求。
   */
  spawn(options?: SpawnOptions): Promise<RequestOutcome>;
  /**
   * 诊断入口：供插件中脱离 await 链的游离回调（如裸 setTimeout）上报迟到事件，
   * 自动附带原请求 ID 与当前作用域 ID。
   */
  reportDiagnostic(kind: DiagnosticKind, message: string, detail?: unknown): void;
  /** 本作用域是否已经关闭（清理完成后为 true，之后的调用走诊断入口）。 */
  readonly closed: boolean;
  /** 允许插件挂载任意业务字段。 */
  [key: string]: unknown;
}

/** 拦截器插件签名。 */
export type Interceptor = (
  ctx: InterceptorContext,
  next: NextFn,
  signal: AbortSignal,
) => void | Promise<void>;
