/**
 * 仿真网络：离散事件驱动的邻居消息传输。
 *
 * 可注入三类故障：
 *   - 丢失 loss（按概率或固定判定函数）
 *   - 乱序 reorder（缓存后延后投递）
 *   - 重复 duplicate（投递副本）
 * 同时提供逻辑定时器，用于会话建立后的摘要重交换与周期性补齐。
 * 所有随机数来自可播种 PRNG，保证同一脚本结果可复现。
 */
import type { RouteMessage, SessionEnvelope } from './types.ts';
import type { TraceLog } from './trace.ts';

/** 路由器侧只依赖该传输接口，便于替换为真实适配器 */
export interface Transport {
  send(from: string, to: string, msg: SessionEnvelope): void;
  schedule(delayMs: number, fn: () => void): void;
  now(): number;
}

export interface LinkFaultPolicy {
  /** 每条消息独立的丢失概率，[0,1) */
  lossProb?: number;
  /** 乱序概率：被选中的消息延后一个抖动窗口再投递 */
  reorderProb?: number;
  /** 重复概率：被选中的消息额外再投递一份副本 */
  duplicateProb?: number;
  /** 也可直接给出确定性判定函数（优先于概率），返回 true 表示故障命中 */
  drop?: (msg: RouteMessage, from: string, to: string, attempt: number) => boolean;
  reorder?: (msg: RouteMessage, from: string, to: string, attempt: number) => boolean;
  duplicate?: (msg: RouteMessage, from: string, to: string, attempt: number) => boolean;
}

/** 可播种 PRNG（mulberry32），保证仿真可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PendingEvent {
  time: number;
  seq: number;
  run: () => void;
}

interface LinkPolicy extends LinkFaultPolicy {
  /** 链路基础传播延迟（毫秒） */
  delayMs: number;
  /** 乱序抖动上限（毫秒） */
  jitterMs: number;
}

export type DeliveryHandler = (from: string, to: string, envelope: SessionEnvelope) => void;

export class SimNetwork implements Transport {
  private queue: PendingEvent[] = [];
  private clock = 0;
  private seqCounter = 0;
  private readonly links = new Map<string, LinkPolicy>();
  private readonly rng: () => number;
  private readonly trace?: TraceLog;
  /** 消息统计（含被丢弃的发送尝试） */
  stats = {
    sent: 0,
    delivered: 0,
    dropped: 0,
    reordered: 0,
    duplicated: 0,
  };
  private handler: DeliveryHandler | null = null;

  constructor(seed = 1, trace?: TraceLog) {
    this.rng = mulberry32(seed);
    this.trace = trace;
  }

  /** 链路键与方向无关（同一物理邻接） */
  private key(a: string, b: string): string {
    return a < b ? `${a}⇄${b}` : `${b}⇄${a}`;
  }

  configureLink(a: string, b: string, policy: LinkPolicy): void {
    this.links.set(this.key(a, b), { delayMs: 10, jitterMs: 20, ...policy });
  }

  setHandler(handler: DeliveryHandler): void {
    this.handler = handler;
  }

  now(): number {
    return this.clock;
  }

  send(from: string, to: string, envelope: SessionEnvelope): void {
    const msg = envelope.payload;
    this.stats.sent++;
    const link = this.links.get(this.key(from, to));
    const policy: LinkPolicy = link ?? { delayMs: 10, jitterMs: 20 };
    const attempt = this.stats.sent;

    const dropHit = policy.drop
      ? policy.drop(msg, from, to, attempt)
      : (policy.lossProb ?? 0) > 0 && this.rng() < (policy.lossProb ?? 0);
    if (dropHit) {
      this.stats.dropped++;
      return;
    }

    const reorderHit = policy.reorder
      ? policy.reorder(msg, from, to, attempt)
      : (policy.reorderProb ?? 0) > 0 && this.rng() < (policy.reorderProb ?? 0);
    let delay = policy.delayMs;
    if (reorderHit) {
      delay += policy.jitterMs + Math.floor(this.rng() * policy.jitterMs);
      this.stats.reordered++;
    }

    this.enqueue(delay, () => {
      this.stats.delivered++;
      this.handler?.(from, to, structuredClone(envelope));
    });

    const dupHit = policy.duplicate
      ? policy.duplicate(msg, from, to, attempt)
      : (policy.duplicateProb ?? 0) > 0 && this.rng() < (policy.duplicateProb ?? 0);
    if (dupHit) {
      this.stats.duplicated++;
      this.enqueue(delay + policy.delayMs, () => {
        this.stats.delivered++;
        this.handler?.(from, to, structuredClone(envelope));
      });
    }
  }

  schedule(delayMs: number, fn: () => void): void {
    this.enqueue(delayMs, fn);
  }

  private enqueue(delay: number, fn: () => void): void {
    this.queue.push({ time: this.clock + Math.max(0, delay), seq: this.seqCounter++, run: fn });
  }

  /** 处理全部到期事件，直到队列耗尽或到达 maxSteps 上限 */
  run(maxSteps = 200_000): void {
    let steps = 0;
    while (this.queue.length > 0) {
      this.queue.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.seq - b.seq));
      const ev = this.queue.shift()!;
      this.clock = ev.time;
      ev.run();
      steps++;
      if (steps >= maxSteps) {
        throw new Error(`仿真事件数超过上限 ${maxSteps}，疑似存在无限循环放大`);
      }
    }
  }

  /** 在逻辑时间 untilMs 内运行（周期定时器可被自然终止），返回是否仍有未处理事件 */
  runUntil(untilMs: number, maxSteps = 500_000): boolean {
    let steps = 0;
    while (this.queue.length > 0) {
      this.queue.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.seq - b.seq));
      const next = this.queue[0];
      if (next.time > untilMs) {
        this.clock = untilMs;
        return true;
      }
      const ev = this.queue.shift()!;
      this.clock = ev.time;
      ev.run();
      steps++;
      if (steps >= maxSteps) {
        throw new Error(`仿真事件数超过上限 ${maxSteps}，疑似存在无限循环放大`);
      }
    }
    this.clock = untilMs;
    return false;
  }

  pending(): number {
    return this.queue.length;
  }

  resetStats(): void {
    this.stats = { sent: 0, delivered: 0, dropped: 0, reordered: 0, duplicated: 0 };
  }
}
