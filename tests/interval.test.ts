import { test } from "node:test";
import assert from "node:assert/strict";
import { IntervalSet } from "../src/interval.ts";

test("IntervalSet: out-of-order inserts merge into discrete intervals and keep holes", () => {
  const set = new IntervalSet();

  assert.equal(set.frontier, 0);
  assert.deepEqual(set.getIntervals(), []);

  // Interleaved confirmation with a hole at 1.
  assert.equal(set.add(0), true);
  assert.equal(set.add(2), true);
  assert.equal(set.frontier, 1);
  assert.deepEqual(set.getIntervals(), [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ]);

  // Filling the hole merges both intervals into one.
  assert.equal(set.add(1), true);
  assert.equal(set.frontier, 3);
  assert.deepEqual(set.getIntervals(), [{ start: 0, end: 3 }]);

  // Idempotent duplicates.
  assert.equal(set.add(1), false);
  assert.equal(set.add(2), false);
  assert.deepEqual(set.getIntervals(), [{ start: 0, end: 3 }]);

  // A later hole beyond the frontier stays discrete.
  set.add(5);
  set.add(6);
  assert.equal(set.frontier, 3);
  assert.deepEqual(set.getIntervals(), [
    { start: 0, end: 3 },
    { start: 5, end: 7 },
  ]);
  assert.equal(set.contains(4), false);
  assert.equal(set.contains(5), true);

  // Fill offset 3: adjacent merge with the prefix, hole at 4 remains.
  set.add(3);
  assert.equal(set.frontier, 4);
  assert.deepEqual(set.getIntervals(), [
    { start: 0, end: 4 },
    { start: 5, end: 7 },
  ]);
});

test("IntervalSet: bidirectional adjacency and round-trip restore", () => {
  const set = new IntervalSet();
  set.add(4);
  set.add(2);
  set.add(3); // merges 2..4
  set.add(5); // extends to 2..6
  assert.deepEqual(set.getIntervals(), [{ start: 2, end: 6 }]);
  assert.equal(set.frontier, 0); // nothing starts at offset 0

  const restored = IntervalSet.fromIntervals(set.getIntervals());
  assert.deepEqual(restored.getIntervals(), set.getIntervals());
  assert.equal(restored.frontier, 0);

  assert.throws(() => new IntervalSet().add(-1), RangeError);
  assert.throws(() => new IntervalSet().add(1.5), RangeError);
});
