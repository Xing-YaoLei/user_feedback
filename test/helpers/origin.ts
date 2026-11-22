/**
 * 可控源站（测试专用）：
 * - 按版本提供完整 200、单段 206、If-None-Match/If-Modified-Since 的 304；
 * - 每次调用记录请求范围与条件头部；
 * - Gate 可把调用挂起，用于复现交错（片段重叠、ETag 切换、Vary 变化、
 *   清除时旧回源尚未结束）；
 * - 支持 AbortSignal 中止。
 */

import type { Clock, OriginFetch, OriginRequest, OriginResponse } from '../../src/types.ts';
import { getHeader, parseRangeHeader } from '../../src/headers.ts';

export interface MockResource {
  body: Buffer;
  etag: string;
  lastModified: string;
  cacheControl?: string;
  vary?: string;
  extraHeaders?: Record<string, string>;
}

export interface OriginCall {
  uri: string;
  range: string | undefined;
  headers: Record<string, string>;
  versionAtCall: number;
  aborted: boolean;
}

interface PendingCall {
  req: OriginRequest;
  record: OriginCall;
  settled: boolean;
  resolve: (resp: OriginResponse) => void;
  reject: (err: unknown) => void;
}

export class Gate {
  #held = true;
  #pending: PendingCall[] = [];

  get pending(): number {
    return this.#pending.length;
  }

  get held(): boolean {
    return this.#held;
  }

  /** 放行：之后新调用直通；已挂起的调用仍保留，由 origin.drain/flushPending 完成。 */
  release(): void {
    this.#held = false;
  }

  hold(): void {
    this.#held = true;
  }

  /** 以错误拒绝所有挂起调用（模拟源站崩溃）。 */
  failAll(error: Error): void {
    const pending = this.#pending.splice(0);
    for (const call of pending) {
      if (call.settled) continue;
      call.settled = true;
      call.reject(error);
    }
  }

  take(): PendingCall[] {
    return this.#pending.splice(0);
  }

  enqueue(call: PendingCall): boolean {
    if (!this.#held) return false;
    this.#pending.push(call);
    return true;
  }

  /** 微任务栅栏：等待 fetch 内的入队微任务执行完毕。 */
  static async tick(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }
}

export class ControlledOrigin {
  #versions = new Map<string, MockResource[]>();
  #currentVersion = new Map<string, number>();
  #clock: Clock;
  readonly calls: OriginCall[] = [];
  gate: Gate | null = null;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  setResource(uri: string, ...versions: MockResource[]): void {
    this.#versions.set(uri, versions);
    this.#currentVersion.set(uri, 0);
  }

  addVersion(uri: string, resource: MockResource): number {
    const list = this.#versions.get(uri);
    if (!list) throw new Error(`未知 URI: ${uri}`);
    list.push(resource);
    return list.length - 1;
  }

  switchVersion(uri: string, index: number): void {
    const list = this.#versions.get(uri);
    if (!list || index < 0 || index >= list.length) throw new Error('版本越界');
    this.#currentVersion.set(uri, index);
  }

  version(uri: string): number {
    return this.#currentVersion.get(uri) ?? 0;
  }

  callCount(uri?: string): number {
    return uri ? this.#callsOf(uri).length : this.calls.length;
  }

  #callsOf(uri: string): OriginCall[] {
    return this.calls.filter((c) => c.uri === uri);
  }

  rangesOf(uri: string): Array<string | undefined> {
    return this.#callsOf(uri).map((c) => c.range);
  }

