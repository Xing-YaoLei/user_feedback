/**
 * 头部处理工具：头部以「小写键 -> 字符串」的普通对象在模块内部传递。
 * 仅支持单值头部（本模块涉及的缓存头部均为单值）。
 */

export type HeadersMap = Record<string, string>;

/** 大小写不敏感地读取头部。 */
export function getHeader(headers: HeadersMap, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

export function setHeader(headers: HeadersMap, name: string, value: string): void {
  headers[name.toLowerCase()] = value;
}

export interface CacheControl {
  'max-age'?: number;
  's-maxage'?: number;
  'no-cache'?: boolean;
  'no-store'?: boolean;
  private?: boolean;
  public?: boolean;
  'must-revalidate'?: boolean;
  'proxy-revalidate'?: boolean;
  immutable?: boolean;
  'max-stale'?: number;
  'min-fresh'?: number;
  'only-if-cached'?: boolean;
}

/** 解析 Cache-Control 头部，未知指令忽略；畸形的数值指令按缺省处理。 */
export function parseCacheControl(header: string | undefined): CacheControl {
  const result: CacheControl = {};
  if (!header) return result;
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const token = eq === -1 ? trimmed : trimmed.slice(0, eq);
    const rawValue = eq === -1 ? undefined : trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '');
    const key = token.toLowerCase();
    switch (key) {
      case 'max-age':
      case 's-maxage':
      case 'max-stale':
      case 'min-fresh': {
        if (rawValue !== undefined) {
          const n = Number(rawValue);
          if (Number.isFinite(n) && n >= 0) {
            (result as Record<string, unknown>)[key] = n;
          }
        }
        break;
      }
      case 'no-cache':
      case 'no-store':
      case 'private':
      case 'public':
      case 'must-revalidate':
      case 'proxy-revalidate':
      case 'immutable':
      case 'only-if-cached':
        (result as Record<string, unknown>)[key] = true;
        break;
      default:
        // 未知指令不影响本模块语义
        break;
    }
  }
  return result;
}

/**
 * 解析 HTTP 日期（IMF-fixdate / RFC 850 / asctime）。
 * 无法解析时返回 undefined。
 */
export function parseHttpDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** ETag 是否为强校验器（W/ 前缀为弱校验器）。 */
export function isStrongEtag(etag: string | undefined): boolean {
  return !!etag && !etag.trimStart().toLowerCase().startsWith('w/');
}

/** 解析 If-None-Match 中的实体标签列表，保留原始字符串（含 W/）。 */
export function parseIfNoneMatch(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** 弱比较（RFC 9110 8.8.3.2）：任一为弱即可，剥离 W/ 后字符串相同。 */
export function weakMatch(a: string, b: string): boolean {
  return a.replace(/^[Ww]\//, '') === b.replace(/^[Ww]\//, '');
}

/** 强比较（RFC 9110 8.8.3.1）：两者都必须是强 ETag，且 opaque-tag 相同。 */
export function strongMatch(a: string, b: string): boolean {
  return isStrongEtag(a) && isStrongEtag(b) && a === b;
}

export interface ByteRange {
  start: number;
  end: number; // 含端点
}

/**
 * 解析单段 bytes 范围（bytes=start-end）。
 * 多段范围、非 bytes 单位、语法错误均返回 null（调用方按完整响应处理）。
 */
export function parseRangeHeader(value: string | undefined): ByteRange | null {
  if (!value) return null;
  const match = /^\s*bytes\s*=\s*(\d*)-(\d*)\s*$/.exec(value);
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    // 后缀范围 bytes=-N：本模块仅支持单段显式 byte-range，交由源站处理
    return null;
  }
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0) return null;
  let end: number;
  if (endRaw === '') {
    end = Number.POSITIVE_INFINITY;
  } else {
    end = Number(endRaw);
    if (!Number.isInteger(end) || end < start) return null;
  }
  return { start, end };
}

export interface ContentRange {
  start: number;
  end: number; // 含端点
  total: number; // 未知长度时为 Infinity
}

/** 解析 Content-Range: bytes start-end/total。 */
export function parseContentRange(value: string | undefined): ContentRange | null {
  if (!value) return null;
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? Number.POSITIVE_INFINITY : Number(match[3]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  if (Number.isFinite(total) && end >= (total as number)) return null;
  return { start, end, total };
}

export function formatContentRange(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`;
}

/** 转发给源站时允许携带的请求头部白名单（按小写名）。 */
export const FORWARDABLE_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'cookie',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
  'referer',
  'user-agent',
] as const;

/** 合成响应时逐字透传的响应头部；其余由缓存按语义重新生成。 */
export const PASSTHROUGH_RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'content-language',
  'etag',
  'last-modified',
  'vary',
  'cache-control',
  'expires',
  'date',
  'www-authenticate',
  'set-cookie',
  'location',
  'server',
] as const;
