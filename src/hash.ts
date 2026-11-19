/**
 * Small, dependency-free, platform-independent content hash.
 *
 * `crypto` is avoided only because the queue must be able to run in embedded
 * contexts where node:crypto may be restricted; the algorithm is FNV-1a over
 * UTF-8 bytes, widened by a second mixing round so 64 bits of state are used.
 * It is a request-fingerprint, not a security primitive.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** Encode a JS string to UTF-8 bytes without Buffer/crypto. */
export function utf8Bytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    // Combine UTF-16 surrogate pairs into a single code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code <= 0x7f) {
      out.push(code);
    } else if (code <= 0x7ff) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Stable 64-bit FNV-1a derivative rendered as 16 lowercase hex chars. */
export function contentHash(parts: readonly (string | number | boolean | null | undefined)[]): string {
  let hash = FNV_OFFSET;
  const push = (byte: number): void => {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  };
  for (const part of parts) {
    // Length-prefix each part so ["ab","c"] and ["a","bc"] differ.
    const text = part === null || part === undefined ? "" : String(part);
    const bytes = utf8Bytes(text);
    push(bytes.length & 0xff);
    push((bytes.length >>> 8) & 0xff);
    push(0x1f); // field separator
    for (const byte of bytes) push(byte);
    push(0x1e); // part separator
  }
  // Final avalanche to spread the low bits.
  hash ^= hash >> 33n;
  hash = (hash * 0xff51afd7ed558ccdn) & MASK_64;
  hash ^= hash >> 33n;
  hash = (hash * 0xc4ceb9fe1a85ec53n) & MASK_64;
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(16, "0");
}