  fetch: OriginFetch = (req) => {
    // 调用进入即记录（含条件头部与范围），便于挂起期间断言
    const record: OriginCall = {
      uri: req.uri,
      range: getHeader(req.headers, 'range'),
      headers: { ...req.headers },
      versionAtCall: this.version(req.uri),
      aborted: false,
    };
    this.calls.push(record);

    return new Promise<OriginResponse>((resolve, reject) => {
      const pending: PendingCall = { req, record, settled: false, resolve, reject };
      const onAbort = () => {
        if (pending.settled) return;
        pending.settled = true;
        record.aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener('abort', onAbort, { once: true });

      if (this.gate && this.gate.held && this.gate.enqueue(pending)) return;
      // 栅栏：保证调用方有机会在回源实际执行前安装/切换 Gate
      Promise.resolve().then(() => {
        if (pending.settled) return;
        if (this.gate && this.gate.held && this.gate.enqueue(pending)) return;
        void this.#respond(pending);
      });
    });
  };

  /** 完成所有挂起调用（Gate 挂起期间由测试驱动）；已中止的调用跳过。 */
  async flushPending(): Promise<void> {
    if (!this.gate) return;
    const calls = this.gate.take();
    for (const call of calls) {
      if (call.settled) continue;
      await this.#respond(call);
    }
  }

  async #respond(call: PendingCall): Promise<void> {
    if (call.settled) return;
    call.settled = true;
    const { req, record } = call;
    const list = this.#versions.get(req.uri);
    if (!list) {
      call.resolve({ status: 404, headers: {}, body: Buffer.alloc(0) });
      return;
    }
    // 响应在当前时刻生成，但记录保留发起时的版本与请求头部
    const versionIndex = this.#currentVersion.get(req.uri) ?? 0;
    const resource = list[versionIndex];
    void record;

    const baseHeaders: Record<string, string> = {
      date: new Date(this.#clock.now()).toUTCString(),
      etag: resource.etag,
      'last-modified': resource.lastModified,
    };
    if (resource.cacheControl) baseHeaders['cache-control'] = resource.cacheControl;
    if (resource.vary) baseHeaders.vary = resource.vary;
    if (resource.extraHeaders) Object.assign(baseHeaders, resource.extraHeaders);

    // 条件校验：If-None-Match 优先
    const inm = getHeader(req.headers, 'if-none-match');
    if (inm !== undefined) {
      const tags = inm.split(',').map((t) => t.trim());
      if (tags.includes(resource.etag) || tags.includes('*')) {
        call.resolve({ status: 304, headers: { ...baseHeaders }, body: Buffer.alloc(0) });
        return;
      }
    } else {
      const ims = getHeader(req.headers, 'if-modified-since');
      if (ims !== undefined) {
        const imsMs = Date.parse(ims);
        const lmMs = Date.parse(resource.lastModified);
        if (!Number.isNaN(imsMs) && !Number.isNaN(lmMs) && lmMs <= imsMs) {
          call.resolve({ status: 304, headers: { ...baseHeaders }, body: Buffer.alloc(0) });
          return;
        }
      }
    }

    // If-Range 失配：忽略 Range，返回完整 200
    const ifRange = getHeader(req.headers, 'if-range');
    const rangeHeader = getHeader(req.headers, 'range');
    const range = rangeHeader ? parseRangeHeader(rangeHeader) : null;
    if (ifRange !== undefined && ifRange.trim() !== resource.etag) {
      call.resolve({
        status: 200,
        headers: { ...baseHeaders, 'content-length': String(resource.body.length) },
        body: Buffer.from(resource.body),
      });
      return;
    }

    if (range) {
      const end = range.end === Number.POSITIVE_INFINITY ? resource.body.length - 1 : Math.min(range.end, resource.body.length - 1);
      const start = Math.min(range.start, resource.body.length);
      if (start >= resource.body.length) {
        call.resolve({
          status: 416,
          headers: { 'content-range': `bytes */${resource.body.length}` },
          body: Buffer.alloc(0),
        });
        return;
      }
      const slice = resource.body.subarray(start, end + 1);
      call.resolve({
        status: 206,
        headers: {
          ...baseHeaders,
          'content-range': `bytes ${start}-${end}/${resource.body.length}`,
          'content-length': String(slice.length),
        },
        body: Buffer.from(slice),
      });
      return;
    }

    call.resolve({
      status: 200,
      headers: { ...baseHeaders, 'content-length': String(resource.body.length) },
      body: Buffer.from(resource.body),
    });
  }
}

/** 简单手动时钟。 */
export class ManualClock implements Clock {
  #ms: number;
  constructor(start = 1_000_000) {
    this.#ms = start;
  }
  now(): number {
    return this.#ms;
  }
  tick(ms: number): void {
    this.#ms += ms;
  }
}
