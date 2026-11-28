import type { Range } from './types.ts';

/** Drop invalid ranges, sort, and merge overlapping or adjacent ranges. */
export function normalizeRanges(input: readonly Range[]): Range[] {
  const valid: Range[] = [];
  for (const range of input) {
    if (
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 1 &&
      range.end >= range.start
    ) {
      valid.push({ start: range.start, end: range.end });
    }
  }
  valid.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const range of valid) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end + 1) {
      if (range.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: range.end };
      }
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/**
 * Coalesce ranges until at most `limit` remain, always merging the pair with
 * the smallest hole between them. Requesting a few already-buffered sequence
 * numbers is harmless (receivers de-duplicate); leaving a gap unrequested is
 * not. This bounds feedback backlog without losing coverage.
 */
export function coerceRangeCount(ranges: readonly Range[], limit: number): Range[] {
  const merged = normalizeRanges(ranges);
  if (limit < 1 || merged.length <= limit) return merged;
  const working = merged.slice();
  while (working.length > limit) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i + 1 < working.length; i++) {
      const distance = working[i + 1]!.start - working[i]!.end;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    const left = working[bestIndex]!;
    const right = working[bestIndex + 1]!;
    working.splice(bestIndex, 2, { start: left.start, end: right.end });
  }
  return working;
}

export function rangesOverlap(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function rangeKey(range: Range): string {
  return `${range.start}-${range.end}`;
}

export function rangeLength(range: Range): number {
  return range.end - range.start + 1;
}

export function rangesEqual(a: readonly Range[], b: readonly Range[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.start !== b[i]!.start || a[i]!.end !== b[i]!.end) return false;
  }
  return true;
}

/** Complement of `received` inside [from, to] (inclusive). */
export function missingWithin(
  received: readonly Range[],
  from: number,
  to: number,
): Range[] {
  if (to < from) return [];
  const missing: Range[] = [];
  let cursor = from;
  for (const range of received) {
    if (range.end < cursor) continue;
    if (range.start > to) break;
    if (range.start > cursor) {
      missing.push({ start: cursor, end: Math.min(range.start - 1, to) });
    }
    if (range.end >= to) {
      cursor = to + 1;
      break;
    }
    cursor = Math.max(cursor, range.end + 1);
  }
  if (cursor <= to) missing.push({ start: cursor, end: to });
  return missing;
}

/**
 * Sorted, merged set of individual sequence numbers. Used to track which
 * future sequence numbers are already buffered.
 */
export class SeqIntervalSet {
  private ranges: Range[] = [];

  add(seq: number): void {
    this.ranges = normalizeRanges([...this.ranges, { start: seq, end: seq }]);
  }

  remove(seq: number): void {
    const next: Range[] = [];
    for (const range of this.ranges) {
      if (seq < range.start || seq > range.end) {
        next.push(range);
      } else if (range.start === range.end) {
        // drop the whole singleton
      } else if (seq === range.start) {
        next.push({ start: range.start + 1, end: range.end });
      } else if (seq === range.end) {
        next.push({ start: range.start, end: range.end - 1 });
      } else {
        next.push({ start: range.start, end: seq - 1 });
        next.push({ start: seq + 1, end: range.end });
      }
    }
    this.ranges = next;
  }

  has(seq: number): boolean {
    for (const range of this.ranges) {
      if (seq < range.start) return false;
      if (seq <= range.end) return true;
    }
    return false;
  }

  /** Drop everything strictly below `min`, trimming a straddling range. */
  pruneBelow(min: number): void {
    this.ranges = this.ranges
      .filter((range) => range.end >= min)
      .map((range) => (range.start < min ? { start: min, end: range.end } : range));
  }

  maxSeq(): number | undefined {
    const last = this.ranges[this.ranges.length - 1];
    return last === undefined ? undefined : last.end;
  }

  toRanges(): Range[] {
    return this.ranges.map((range) => ({ start: range.start, end: range.end }));
  }

  get size(): number {
    return this.ranges.reduce((sum, range) => sum + rangeLength(range), 0);
  }

  clear(): void {
    this.ranges = [];
  }
}
