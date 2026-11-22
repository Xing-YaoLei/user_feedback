/**
 * 新鲜度与可存储性规则（RFC 9111 共享缓存语义）。
 */

import {
  type CacheControl,
  type HeadersMap,
  getHeader,
  parseCacheControl,
  parseHttpDate,
} from './headers.ts';

export interface FreshnessInput {
  responseCacheControl: CacheControl;
  /** 响应 Date 头部对应的毫秒时间戳；缺失时由调用方以存入时间代替。 */
  dateMs: number | undefined;
  /** 缓存存入时刻（注入时钟）。 */
  storedAtMs: number;
  /** 当前时刻（注入时钟）。 */
  nowMs: number;
  /** 响应 Age 头部声明的秒数。 */
  ageHeaderSeconds: number;
  /** 无 max-age/s-maxage 时，由 Expires - Date 推得的回退寿命（秒）。 */
  expiresFallbackSeconds: number;
}

export interface FreshnessResult {
  fresh: boolean;
  /** 当前 Age（秒，向上取整，非负）。 */
  ageSeconds: number;
  /** 新鲜度寿命（秒）；无法确定时为 0，表示必须重验证。 */
  freshnessLifetimeSeconds: number;
}

/**
 * 计算 Age 与新鲜度。
 * 共享缓存优先采用 s-maxage，其次 max-age，再退到 Expires - Date。
 */
export function evaluateFreshness(input: FreshnessInput): FreshnessResult {
  const { responseCacheControl: cc, dateMs, storedAtMs, nowMs, ageHeaderSeconds, expiresFallbackSeconds } = input;

  const apparent = dateMs === undefined ? 0 : Math.max(0, storedAtMs - dateMs) / 1000;
  const resident = Math.max(0, nowMs - storedAtMs) / 1000;
  const correctedAge = Math.max(ageHeaderSeconds, apparent);
  const currentAge = Math.max(0, Math.ceil(correctedAge + resident));

  let lifetime: number;
  if (cc['s-maxage'] !== undefined) {
    lifetime = cc['s-maxage'];
  } else if (cc['max-age'] !== undefined) {
    lifetime = cc['max-age'];
  } else {
    lifetime = expiresFallbackSeconds;
  }

  return {
    fresh: currentAge < lifetime,
    ageSeconds: currentAge,
    freshnessLifetimeSeconds: lifetime,
  };
}

/** Expires 回退寿命（秒）；无法确定时返回 0。 */
export function expiresLifetime(
  headers: HeadersMap,
  dateMs: number | undefined,
): number {
  const expires = parseHttpDate(getHeader(headers, 'expires'));
  if (expires === undefined || dateMs === undefined) return 0;
  return Math.max(0, Math.round((expires - dateMs) / 1000));
}

export interface StorableInput {
  status: number;
  responseHeaders: HeadersMap;
  /** 请求是否携带 Authorization。 */
  requestHadAuthorization: boolean;
}

/**
 * 判断共享缓存是否允许存储该响应。
 * - no-store 一律不存；
 * - private 不允许进入共享缓存；
 * - Set-Cookie 缺少可缓存指令时不存（保守处理）；
 * - 带 Authorization 的响应仅在 must-revalidate / proxy-revalidate /
 *   public / s-maxage 明确授权时可存。
 */
export function isStorable(input: StorableInput): boolean {
  const { status, responseHeaders, requestHadAuthorization } = input;
  if (status !== 200 && status !== 206) return false;

  const cc = parseCacheControl(getHeader(responseHeaders, 'cache-control'));
  if (cc['no-store'] || cc.private) return false;

  if (getHeader(responseHeaders, 'set-cookie') !== undefined && !cc['must-revalidate'] && !cc.public && cc['s-maxage'] === undefined) {
    return false;
  }

  if (requestHadAuthorization) {
    if (
      !cc['must-revalidate'] &&
      !cc['proxy-revalidate'] &&
      !cc.public &&
      cc['s-maxage'] === undefined
    ) {
      return false;
    }
  }

  return true;
}

export interface ServeDecisionInput {
  fresh: boolean;
  responseCacheControl: CacheControl;
  requestCacheControl: CacheControl;
  ageSeconds: number;
  freshnessLifetimeSeconds: number;
}

export interface ServeDecision {
  /** 是否可直接用缓存响应调用方。 */
  usable: boolean;
  /** 是否必须先回源条件重验证（no-cache / 过期且禁止陈旧）。 */
  needsRevalidation: boolean;
}

/**
 * 结合请求与响应的缓存指令决定缓存表示能否直接服务。
 */
export function decideServe(input: ServeDecisionInput): ServeDecision {
  const { fresh, responseCacheControl: rcc, requestCacheControl: qcc, ageSeconds, freshnessLifetimeSeconds } = input;

  // 请求端 no-cache：强制回源重验证
  if (qcc['no-cache']) {
    return { usable: false, needsRevalidation: true };
  }

  // 响应端 no-cache：每次使用前必须重验证
  if (rcc['no-cache']) {
    return { usable: false, needsRevalidation: true };
  }

  const maxAgeRequest = qcc['max-age'];
  const minFresh = qcc['min-fresh'] ?? 0;
  const effectiveAge = ageSeconds + minFresh;

  if (maxAgeRequest !== undefined) {
    if (effectiveAge > maxAgeRequest) {
      return { usable: false, needsRevalidation: true };
    }
    return { usable: true, needsRevalidation: false };
  }

  if (fresh && effectiveAge < freshnessLifetimeSeconds) {
    return { usable: true, needsRevalidation: false };
  }

  // 已过期
  if (rcc['must-revalidate'] || rcc['proxy-revalidate']) {
    return { usable: false, needsRevalidation: true };
  }

  const maxStale = qcc['max-stale'];
  if (maxStale !== undefined) {
    const staleFor = ageSeconds - freshnessLifetimeSeconds;
    return { usable: staleFor <= maxStale, needsRevalidation: staleFor > maxStale };
  }

  // 共享缓存默认不主动放任陈旧：过期即重验证
  return { usable: false, needsRevalidation: true };
}
