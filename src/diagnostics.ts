import type { DiagnosticEvent, DiagnosticKind } from './types.ts';

/**
 * 诊断收集器：运行时级别单例，收集「迟到调用」等不适合再走正常错误通道的事件。
 *
 * 所有事件都带原请求 ID，即使作用域已经关闭、请求 Promise 已经 settle，
 * 外部仍可通过 runtime.diagnostics() 这个诊断入口查询。
 */
export class DiagnosticCollector {
  private readonly events: DiagnosticEvent[] = [];

  report(
    kind: DiagnosticKind,
    requestId: string,
    scopeId: string,
    message: string,
    detail?: unknown,
  ): DiagnosticEvent {
    const event: DiagnosticEvent = {
      kind,
      requestId,
      scopeId,
      message,
      detail: detail === undefined ? undefined : this.safeDetail(detail),
      at: Date.now(),
    };
    this.events.push(event);
    return event;
  }

  /** 全部诊断事件（按发生时间顺序）。 */
  all(): readonly DiagnosticEvent[] {
    return this.events;
  }

  /** 按原请求 ID 过滤诊断事件。 */
  byRequest(requestId: string): readonly DiagnosticEvent[] {
    return this.events.filter((e) => e.requestId === requestId);
  }

  /** 按作用域 ID 过滤诊断事件。 */
  byScope(scopeId: string): readonly DiagnosticEvent[] {
    return this.events.filter((e) => e.scopeId === scopeId);
  }

  clear(): void {
    this.events.length = 0;
  }

  private safeDetail(detail: unknown): unknown {
    if (detail instanceof Error) {
      return { name: detail.name, message: detail.message };
    }
    return detail;
  }
}
