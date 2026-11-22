/**
 * 字节区间工具。
 * 一个表示（representation）的已缓存内容用一组互不重叠、已排序、
 * 相邻即合并的片段（fragment）描述，容量按片段字节数之和核算。
 */

import type { ByteRange } from './headers.ts';

export interface Fragment {
  start: number;
  end: number; // 含端点
  body: Buffer;
}

/** 片段覆盖的字节数（区间重叠时通过合并保证不会重复计数）。 */
export function fragmentBytes(fragments: Fragment[]): number {
  let sum = 0;
  for (const f of fragments) sum += f.end - f.start + 1;
  return sum;
}

/**
 * 插入一个新片段并就地合并重叠/相邻片段。
 * 调用方必须保证同一表示内的片段内容一致（同 ETag、同总长度）。
 */
export function insertFragment(fragments: Fragment[], incoming: Fragment): Fragment[] {
  let mergedStart = incoming.start;
  let mergedEnd = incoming.end;
  let mergedBody = incoming.body;

  const kept: Fragment[] = [];
  for (const f of fragments) {
    // 相邻或重叠即合并（含端点：f.end + 1 >= mergedStart）
    if (f.end + 1 < mergedStart || f.start > mergedEnd + 1) {
      kept.push(f);
      continue;
    }
    const newStart = Math.min(mergedStart, f.start);
    const newEnd = Math.max(mergedEnd, f.end);
    const combined = Buffer.allocUnsafe(newEnd - newStart + 1);
    // 先写旧片段，再写新片段；重叠区由后写入的同内容字节覆盖（同表示内容一致）
    f.body.copy(combined, f.start - newStart);
    mergedBody.copy(combined, mergedStart - newStart);
    mergedStart = newStart;
    mergedEnd = newEnd;
    mergedBody = combined;
  }
  kept.push({ start: mergedStart, end: mergedEnd, body: mergedBody });
  kept.sort((a, b) => a.start - b.start);
  fragments.length = 0;
  fragments.push(...kept);
  return fragments;
}

/** 判断 [start,end] 是否已被片段完全覆盖。 */
export function isCovered(fragments: Fragment[], start: number, end: number): boolean {
  let cursor = start;
  for (const f of fragments) {
    if (f.start > cursor) return false;
    cursor = Math.max(cursor, f.end + 1);
    if (cursor > end) return true;
  }
  return cursor > end;
}

/** 计算覆盖 [start,end] 还缺失的区间列表（已排序、相邻合并）。 */
export function findGaps(fragments: Fragment[], start: number, end: number): ByteRange[] {
  const gaps: ByteRange[] = [];
  let cursor = start;
  for (const f of fragments) {
    if (f.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(f.start - 1, end) });
    }
    cursor = Math.max(cursor, f.end + 1);
    if (cursor > end) return gaps;
  }
  if (cursor <= end) gaps.push({ start: cursor, end });
  return gaps;
}

/** 将多个相邻区间合并为一个并集区间；空列表返回 null。 */
export function unionRanges(ranges: ByteRange[]): ByteRange | null {
  if (ranges.length === 0) return null;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let { start, end } = sorted[0];
  for (const r of sorted.slice(1)) {
    if (r.start <= end + 1) {
      end = Math.max(end, r.end);
    } else {
      // 调用场景下缺口彼此相邻（同一连续请求区间的缺口），这里保守处理
      start = Math.min(start, r.start);
      end = Math.max(end, r.end);
    }
  }
  return { start, end };
}

/** 从片段中读取 [start,end] 的字节，未完全覆盖时返回 null。 */
export function readBytes(fragments: Fragment[], start: number, end: number): Buffer | null {
  if (!isCovered(fragments, start, end)) return null;
  const out = Buffer.allocUnsafe(end - start + 1);
  for (const f of fragments) {
    const s = Math.max(f.start, start);
    const e = Math.min(f.end, end);
    if (s > e) continue;
    f.body.copy(out, s - start, s - f.start, e - f.start + 1);
  }
  return out;
}

/** 判断片段集合是否已覆盖完整表示。 */
export function isComplete(fragments: Fragment[], totalLength: number): boolean {
  return totalLength !== Number.POSITIVE_INFINITY && isCovered(fragments, 0, totalLength - 1);
}
