/**
 * 确定性虚拟时钟调度器。
 *
 * - 所有定时器事件进入最小堆，按虚拟时间排序；同时间事件按自增序号 FIFO。
 * - 随机数来自可种子化的 mulberry32，选举超时抖动因此完全可重复。
 * - advance() 仅在“当前虚拟时间点”上排空到期事件；回调中新调度的、
 *   时间戳不晚于当前时间的事件也会在同一轮被执行（delay=0 的消息即如此）。
 */

import type { Scheduler, TimerHandle } from './types.ts';

interface HeapEvent {
  seq: number;
  runAt: number;
  callback: () => void;
  cancelled: boolean;
}

/** mulberry32：短小确定性 PRNG，足够驱动仿真抖动。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DeterministicScheduler implements Scheduler {
  private time = 0;
  private seq = 0;
  private heap: HeapEvent[] = [];
  private readonly rng: () => number;

  constructor(seed = 1) {
    this.rng = createRng(seed);
  }

  now(): number {
    return this.time;
  }

  schedule(delayMs: number, callback: () => void): TimerHandle {
    if (delayMs < 0) throw new Error('delay must be non-negative');
    const event: HeapEvent = {
      seq: this.seq++,
      runAt: this.time + delayMs,
      callback,
      cancelled: false,
    };
    this.push(event);
    return { id: event.seq };
  }

  cancel(handle: TimerHandle): void {
    // 句柄 id 即入堆序号，堆规模在仿真中很小，线性标记即可。
    for (const event of this.heap) {
      if (event.seq === handle.id) {
        event.cancelled = true;
        return;
      }
    }
  }

  randomInt(min: number, max: number): number {
    if (max <= min) throw new Error(`bad range [${min}, ${max})`);
    return min + Math.floor(this.rng() * (max - min));
  }

  pendingCount(): number {
    return this.heap.filter((e) => !e.cancelled).length;
  }

  /**
   * 推进时钟并执行到期事件，返回执行的事件数。
   * 注意：稳态集群的心跳/选举定时器是常驻事件，堆不会自然清空，
   * 调用方应配合 advanceTo / 预算与外部收敛条件使用，而不是等待 pending=0。
   */
  advance(maxSteps = 100_000): number {
    let executed = 0;
    let timeOfLastProgress = this.time;
    let eventsSinceProgress = 0;
    while (executed < maxSteps) {
      const top = this.top();
      if (!top) break;
      // 没有到期事件时，直接把时钟跳到下一个事件时间。
      if (top.runAt > this.time) this.time = top.runAt;
      const event = this.pop();
      if (!event || event.cancelled) continue;
      if (event.runAt > this.time) this.time = event.runAt;
      executed++;
      event.callback();

      // 活锁判据：连续一大批事件都没有推进虚拟时钟（零延迟消息自转）。
      if (this.time === timeOfLastProgress) {
        eventsSinceProgress++;
        if (eventsSinceProgress >= 10_000) {
          throw new Error('advance detected livelock: 10000 events without clock progress');
        }
      } else {
        timeOfLastProgress = this.time;
        eventsSinceProgress = 0;
      }
    }
    return executed;
  }

  advanceTo(when: number, maxSteps = 100_000): number {
    if (when < this.time) throw new Error('cannot move clock backwards');
    let executed = 0;
    while (this.time < when && executed < maxSteps) {
      const top = this.top();
      if (!top || top.runAt > when) break;
      const n = this.advance(maxSteps - executed);
      if (n === 0) break;
      executed += n;
    }
    this.time = when;
    return executed;
  }

  // -- min heap -------------------------------------------------------------

  private top(): HeapEvent | undefined {
    while (this.heap.length > 0 && this.heap[0]!.cancelled) {
      this.pop();
    }
    return this.heap[0];
  }

  private peekReady(): HeapEvent | undefined {
    const top = this.top();
    // 堆顶事件尚未到期时没有任何就绪事件；等待外层推进时钟。
    if (!top || top.runAt > this.time) return undefined;
    return top;
  }

  private push(event: HeapEvent): void {
    const h = this.heap;
    h.push(event);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(h[i]!, h[parent]!)) {
        [h[i], h[parent]] = [h[parent]!, h[i]!];
        i = parent;
      } else break;
    }
  }

  private pop(): HeapEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < h.length && this.less(h[left]!, h[smallest]!)) smallest = left;
        if (right < h.length && this.less(h[right]!, h[smallest]!)) smallest = right;
        if (smallest === i) break;
        [h[i], h[smallest]] = [h[smallest]!, h[i]!];
        i = smallest;
      }
    }
    return top;
  }

  private less(a: HeapEvent, b: HeapEvent): boolean {
    if (a.runAt !== b.runAt) return a.runAt < b.runAt;
    return a.seq < b.seq;
  }
}
