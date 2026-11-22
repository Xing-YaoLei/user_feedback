/**
 * 网关缓存的公共类型。源站请求与时钟均由调用方注入。
 */

import type { HeadersMap } from './headers.ts';

/** 注入式时钟。 */
export interface Clock {
  now(): number;
}

/** 发给源站的请求。signal 在最后一个等待者离开时中止。 */
export interface OriginRequest {
  method: string;
  uri: string;
  headers: HeadersMap;
  signal: AbortSignal;
}

/** 源站响应。body 为字节缓冲区；304 可不带正文。 */
export interface OriginResponse {
  status: number;
  headers: HeadersMap;
  body: Buffer;
}

/** 调用方适配器：把请求发给源站。 */
export type OriginFetch = (req: OriginRequest) => Promise<OriginResponse>;

/** 进入网关的 GET 请求。 */
export interface GatewayRequest {
  method: string;
  uri: string;
  headers: HeadersMap;
  signal?: AbortSignal;
}

/** 网关产出的响应。 */
export interface GatewayResponse {
  status: number;
  headers: HeadersMap;
  body: Buffer;
}

export interface GatewayCacheOptions {
  /** 容量上限（按实际保留的正文区间字节核算）。 */
  maxBytes: number;
  origin: OriginFetch;
  clock?: Clock;
}

export interface CacheStats {
  /** 当前保留的正文区间字节总数（重叠不重复计数）。 */
  bytes: number;
  /** 缓存中的 URI 条目数。 */
  entries: number;
  /** 各 URI 的表示数量与占用明细。 */
  uris: Array<{
    uri: string;
    representations: Array<{
      etag: string | undefined;
      complete: boolean;
      totalLength: number;
      bytes: number;
    }>;
  }>;
}
