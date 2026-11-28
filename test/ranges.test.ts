import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import {
  coerceRangeCount,
  missingWithin,
  normalizeRanges,
  rangesEqual,
  SeqIntervalSet,
} from '../src/ranges.ts';

test('normalizeRanges merges overlapping and adjacent ranges and drops invalid ones', () => {
  const merged = normalizeRanges([
    { start: 10, end: 12 },
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 6, end: 9 },
    { start: 0, end: 5 },
    { start: 5, end: 1 },
  ]);
  assert.deepEqual(merged, [
    { start: 1, end: 4 },
    { start: 6, end: 12 },
  ]);
});

test('missingWithin returns the complement of buffered ranges', () => {
  const buffered = normalizeRanges([
    { start: 3, end: 4 },
    { start: 8, end: 8 },
  ]);
  assert.deepEqual(missingWithin(buffered, 1, 10), [
    { start: 1, end: 2 },
    { start: 5, end: 7 },
    { start: 9, end: 10 },
  ]);
  assert.deepEqual(missingWithin(buffered, 4, 4), []);
  assert.deepEqual(missingWithin([], 2, 1), []);
});

test('coerceRangeCount merges the closest ranges until the limit is met', () => {
  const ranges = [
    { start: 1, end: 1 },
    { start: 3, end: 3 },
    { start: 100, end: 100 },
    { start: 200, end: 200 },
  ];
  assert.deepEqual(coerceRangeCount(ranges, 1), [{ start: 1, end: 200 }]);
  const result = coerceRangeCount(ranges, 2);
  assert.equal(result.length, 2);
  // The closest pair (1,3) is merged first; no coverage is lost, and merging
  // continues by the next-smallest hole until the count fits.
  assert.deepEqual(result, [
    { start: 1, end: 100 },
    { start: 200, end: 200 },
  ]);
});

test('SeqIntervalSet supports add, has, remove and pruning', () => {
  const set = new SeqIntervalSet();
  for (const seq of [5, 6, 9, 2]) set.add(seq);
  assert.deepEqual(set.toRanges(), [
    { start: 2, end: 2 },
    { start: 5, end: 6 },
    { start: 9, end: 9 },
  ]);
  assert.equal(set.has(5), true);
  assert.equal(set.has(7), false);
  set.remove(5);
  assert.deepEqual(set.toRanges(), [
    { start: 2, end: 2 },
    { start: 6, end: 6 },
    { start: 9, end: 9 },
  ]);
  set.pruneBelow(6);
  assert.deepEqual(set.toRanges(), [
    { start: 6, end: 6 },
    { start: 9, end: 9 },
  ]);
  assert.equal(set.maxSeq(), 9);
});

test('rangesEqual is structural', () => {
  assert.equal(rangesEqual([{ start: 1, end: 2 }], [{ start: 1, end: 2 }]), true);
  assert.equal(rangesEqual([{ start: 1, end: 2 }], [{ start: 1, end: 3 }]), false);
});

test('ManualClock fires timers in due-time then insertion order', () => {
  const clock = new ManualClock();
  const order: string[] = [];
  clock.setTimeout(() => order.push('b-late'), 20);
  clock.setTimeout(() => order.push('a-early'), 10);
  clock.setTimeout(() => order.push('a-tied'), 10);
  clock.advance(19);
  assert.deepEqual(order, ['a-early', 'a-tied']);
  clock.advance(1);
  assert.deepEqual(order, ['a-early', 'a-tied', 'b-late']);
});
