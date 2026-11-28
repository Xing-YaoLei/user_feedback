import type { OffsetInterval } from "./types.ts";

/**
 * Mutable set of discrete non-negative offsets, stored as a sorted list of
 * disjoint half-open intervals [start, end). Supports out-of-order adds
 * (merging adjacent intervals) and derives the continuous prefix frontier.
 *
 * Used for terminal confirmations, which may arrive interleaved and leave
 * holes behind the latest confirmed offset.
 */
export class IntervalSet {
  private intervals: OffsetInterval[] = [];

  /** Add one offset; idempotent. Returns true when it was not already present. */
  add(offset: number): boolean {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
    }

    // Insertion point: first interval whose start is >= offset.
    let lo = 0;
    let hi = this.intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.intervals[mid].start < offset) lo = mid + 1;
      else hi = mid;
    }
    const pos = lo;

    // Already inside the interval starting at or after offset.
    if (pos < this.intervals.length && offset >= this.intervals[pos].start) {
      return false;
    }
    // Already inside the interval immediately before the insertion point.
    if (pos > 0 && offset < this.intervals[pos - 1].end) {
      return false;
    }

    const mergeLeft = pos > 0 && this.intervals[pos - 1].end === offset;
    const mergeRight =
      pos < this.intervals.length && this.intervals[pos].start === offset + 1;

    if (mergeLeft && mergeRight) {
      this.intervals[pos - 1].end = this.intervals[pos].end;
      this.intervals.splice(pos, 1);
    } else if (mergeLeft) {
      this.intervals[pos - 1].end = offset + 1;
    } else if (mergeRight) {
      this.intervals[pos].start = offset;
    } else {
      this.intervals.splice(pos, 0, { start: offset, end: offset + 1 });
    }
    return true;
  }

  contains(offset: number): boolean {
    let lo = 0;
    let hi = this.intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const iv = this.intervals[mid];
      if (offset < iv.start) hi = mid;
      else if (offset >= iv.end) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /**
   * Length of the continuous prefix starting at offset 0.
   * Equals the next offset that would extend the prefix.
   */
  get frontier(): number {
    if (this.intervals.length === 0 || this.intervals[0].start !== 0) return 0;
    return this.intervals[0].end;
  }

  get isEmpty(): boolean {
    return this.intervals.length === 0;
  }

  /** Defensive copy of the stored intervals. */
  getIntervals(): OffsetInterval[] {
    return this.intervals.map((iv) => ({ start: iv.start, end: iv.end }));
  }

  toJSON(): OffsetInterval[] {
    return this.getIntervals();
  }

  static fromIntervals(intervals: OffsetInterval[] | undefined): IntervalSet {
    const set = new IntervalSet();
    for (const iv of intervals ?? []) {
      for (let o = iv.start; o < iv.end; o++) set.add(o);
    }
    return set;
  }
}
