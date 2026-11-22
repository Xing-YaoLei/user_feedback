/**
 * Strict percent encoding / decoding.
 *
 * Input paths are split on the *raw* slashes first; only afterwards is each
 * segment percent-decoded exactly once. A slash produced by decoding
 * (e.g. %2F) therefore stays inside its segment.
 */
import { EncodingError } from './errors.ts';

const HEX = '0123456789ABCDEF';

/**
 * Percent-decode a single raw segment, then validate the resulting bytes as
 * strict UTF-8 (rejecting overlong encodings and surrogates).
 *
 * @param locationPrefix e.g. "segment 2" — used in error locations
 */
export function decodeSegment(raw: string, locationPrefix: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '%') {
      const h = raw[i + 1];
      const l = raw[i + 2];
      if (h === undefined || l === undefined || !isHex(h) || !isHex(l)) {
        throw new EncodingError(
          `invalid percent escape "${trunc(raw, i)}"`,
          'INVALID_PERCENT_ESCAPE',
          `${locationPrefix}, byte offset ${i}`,
        );
      }
      bytes.push((hexVal(h) << 4) | hexVal(l));
      i += 2;
    } else {
      const code = ch.codePointAt(0)!;
      if (code > 0x7f) {
        // Raw multibyte characters are not legal in a percent-encoded path;
        // require callers to encode them first.
        throw new EncodingError(
          `raw non-ASCII character "${ch}" must be percent-encoded`,
          'RAW_NON_ASCII',
          `${locationPrefix}, byte offset ${i}`,
        );
      }
      bytes.push(code);
    }
  }
  return strictUtf8Decode(bytes, locationPrefix);
}

/**
 * Split on raw slashes and decode every segment once.
 * The root path "/" decodes to an empty segment list.
 */
export function decodePath(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new EncodingError('path must be a non-empty string', 'EMPTY_PATH', 'path');
  }
  if (path[0] !== '/') {
    throw new EncodingError(
      'absolute path must start with "/"',
      'MISSING_LEADING_SLASH',
      'path offset 0',
    );
  }
  if (path === '/') return [];

  const rawSegments = path.slice(1).split('/');
  const decoded: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];
    if (raw.length === 0) {
      throw new EncodingError(
        'empty path segment (double or trailing slash)',
        'EMPTY_SEGMENT',
        `segment ${i}`,
      );
    }
    decoded.push(decodeSegment(raw, `segment ${i}`));
  }
  return decoded;
}

/**
 * Canonical percent encoding of one *decoded* segment.
 * Only RFC 3986 unreserved characters stay literal; everything else
 * (including any "/" embedded in the segment) is encoded as uppercase %HH.
 */
export function encodeSegment(decoded: string): string {
  const bytes = utf8Bytes(decoded);
  let out = '';
  for (const b of bytes) {
    if (isUnreserved(b)) {
      out += String.fromCharCode(b);
    } else {
      out += '%' + HEX[b >> 4] + HEX[b & 0x0f];
    }
  }
  return out;
}

/** Join already decoded segments into a canonical encoded absolute path. */
export function encodePath(decodedSegments: readonly string[]): string {
  if (decodedSegments.length === 0) return '/';
  return '/' + decodedSegments.map(encodeSegment).join('/');
}

/* ------------------------------------------------------------------ */

function strictUtf8Decode(bytes: readonly number[], locationPrefix: string): string {
  let out = '';
  let i = 0;
  const fail = (msg: string, offset: number): never => {
    throw new EncodingError(msg, 'INVALID_UTF8', `${locationPrefix}, byte offset ${offset}`);
  };
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 <= 0x7f) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    const cont = (n: number, offset: number): number => {
      const b = bytes[offset];
      if (b === undefined || b < 0x80 || b > 0xbf) {
        fail('truncated or invalid UTF-8 continuation byte', offset);
      }
      return b & 0x3f;
    };
    let cp: number;
    let width: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      width = 2;
      cp = ((b0 & 0x1f) << 6) | cont(i, i + 1);
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      width = 3;
      const b1 = cont(i, i + 1);
      cont(i, i + 2);
      if (b0 === 0xe0 && b1 < 0x20) fail('overlong UTF-8 encoding', i + 1);
      if (b0 === 0xed && b1 > 0x1f) fail('UTF-8 encodes a surrogate code point', i + 1);
      cp = ((b0 & 0x0f) << 12) | (b1 << 6) | (bytes[i + 2] & 0x3f);
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      width = 4;
      const b1 = cont(i, i + 1);
      cont(i, i + 2);
      cont(i, i + 3);
      if (b0 === 0xf0 && b1 < 0x10) fail('overlong UTF-8 encoding', i + 1);
      if (b0 === 0xf4 && b1 > 0x0f) fail('code point beyond U+10FFFF', i + 1);
      cp =
        ((b0 & 0x07) << 18) |
        (b1 << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
    } else {
      fail('invalid UTF-8 leading byte (overlong or out of range)', i);
    }
    out += String.fromCodePoint(cp);
    i += width;
  }
  return out;
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) {
      out.push(cp);
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      out.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function isHex(ch: string): boolean {
  return (
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'f') ||
    (ch >= 'A' && ch <= 'F')
  );
}

function hexVal(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'a' && ch <= 'f') return ch.charCodeAt(0) - 87;
  return ch.charCodeAt(0) - 55;
}

function isUnreserved(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2d || // -
    b === 0x2e || // .
    b === 0x5f || // _
    b === 0x7e // ~
  );
}

function trunc(raw: string, i: number): string {
  return raw.slice(i, i + 3);
}
