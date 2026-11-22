/**
 * Hash and signature helpers.
 *
 * Signatures are cheap-to-compare strings that change exactly when the thing
 * they describe changes observably. Cache validation compares signatures
 * rather than revisions, which is what lets an unrelated change reuse results.
 */

import { createHash } from 'node:crypto';

/** Short, stable digest of an arbitrary JSON-able value. */
export function digest(value: unknown): string {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Content signature of one request-context field. */
export function contextSignature(value: unknown): string {
  if (value === undefined) return 'absent';
  if (typeof value === 'function' || typeof value === 'symbol') {
    return `unsupported:${typeof value}`;
  }
  return digest(stableStringify(value));
}
