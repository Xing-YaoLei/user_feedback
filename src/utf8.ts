/**
 * Strict UTF-8 helpers for *known* string fields.
 *
 * Unknown length-delimited payloads are never inspected, so opaque bytes are
 * safe to carry through unchanged. Known strings, on the other hand, must be
 * valid UTF-8 on input and replacement.
 */

import { TextDecoder } from 'node:util';
import { ProtobufRewriteError } from './errors.ts';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Validate a byte range as UTF-8.
 *
 * Returns the absolute offset of the first invalid byte (the leading byte of
 * the malformed sequence), or -1 when the range is valid.
 */
export function findInvalidUtf8(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): number {
  let index = start;

  while (index < end) {
    const lead = bytes[index]!;

    if (lead <= 0x7f) {
      index += 1;
      continue;
    }

    let continuationCount: number;
    let lower = 0x80;
    let upper = 0xbf;

    if (lead >= 0xc2 && lead <= 0xdf) {
      continuationCount = 1;
    } else if (lead === 0xe0) {
      continuationCount = 2;
      lower = 0xa0;
    } else if (lead >= 0xe1 && lead <= 0xec) {
      continuationCount = 2;
    } else if (lead === 0xed) {
      continuationCount = 2;
      // UTF-16 surrogates (U+D800..U+DFFF) are not valid Unicode scalar values.
      upper = 0x9f;
    } else if (lead >= 0xee && lead <= 0xef) {
      continuationCount = 2;
    } else if (lead === 0xf0) {
      continuationCount = 3;
      lower = 0x90;
    } else if (lead >= 0xf1 && lead <= 0xf3) {
      continuationCount = 3;
    } else if (lead === 0xf4) {
      continuationCount = 3;
      // Nothing above U+10FFFF.
      upper = 0x8f;
    } else {
      // 0x80..0xC1 (stray continuation / overlong lead), 0xF5..0xFF.
      return index;
    }

    if (index + continuationCount >= end) {
      return index;
    }

    const first = bytes[index + 1]!;
    if (first < lower || first > upper) {
      return index;
    }

    for (let offset = 2; offset <= continuationCount; offset += 1) {
      const continuation = bytes[index + offset]!;
      if (continuation < 0x80 || continuation > 0xbf) {
        return index;
      }
    }

    index += continuationCount + 1;
  }

  return -1;
}

/** Decode a range that has already been validated as UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Encode a JavaScript string as UTF-8, rejecting lone UTF-16 surrogates.
 *
 * `Buffer.from` would silently substitute U+FFFD, which would make a
 * "strict" replacement quietly lossy. Callers get INVALID_REPLACEMENT instead.
 */
export function encodeUtf8(value: string): Buffer {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new ProtobufRewriteError(
        'INVALID_REPLACEMENT',
        `Replacement string contains a lone high surrogate at UTF-16 index ${index}`,
      );
    }

    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ProtobufRewriteError(
        'INVALID_REPLACEMENT',
        `Replacement string contains a lone low surrogate at UTF-16 index ${index}`,
      );
    }
  }

  return Buffer.from(value, 'utf8');
}
