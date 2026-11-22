import { I32_MAX, I32_MIN, I64_MAX, I64_MIN } from './types.ts';
import type { WireValue } from './types.ts';
import { ParseError } from './errors.ts';

/** Tagged JSON envelope used to keep 64 bit integers exact across JSON. */
export const I64_TAG = '__i64__';

export function isWireUnion(v: unknown): v is { tag: string; value: WireValue } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { tag?: unknown }).tag === 'string' &&
    'value' in (v as object)
  );
}

export function isPlainRecord(v: unknown): v is Record<string, WireValue> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !isWireUnion(v)
  );
}

/**
 * Encode a canonical wire value to JSON text. i64 bigints become
 * `{"__i64__": "<decimal>"}` so no precision is ever lost.
 */
export function encodeWire(value: WireValue): string {
  return JSON.stringify(value, (_key, raw) =>
    typeof raw === 'bigint' ? { [I64_TAG]: raw.toString() } : raw,
  );
}

/** Decode JSON text back into canonical wire values (restores bigints). */
export function decodeWire(text: string): WireValue {
  const revived = JSON.parse(text, (_key, raw) => {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.keys(raw).length === 1 &&
      typeof raw[I64_TAG] === 'string'
    ) {
      const n = BigInt(raw[I64_TAG]);
      if (n < I64_MIN || n > I64_MAX) {
        throw new ParseError(
          `decoded i64 value ${n} is outside the signed 64 bit range`,
          'i64-out-of-range',
          [{ kind: 'root' }],
        );
      }
      return n;
    }
    return raw;
  });
  return revived as WireValue;
}

export function inI32(n: number): boolean {
  return Number.isInteger(n) && n >= I32_MIN && n <= I32_MAX;
}

export function inI64BigInt(n: bigint): boolean {
  return n >= I64_MIN && n <= I64_MAX;
}

export function isFiniteF64(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}
