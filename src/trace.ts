/**
 * 轨迹日志：记录控制面与数据面的关键事件，
 * 供演示与断言提取「撤销传播实际域序列」「数据转发实际域序列」。
 */

export interface TraceEvent {
  /** 仿真逻辑时间（毫秒） */
  readonly time: number;
  /** 事件发生域 */
  readonly domain: string;
  readonly type:
    | 'announce-sent'
    | 'announce-accepted'
    | 'announce-rejected'
    | 'withdraw-sent'
    | 'withdraw-accepted'
    | 'withdraw-rejected'
    | 'route-selected'
    | 'route-withdrawn'
    | 'session-up'
    | 'session-down'
    | 'restart'
    | 'summary-sent'
    | 'request-sent'
    | 'forward';
  readonly destination?: string;
  readonly peer?: string;
  readonly path?: readonly string[];
  readonly reason?: string;
  readonly extra?: Record<string, number | string | boolean>;
}

export class TraceLog {
  private readonly events: TraceEvent[] = [];

  append(ev: TraceEvent): void {
    this.events.push(ev);
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }

  byType(type: TraceEvent['type']): readonly TraceEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /**
   * 提取某目的地撤销传播的实际域序列：
   * 按时间顺序排列首次发送/接收撤销的域（去重保持首次出现顺序）。
   */
  withdrawPropagationSequence(destination: string): string[] {
    const seq: string[] = [];
    const seen = new Set<string>();
    for (const ev of this.events) {
      if (ev.destination !== destination) continue;
      if (ev.type !== 'withdraw-sent' && ev.type !== 'withdraw-accepted') continue;
      const domains = [ev.domain];
      if (ev.peer !== undefined && ev.type === 'withdraw-sent') domains.push(ev.peer);
      for (const d of domains) {
        if (!seen.has(d)) {
          seen.add(d);
          seq.push(d);
        }
      }
    }
    return seq;
  }

  /** 数据转发轨迹（forward 事件按时间顺序的域跳转） */
  forwardTraces(destination: string): readonly string[][] {
    const out: string[][] = [];
    for (const ev of this.events) {
      if (ev.type === 'forward' && ev.destination === destination && ev.extra?.step !== undefined) {
        const idx = Number(ev.extra.step);
        const attempt = Number(ev.extra.attempt ?? 0);
        if (!out[attempt]) out[attempt] = [];
        out[attempt][idx] = ev.domain;
      }
    }
    return out.filter((t) => t !== undefined).map((t) => t);
  }

  reset(): void {
    this.events.length = 0;
  }
}
