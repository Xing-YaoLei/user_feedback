/**
 * Equality index for scalar-equality predicates on one field path.
 *
 * Keys are `(JSON type, value)` pairs so `1`, `"1"`, `true` and `null` are
 * different buckets. An atom is registered once per distinct bucket it needs
 * (normally one); a query computes the event's scalar type and looks in
 * exactly one bucket. Removing an atom unlinks its bucket when empty.
 */

import type { JsonPrimitive, ScalarKind } from "../types.ts";
import { scalarKind } from "../types.ts";

export const bucketKey = (value: JsonPrimitive): string => {
  switch (scalarKind(value)) {
    case "null":
      return "z";
    case "boolean":
      return value === true ? "b1" : "b0";
    case "number":
      return `n${numberKey(value as number)}`;
    case "string":
      return `s${value as string}`;
  }
};

const numberKey = (value: number): string => {
  if (value === 0) return "0";
  return Number.isFinite(value) ? String(value) : String(value);
};

export class EqualityIndex {
  private readonly buckets = new Map<string, Set<number>>();
  private atomCount = 0;

  get size(): number {
    return this.atomCount;
  }

  get bucketCount(): number {
    return this.buckets.size;
  }

  add(atomId: number, value: JsonPrimitive): void {
    const key = bucketKey(value);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = new Set();
      this.buckets.set(key, bucket);
    }
    if (!bucket.has(atomId)) {
      bucket.add(atomId);
      this.atomCount += 1;
    }
  }

  remove(atomId: number, value: JsonPrimitive): void {
    const key = bucketKey(value);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || !bucket.delete(atomId)) return;
    this.atomCount -= 1;
    if (bucket.size === 0) this.buckets.delete(key);
  }

  /** Collect atoms matching the scalar value; returns visited bucket entries. */
  query(value: JsonPrimitive, out: Set<number>): number {
    const bucket = this.buckets.get(bucketKey(value));
    if (bucket === undefined) return 0;
    let visits = 0;
    for (const atomId of bucket) {
      out.add(atomId);
      visits += 1;
    }
    return visits + 1;
  }

  /** Collect atoms that matched no scalar bucket at all (used by NOT). */
  queryAbsent(value: JsonPrimitive, out: Set<number>): number {
    let visits = 0;
    const key = bucketKey(value);
    for (const [bucket, atomIds] of this.buckets) {
      if (bucket === key) continue;
      for (const atomId of atomIds) {
        out.add(atomId);
        visits += 1;
      }
    }
    return visits;
  }

  clear(): void {
    this.buckets.clear();
    this.atomCount = 0;
  }

  bucketSizes(): Array<{ key: string; atoms: number }> {
    return [...this.buckets].map(([key, atoms]) => ({ key, atoms: atoms.size }));
  }
}
