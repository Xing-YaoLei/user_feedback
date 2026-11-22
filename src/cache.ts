/**
 * 网关共享缓存。
 *
 * 设计要点：
 * - 源站请求（OriginFetch）与时钟（Clock）由调用方注入，便于确定性测试；
 * - 每个 URI 维护若干「表示（representation）」，表示由 Vary 变体 + 强校验器
 *   （ETag）+ 总长度确定，正文以互不重叠的字节片段保存；
 * - 同 URI 同键的回源在「可合法复用」前提下共享，等待者可独立取消，
 *   最后一个等待者离开时中止仍未完成的回源；
 * - 容量按实际保留的区间字节核算，区间重叠通过片段合并不重复计数，LRU 回收；
 * - purge 之后迟到的回源结果不得重新填回缓存，迟到 304 只能更新它验证过的表示。
 */

import {
  type ByteRange,
  type CacheControl,
  type HeadersMap,
  FORWARDABLE_REQUEST_HEADERS,
  PASSTHROUGH_RESPONSE_HEADERS,
  formatContentRange,
  getHeader,
  isStrongEtag,
  parseCacheControl,
  parseContentRange,
  parseHttpDate,
  parseIfNoneMatch,
  parseRangeHeader,
  setHeader,
  strongMatch,
  weakMatch,
} from './headers.ts';
import {
  decideServe,
  evaluateFreshness,
  expiresLifetime,
  isStorable,
  type FreshnessResult,
} from './freshness.ts';
import {
  type Fragment,
  findGaps,
  fragmentBytes,
  insertFragment,
  isComplete,
  isCovered,
  readBytes,
  unionRanges,
} from './ranges.ts';
import type {
  CacheStats,
  Clock,
  GatewayCacheOptions,
  GatewayRequest,
  GatewayResponse,
  OriginFetch,
  OriginRequest,
  OriginResponse,
} from './types.ts';

interface Representation {
  id: number;
  etag: string | undefined;
  lastModified: string | undefined;
  varyFields: string[];
  varyValues: Record<string, string | undefined>;
  fragments: Fragment[];
  totalLength: number;
  responseHeaders: HeadersMap;
  storedAt: number;
  dateMs: number | undefined;
  ageHeaderSeconds: number;
  cacheControl: CacheControl;
  get complete(): boolean;
}

interface UriEntry {
  uri: string;
  reps: Representation[];
  inflight: Map<string, InFlight>;
}

interface Waiter {
  signal: AbortSignal | undefined;
  aborted: boolean;
  onAbort: () => void;
  resolve: (resp: OriginResponse) => void;
  reject: (err: unknown) => void;
}

interface InFlight {
  key: string;
  controller: AbortController;
  waiters: Waiter[];
  settled: boolean;
}

type RevalidateResult =
  | { kind: 'notmodified'; rep: Representation | undefined; response: OriginResponse }
  | { kind: 'replaced'; rep: Representation | undefined; response: OriginResponse }
  | { kind: 'passthrough'; response: OriginResponse };

function makeAbortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function parseAge(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function parseVary(value: string | undefined): string[] {
  if (!value || value.trim() === '*') return value?.trim() === '*' ? ['*'] : [];
  return value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export class GatewayCache {
  readonly #maxBytes: number;
  readonly #origin: OriginFetch;
  readonly #clock: Clock;
  #entries = new Map<string, UriEntry>();
  #lru = new Map<number, { entry: UriEntry; rep: Representation }>();
  #totalBytes = 0;
  #nextRepId = 1;

  constructor(options: GatewayCacheOptions) {
    if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) {
      throw new TypeError('maxBytes 必须是非负有限数');
    }
    this.#maxBytes = options.maxBytes;
    this.#origin = options.origin;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  /** 当前缓存占用与明细（测试与运维观察用）。 */
  stats(): CacheStats {
    return {
      bytes: this.#totalBytes,
      entries: this.#entries.size,
      uris: [...this.#entries.values()].map((entry) => ({
        uri: entry.uri,
        representations: entry.reps.map((rep) => ({
          etag: rep.etag,
          complete: rep.complete,
          totalLength: rep.totalLength,
          bytes: fragmentBytes(rep.fragments),
        })),
      })),
    };
  }

  /**
   * 逐 URI 清除。
   * 注意：不中止在途回源——先前发起的调用仍可拿到响应；
   * 但条目身份已失效，回源 settle 时的写回检查会拒绝把迟到结果填回。
   * 回源本身的中止只由「最后一个等待者离开」触发。
   */
  purge(uri: string): boolean {
    const entry = this.#entries.get(uri);
    if (!entry) return false;
    for (const rep of entry.reps) {
      this.#lru.delete(rep.id);
      this.#totalBytes -= fragmentBytes(rep.fragments);
    }
    this.#entries.delete(uri);
    return true;
  }

  // ------------------------------------------------------------------
  // 入口
  // ------------------------------------------------------------------

  async get(req: GatewayRequest): Promise<GatewayResponse> {
    if (req.method.toUpperCase() !== 'GET') {
      throw new TypeError('网关缓存仅支持 GET 请求');
    }
    const headers: HeadersMap = { ...req.headers };
    const signal = req.signal;
    const uri = req.uri;

    let entry = this.#entries.get(uri);
    if (!entry) {
      entry = { uri, reps: [], inflight: new Map() };
      this.#entries.set(uri, entry);
    }
    const initialRep = this.#findRep(entry, headers);
    const requestRange = parseRangeHeader(getHeader(headers, 'range'));

    try {
      let rep = initialRep;

      // If-Range 与当前表示不一致：放弃片段，按完整响应重新确定表示
      if (
        rep &&
        requestRange &&
        getHeader(headers, 'if-range') !== undefined &&
        !this.#ifRangeMatches(rep, headers)
      ) {
        const resp = await this.#forwardFull(entry, rep, req, headers, signal, true);
        return this.#deliver(resp);
      }

      if (rep) {
        const decision = this.#serveDecision(rep, headers);
        if (decision.needsRevalidation) {
          const result = await this.#revalidate(entry, rep, req, headers, signal);
          if (result.kind === 'passthrough') {
            // 源站给出非预期状态：must-revalidate/no-cache 下必须放行错误，
            // 否则在仍能满足请求时回退陈旧内容
            const stale = this.#tryServeStale(rep, headers, requestRange, result.response.status);
            if (stale) return stale;
            return this.#deliver(result.response);
          }
          if (result.rep) rep = result.rep;
          else return this.#deliver(result.response); // 清除后迟到的回源：直接交付，不写回
        }

        // 调用方自身的条件校验（新鲜表示或刚完成重验证）
        const conditional = this.#clientConditional(rep, headers);
        if (conditional) {
          this.#touch(rep);
          return conditional;
        }

        if (requestRange) {
          const end = this.#clipEnd(rep, requestRange);
          if (isCovered(rep.fragments, requestRange.start, end)) {
            this.#touch(rep);
            return this.#serveRange(rep, requestRange.start, end);
          }
          const filled = await this.#fillRange(entry, rep, req, headers, signal, requestRange.start, end);
          if (!this.#isLive(entry)) {
            // 补齐等待期间被 purge：迟到片段未写回，直接交付本次回源响应
            return this.#deliver(filled);
          }
          const current = this.#findRep(entry, headers);
          if (current && isCovered(current.fragments, requestRange.start, this.#clipEnd(current, requestRange))) {
            this.#touch(current);
            return this.#serveRange(current, requestRange.start, this.#clipEnd(current, requestRange));
          }
          // 新表示仍覆盖不了（例如片段属于新 ETag）：回源取完整表示
          if (current) {
            const resp = await this.#forwardFull(entry, current, req, headers, signal, false);
            return this.#deliver(resp);
          }
          return this.#deliver(filled);
        }

        if (!rep.complete) {
          const resp = await this.#forwardFull(entry, rep, req, headers, signal, false);
          return this.#deliver(resp);
        }

        this.#touch(rep);
        return this.#serveFull(rep);
      }

      // 无表示：完整或范围回源
      const resp = await this.#forwardMiss(entry, req, headers, signal, requestRange);
      if (!this.#isLive(entry)) return this.#deliver(resp);
      return this.#deliver(resp);
    } catch (err) {
      if (isAbortError(err)) throw err;
      // 回源失败：仅在指令允许时回退陈旧缓存
      if (initialRep) {
        const stale = this.#tryServeStale(initialRep, headers, requestRange, 0);
        if (stale) return stale;
      }
      throw err;
    } finally {
      this.#cleanupEntry(entry);
    }
  }

  // ------------------------------------------------------------------
  // 变体与表示查找
  // ------------------------------------------------------------------

  #isLive(entry: UriEntry): boolean {
    return this.#entries.get(entry.uri) === entry;
  }

  #findRep(entry: UriEntry, requestHeaders: HeadersMap): Representation | undefined {
    if (entry.reps.length === 0) return undefined;
    // 每个表示按其自身的 Vary 字段匹配；Vary 集合随源站版本变化时旧表示不会误匹配新请求
    const candidates = entry.reps.filter((rep) =>
      rep.varyFields.every((f) => (rep.varyValues[f] ?? '') === (requestHeaders[f] ?? '')),
    );
    if (candidates.length === 0) return undefined;
    return candidates[candidates.length - 1]; // 最近存入的表示
  }

  #sameVariant(
    rep: Representation,
    varyFields: string[],
    varyValues: Record<string, string | undefined>,
  ): boolean {
    const allFields = new Set([...rep.varyFields, ...varyFields]);
    for (const f of allFields) {
      if ((rep.varyValues[f] ?? '') !== (varyValues[f] ?? '')) return false;
    }
    return true;
  }

  #ifRangeMatches(rep: Representation, headers: HeadersMap): boolean {
    const ir = getHeader(headers, 'if-range');
    if (!ir) return true;
    const asDate = parseHttpDate(ir);
    if (asDate !== undefined) {
      const lm = parseHttpDate(rep.lastModified);
      return lm !== undefined && lm <= asDate;
    }
    return rep.etag !== undefined && strongMatch(rep.etag, ir.trim());
  }

  #clipEnd(rep: Representation, range: ByteRange): number {
    if (Number.isFinite(rep.totalLength)) {
      return Math.min(range.end, (rep.totalLength as number) - 1);
    }
    if (range.end === Number.POSITIVE_INFINITY) {
      throw new Error('表示总长度未知，无法解析开放结尾范围');
    }
    return range.end;
  }

  // ------------------------------------------------------------------
  // 新鲜度与条件请求
  // ------------------------------------------------------------------

  #freshness(rep: Representation): FreshnessResult {
    return evaluateFreshness({
      responseCacheControl: rep.cacheControl,
      dateMs: rep.dateMs,
      storedAtMs: rep.storedAt,
      nowMs: this.#clock.now(),
      ageHeaderSeconds: rep.ageHeaderSeconds,
      expiresFallbackSeconds: expiresLifetime(rep.responseHeaders, rep.dateMs),
    });
  }

  #serveDecision(rep: Representation, requestHeaders: HeadersMap) {
    const fr = this.#freshness(rep);
    const qcc = parseCacheControl(getHeader(requestHeaders, 'cache-control'));
    const decision = decideServe({
      fresh: fr.fresh,
      responseCacheControl: rep.cacheControl,
      requestCacheControl: qcc,
      ageSeconds: fr.ageSeconds,
      freshnessLifetimeSeconds: fr.freshnessLifetimeSeconds,
    });
    return { ...decision, ageSeconds: fr.ageSeconds };
  }

  #clientConditional(rep: Representation, headers: HeadersMap): GatewayResponse | undefined {
    const inm = getHeader(headers, 'if-none-match');
    if (inm !== undefined) {
      if (!rep.etag) return undefined;
      const tags = parseIfNoneMatch(inm);
      const matched = tags.some((tag) => tag === '*' || weakMatch(tag, rep.etag as string));
      if (matched) return this.#serveNotModified(rep);
      return undefined;
    }
    const ims = getHeader(headers, 'if-modified-since');
    if (ims !== undefined) {
      const imsMs = parseHttpDate(ims);
      const lmMs = parseHttpDate(rep.lastModified);
      if (imsMs !== undefined && lmMs !== undefined && lmMs <= imsMs) {
        return this.#serveNotModified(rep);
      }
    }
    return undefined;
  }

  #tryServeStale(
    rep: Representation,
    headers: HeadersMap,
    requestRange: ByteRange | null,
    upstreamStatus: number,
  ): GatewayResponse | undefined {
    if (rep.cacheControl['must-revalidate'] || rep.cacheControl['proxy-revalidate'] || rep.cacheControl['no-cache']) {
      return undefined;
    }
    const qcc = parseCacheControl(getHeader(headers, 'cache-control'));
    if (qcc['max-age'] !== undefined || qcc['no-cache']) return undefined;

    const warning = `110 gateway-cache "stale response (upstream ${upstreamStatus || 'unavailable'})"`;
    if (requestRange) {
      let end: number;
      try {
        end = this.#clipEnd(rep, requestRange);
      } catch {
        return undefined;
      }
      if (!isCovered(rep.fragments, requestRange.start, end)) return undefined;
      const resp = this.#serveRange(rep, requestRange.start, end);
      resp.headers.warning = warning;
      return resp;
    }
    if (!rep.complete) return undefined;
    const resp = this.#serveFull(rep);
    resp.headers.warning = warning;
    return resp;
  }

  // ------------------------------------------------------------------
  // 回源：重验证
  // ------------------------------------------------------------------

  async #revalidate(
    entry: UriEntry,
    rep: Representation,
    req: GatewayRequest,
    headers: HeadersMap,
    signal: AbortSignal | undefined,
  ): Promise<RevalidateResult> {
    const extra: HeadersMap = {};
    if (rep.etag) extra['if-none-match'] = rep.etag;
    else if (rep.lastModified) extra['if-modified-since'] = rep.lastModified;

    const originReq = this.#buildOriginRequest(req, headers, {
      extra,
      dropRange: true,
    });

    const response = await this.#sharedOrigin(
      entry,
      `reval:${rep.id}`,
      originReq,
      signal,
      async (resp) => {
        // 仅当条目与表示仍然存活时才允许写回
        if (this.#entries.get(entry.uri) !== entry || !entry.reps.includes(rep)) return;
        if (resp.status === 304) {
          this.#apply304(rep, resp);
        } else if (resp.status === 200) {
          this.#storeFull(entry, resp, headers);
        }
      },
    );

    if (response.status === 304) {
      if (this.#entries.get(entry.uri) !== entry || !entry.reps.includes(rep)) {
        return { kind: 'notmodified', rep: undefined, response };
      }
      return { kind: 'notmodified', rep, response };
    }
    if (response.status === 200) {
      const current = this.#findRep(entry, headers);
      return { kind: 'replaced', rep: current, response };
    }
    return { kind: 'passthrough', response };
  }

  #apply304(rep: Representation, resp: OriginResponse): void {
    const h = resp.headers;
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      if (h[name] !== undefined) rep.responseHeaders[name] = h[name];
    }
    if (h.etag !== undefined) rep.etag = h.etag;
    if (h['last-modified'] !== undefined) rep.lastModified = h['last-modified'];
    rep.cacheControl = parseCacheControl(rep.responseHeaders['cache-control']);
    rep.storedAt = this.#clock.now();
    rep.dateMs = parseHttpDate(h.date) ?? rep.storedAt;
    rep.ageHeaderSeconds = parseAge(h.age) ?? 0;
    this.#touch(rep);
  }

  // ------------------------------------------------------------------
  // 回源：范围补齐
  // ------------------------------------------------------------------

  async #fillRange(
    entry: UriEntry,
    rep: Representation,
    req: GatewayRequest,
    headers: HeadersMap,
    signal: AbortSignal | undefined,
    clientStart: number,
    clientEnd: number,
  ): Promise<OriginResponse> {
    const gaps = findGaps(rep.fragments, clientStart, clientEnd);
    const union = unionRanges(gaps);
    if (!union) throw new Error('范围已覆盖，不应触发补齐');

    const extra: HeadersMap = {
      range: `bytes=${union.start}-${union.end === Number.POSITIVE_INFINITY ? '' : union.end}`,
    };
    if (rep.etag && isStrongEtag(rep.etag)) extra['if-range'] = rep.etag;

    const originReq = this.#buildOriginRequest(req, headers, { extra, dropRange: false });

    return this.#sharedOrigin(
      entry,
      `fill:${rep.id}:${union.start}-${union.end}`,
      originReq,
      signal,
      async (resp) => {
        if (this.#entries.get(entry.uri) !== entry || !entry.reps.includes(rep)) return;
        if (resp.status === 206) {
          const cr = parseContentRange(getHeader(resp.headers, 'content-range'));
          const etag = getHeader(resp.headers, 'etag');
          if (!cr || !etag || !isStrongEtag(etag)) return;
          if (rep.etag && strongMatch(rep.etag, etag) && cr.total === rep.totalLength) {
            // 同一变体、同一强校验器、一致总长度：允许合并
            const oldBytes = fragmentBytes(rep.fragments);
            insertFragment(rep.fragments, { start: cr.start, end: cr.end, body: resp.body });
            this.#afterFragmentChange(entry, rep, oldBytes);
          } else {
            // 新 ETag：重新确定当前表示（片段种子，等待后续完整响应或继续补齐）
            this.#seedPartial(entry, resp, headers, cr, etag);
          }
        } else if (resp.status === 200) {
          this.#storeFull(entry, resp, headers);
        }
      },
    );
  }

  // ------------------------------------------------------------------
  // 回源：完整表示
  // ------------------------------------------------------------------

  async #forwardFull(
    entry: UriEntry,
    rep: Representation,
    req: GatewayRequest,
    headers: HeadersMap,
    signal: AbortSignal | undefined,
    forceNew: boolean,
  ): Promise<OriginResponse> {
    const originReq = this.#buildOriginRequest(req, headers, { extra: {}, dropRange: true });
    const signature = this.#requestSignature(headers, 'full');
    return this.#sharedOrigin(
      entry,
      `full:${forceNew ? 'new' : rep.id}:${signature}`,
      originReq,
      signal,
      async (resp) => {
        if (this.#entries.get(entry.uri) !== entry) return;
        if (resp.status === 200) this.#storeFull(entry, resp, headers);
      },
    );
  }

  async #forwardMiss(
    entry: UriEntry,
    req: GatewayRequest,
    headers: HeadersMap,
    signal: AbortSignal | undefined,
    requestRange: ByteRange | null,
  ): Promise<OriginResponse> {
    const rangeTag = requestRange
      ? `bytes=${requestRange.start}-${requestRange.end === Number.POSITIVE_INFINITY ? '' : requestRange.end}`
      : 'full';
    const originReq = this.#buildOriginRequest(req, headers, { extra: {}, dropRange: false });
    const signature = this.#requestSignature(headers, rangeTag);

    return this.#sharedOrigin(
      entry,
      `miss:${signature}`,
      originReq,
      signal,
      async (resp) => {
        if (this.#entries.get(entry.uri) !== entry) return;
        if (resp.status === 200) {
          this.#storeFull(entry, resp, headers);
        } else if (resp.status === 206) {
          const cr = parseContentRange(getHeader(resp.headers, 'content-range'));
          const etag = getHeader(resp.headers, 'etag');
          if (cr && etag && isStrongEtag(etag) && Number.isFinite(cr.total)) {
            this.#seedPartial(entry, resp, headers, cr, etag);
          }
        }
      },
    );
  }

  #requestSignature(headers: HeadersMap, rangeTag: string): string {
    const forwarded = FORWARDABLE_REQUEST_HEADERS.map((name) => `${name}=${headers[name] ?? ''}`).join('|');
    return `${rangeTag}#${forwarded}`;
  }

  #buildOriginRequest(
    req: GatewayRequest,
    headers: HeadersMap,
    options: { extra: HeadersMap; dropRange: boolean },
  ): OriginRequest {
    const forwarded: HeadersMap = {};
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      if (headers[name] !== undefined) forwarded[name] = headers[name];
    }
    if (options.dropRange) {
      delete forwarded.range;
      delete forwarded['if-range'];
    }
    for (const [k, v] of Object.entries(options.extra)) {
      forwarded[k] = v;
    }
    // signal 由共享回源的 AbortController 提供，这里占位
    return { method: 'GET', uri: req.uri, headers: forwarded, signal: new AbortController().signal };
  }

  // ------------------------------------------------------------------
  // 并发共享与取消
  // ------------------------------------------------------------------

  #sharedOrigin(
    entry: UriEntry,
    key: string,
    originReq: OriginRequest,
    leaderSignal: AbortSignal | undefined,
    onSettle: (resp: OriginResponse) => Promise<void> | void,
  ): Promise<OriginResponse> {
    const existing = entry.inflight.get(key);
    if (existing) {
      return this.#attachWaiter(existing, leaderSignal);
    }

    const controller = new AbortController();
    if (leaderSignal?.aborted) controller.abort();
    const flight: InFlight = { key, controller, waiters: [], settled: false };
    entry.inflight.set(key, flight);
    const leaderPromise = this.#attachWaiter(flight, leaderSignal);

    void (async () => {
      let captured: OriginResponse | undefined;
      let failure: unknown;
      try {
        captured = await this.#origin({ ...originReq, signal: controller.signal });
      } catch (err) {
        failure = err;
      }
      flight.settled = true;

      if (captured && flight.waiters.some((w) => !w.aborted)) {
        try {
          await onSettle(captured);
        } catch {
          // 缓存写回失败不影响向等待者交付源站响应
        }
      }

      const waiters = flight.waiters.splice(0);
      entry.inflight.delete(key);
      for (const w of waiters) {
        if (w.signal) w.signal.removeEventListener('abort', w.onAbort);
        if (captured) {
          w.resolve(captured);
        } else {
          w.reject(failure);
        }
      }
      this.#cleanupEntry(entry);
    })();

    return leaderPromise;
  }

  #attachWaiter(flight: InFlight, signal: AbortSignal | undefined): Promise<OriginResponse> {
    return new Promise<OriginResponse>((resolve, reject) => {
      // 调用方已取消：立即失败，不加入等待者
      if (signal?.aborted) {
        reject(makeAbortError());
        return;
      }

      const waiter: Waiter = {
        signal,
        aborted: false,
        onAbort: () => {},
        resolve,
        reject,
      };
      if (signal) {
        waiter.onAbort = () => {
          // 立即让该等待者失败并从共享回源摘除
          waiter.aborted = true;
          const idx = flight.waiters.indexOf(waiter);
          if (idx !== -1) flight.waiters.splice(idx, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(makeAbortError());

          // 最后一个等待者离开：中止仍未完成的回源
          if (flight.waiters.length === 0 && !flight.settled) {
            flight.controller.abort();
          }
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      flight.waiters.push(waiter);
    });
  }

  // ------------------------------------------------------------------
  // 存储与容量
  // ------------------------------------------------------------------

  #storeFull(entry: UriEntry, resp: OriginResponse, requestHeaders: HeadersMap): Representation | undefined {
    const hadAuth = requestHeaders.authorization !== undefined;
    if (!isStorable({ status: resp.status, responseHeaders: resp.headers, requestHadAuthorization: hadAuth })) {
      return undefined;
    }
    const varyFields = parseVary(getHeader(resp.headers, 'vary'));
    const varyValues = this.#extractVaryValues(varyFields, requestHeaders);
    const etag = getHeader(resp.headers, 'etag');

    const existing = entry.reps.find(
      (r) =>
        etag !== undefined &&
        r.etag !== undefined &&
        strongMatch(r.etag, etag) &&
        this.#sameVariant(r, varyFields, varyValues),
    );

    const now = this.#clock.now();
    const dateMs = parseHttpDate(getHeader(resp.headers, 'date'));
    const base: Representation = existing ?? {
      id: this.#nextRepId++,
      etag: undefined,
      lastModified: undefined,
      varyFields,
      varyValues,
      fragments: [],
      totalLength: resp.body.length,
      responseHeaders: {},
      storedAt: now,
      dateMs,
      ageHeaderSeconds: parseAge(getHeader(resp.headers, 'age')) ?? 0,
      cacheControl: parseCacheControl(getHeader(resp.headers, 'cache-control')),
      get complete() {
        return isComplete(this.fragments, this.totalLength);
      },
    };

    const oldBytes = fragmentBytes(base.fragments);
    base.fragments = [{ start: 0, end: resp.body.length - 1, body: Buffer.from(resp.body) }];
    base.totalLength = resp.body.length;
    base.responseHeaders = { ...resp.headers };
    base.etag = etag;
    base.lastModified = getHeader(resp.headers, 'last-modified');
    base.varyFields = varyFields;
    base.varyValues = varyValues;
    base.storedAt = now;
    base.dateMs = dateMs;
    base.ageHeaderSeconds = parseAge(getHeader(resp.headers, 'age')) ?? 0;
    base.cacheControl = parseCacheControl(getHeader(resp.headers, 'cache-control'));

    if (!existing) entry.reps.push(base);
    this.#afterFragmentChange(entry, base, oldBytes);
    return entry.reps.includes(base) ? base : undefined;
  }

  #seedPartial(
    entry: UriEntry,
    resp: OriginResponse,
    requestHeaders: HeadersMap,
    cr: { start: number; end: number; total: number },
    etag: string,
  ): Representation | undefined {
    const hadAuth = requestHeaders.authorization !== undefined;
    if (!isStorable({ status: resp.status, responseHeaders: resp.headers, requestHadAuthorization: hadAuth })) {
      return undefined;
    }
    if (resp.body.length !== cr.end - cr.start + 1) return undefined;

    const varyFields = parseVary(getHeader(resp.headers, 'vary'));
    const varyValues = this.#extractVaryValues(varyFields, requestHeaders);

    const existing = entry.reps.find(
      (r) =>
        r.etag !== undefined &&
        strongMatch(r.etag, etag) &&
        cr.total === r.totalLength &&
        this.#sameVariant(r, varyFields, varyValues),
    );

    const now = this.#clock.now();
    const rep: Representation =
      existing ??
      ({
        id: this.#nextRepId++,
        etag,
        lastModified: getHeader(resp.headers, 'last-modified'),
        varyFields,
        varyValues,
        fragments: [],
        totalLength: cr.total,
        responseHeaders: { ...resp.headers },
        storedAt: now,
        dateMs: parseHttpDate(getHeader(resp.headers, 'date')),
        ageHeaderSeconds: parseAge(getHeader(resp.headers, 'age')) ?? 0,
        cacheControl: parseCacheControl(getHeader(resp.headers, 'cache-control')),
        get complete() {
          return isComplete(this.fragments, this.totalLength);
        },
      } as Representation);

    const oldBytes = fragmentBytes(rep.fragments);
    insertFragment(rep.fragments, { start: cr.start, end: cr.end, body: Buffer.from(resp.body) });
    if (!existing) entry.reps.push(rep);
    this.#afterFragmentChange(entry, rep, oldBytes);
    return entry.reps.includes(rep) ? rep : undefined;
  }

  #extractVaryValues(
    varyFields: string[],
    requestHeaders: HeadersMap,
  ): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const f of varyFields) out[f] = requestHeaders[f];
    return out;
  }

  #afterFragmentChange(entry: UriEntry, rep: Representation, oldBytes: number): void {
    const newBytes = fragmentBytes(rep.fragments);
    this.#totalBytes += newBytes - oldBytes;
    this.#touch(rep);
    this.#enforceCapacity(entry, rep);
  }

  #enforceCapacity(entry: UriEntry, protectedRep: Representation): void {
    while (this.#totalBytes > this.#maxBytes) {
      const oldestId = this.#lru.keys().next().value as number | undefined;
      if (oldestId === undefined) break;
      if (oldestId === protectedRep.id && this.#lru.size === 1) {
        // 单个表示就超过容量：不保留它
        this.#detach(protectedRep, entry);
        break;
      }
      const location = this.#lru.get(oldestId);
      if (!location) break;
      this.#detach(location.rep, location.entry);
    }
  }

  #detach(rep: Representation, entry: UriEntry): void {
    const idx = entry.reps.indexOf(rep);
    if (idx !== -1) entry.reps.splice(idx, 1);
    if (this.#lru.has(rep.id)) {
      this.#lru.delete(rep.id);
      this.#totalBytes -= fragmentBytes(rep.fragments);
    }
    this.#cleanupEntry(entry);
  }

  #touch(rep: Representation): void {
    const location = this.#lru.get(rep.id);
    if (!location) {
      const entry = this.#findEntryOf(rep);
      if (entry) this.#lru.set(rep.id, { entry, rep });
      return;
    }
    this.#lru.delete(rep.id);
    this.#lru.set(rep.id, location);
  }

  #findEntryOf(rep: Representation): UriEntry | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.reps.includes(rep)) return entry;
    }
    return undefined;
  }

  #cleanupEntry(entry: UriEntry): void {
    if (entry.reps.length === 0 && entry.inflight.size === 0 && this.#entries.get(entry.uri) === entry) {
      this.#entries.delete(entry.uri);
    }
  }

  // ------------------------------------------------------------------
  // 响应合成
  // ------------------------------------------------------------------

  #baseResponseHeaders(rep: Representation): HeadersMap {
    const out: HeadersMap = {};
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      if (rep.responseHeaders[name] !== undefined) out[name] = rep.responseHeaders[name];
    }
    const fr = this.#freshness(rep);
    setHeader(out, 'age', String(fr.ageSeconds));
    setHeader(out, 'date', rep.responseHeaders.date ?? new Date(rep.storedAt).toUTCString());
    return out;
  }

  #serveFull(rep: Representation): GatewayResponse {
    const body = readBytes(rep.fragments, 0, rep.totalLength - 1);
    if (!body) throw new Error('完整表示正文读取失败');
    const headers = this.#baseResponseHeaders(rep);
    setHeader(headers, 'content-length', String(body.length));
    delete headers['content-range'];
    return { status: 200, headers, body: Buffer.from(body) };
  }

  #serveRange(rep: Representation, start: number, end: number): GatewayResponse {
    const body = readBytes(rep.fragments, start, end);
    if (!body) throw new Error('范围正文读取失败');
    const headers = this.#baseResponseHeaders(rep);
    setHeader(headers, 'content-length', String(body.length));
    setHeader(headers, 'content-range', formatContentRange(start, end, rep.totalLength));
    return { status: 206, headers, body: Buffer.from(body) };
  }

  #serveNotModified(rep: Representation): GatewayResponse {
    const headers = this.#baseResponseHeaders(rep);
    delete headers['content-length'];
    delete headers['content-range'];
    return { status: 304, headers, body: Buffer.alloc(0) };
  }

  #deliver(resp: OriginResponse): GatewayResponse {
    const headers = { ...resp.headers };
    setHeader(headers, 'content-length', String(resp.body.length));
    return { status: resp.status, headers, body: Buffer.from(resp.body) };
  }
}
