import { EventEmitter } from 'node:events';
import type { DiagnosticCollector } from './diagnostics.ts';

export type StreamTerminalState = 'end' | 'error' | 'destroyed';

/**
 * 响应输出流。
 *
 * 关键语义：
 * - write 会标记「响应已经开始输出」；
 * - end/error/destroy 都是终结动作，整生命周期内最多生效一次（terminationCount 恒 <= 1）；
 * - 终结之后的迟到 end/error 调用不再改变状态，而是通过诊断入口报告，仍带原请求 ID；
 * - waitForEnd 给出一个在任意终结状态下都会 settle 的 Promise，供清理边界等待。
 */
export class ResponseStream extends EventEmitter {
  readonly chunks: unknown[] = [];
  started = false;
  private state: StreamTerminalState | null = null;
  private terminalReason: unknown = null;
  private _terminationCount = 0;
  private readonly terminalResolvers: Array<() => void> = [];

  private readonly requestId: string;
  private readonly scopeId: string;
  private readonly diagnostics: DiagnosticCollector;

  constructor(requestId: string, scopeId: string, diagnostics: DiagnosticCollector) {
    super();
    this.requestId = requestId;
    this.scopeId = scopeId;
    this.diagnostics = diagnostics;
    // EventEmitter 在无 error 监听器时收到 'error' 会抛出，挂一个兜底空监听器。
    this.on('error', () => {});
  }

  /** 写入一个数据块；流已终结时写入被拒绝并产生诊断。 */
  write(chunk: unknown): boolean {
    if (this.state !== null) {
      this.diagnostics.report(
        'late-stream-end',
        this.requestId,
        this.scopeId,
        '响应流终结后仍尝试 write，已忽略',
        { chunk },
      );
      return false;
    }
    this.started = true;
    this.chunks.push(chunk);
    this.emit('data', chunk);
    return true;
  }

  /** 正常结束流。重复结束只记诊断，不会二次终结。 */
  end(): boolean {
    return this.terminate('end', undefined);
  }

  /** 以流错误结束流（响应已开始输出后的业务失败走这里）。 */
  fail(error: unknown): boolean {
    return this.terminate('error', error);
  }

  /** 清理边界到达时销毁仍在输出的流。 */
  destroy(reason?: unknown): boolean {
    return this.terminate('destroyed', reason);
  }

  get terminalState(): StreamTerminalState | null {
    return this.state;
  }

  get terminationCount(): number {
    return this._terminationCount;
  }

  get isTerminal(): boolean {
    return this.state !== null;
  }

  get reason(): unknown {
    return this.terminalReason;
  }

  /** 等待流到达任意终结状态；已终结时立即 resolve。 */
  waitForEnd(): Promise<void> {
    if (this.state !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.terminalResolvers.push(resolve);
    });
  }

  private terminate(state: StreamTerminalState, reason: unknown): boolean {
    if (this.state !== null) {
      this.diagnostics.report(
        'late-stream-end',
        this.requestId,
        this.scopeId,
        `响应流已以 ${this.state} 终结，迟到的 ${state} 终结被忽略`,
        reason === undefined ? undefined : { reason },
      );
      return false;
    }
    this.state = state;
    this.terminalReason = reason;
    this._terminationCount = 1;
    if (state === 'end') {
      this.emit('end');
    } else if (state === 'error') {
      this.emit('error', reason);
    } else {
      this.emit('close', reason);
    }
    const resolvers = this.terminalResolvers.splice(0);
    for (const resolve of resolvers) resolve();
    return true;
  }
}
