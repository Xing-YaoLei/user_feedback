import test from 'node:test';
import assert from 'node:assert/strict';

import { matchKeyEvents } from '../src/matching.ts';
import { referenceMatches } from '../src/reference.ts';
import { compareEvents } from '../src/types.ts';
import { ev, matchKeys } from './helpers.ts';

test('pairs an A with the earliest eligible B inside the window', () => {
  const events = [ev('a1', 's', 'k', 'A', 0), ev('b2', 's', 'k', 'B', 9), ev('b1', 's', 'k', 'B', 3)];
  const { matches } = matchKeyEvents(events, 10);
  assert.deepEqual([...matches.keys()], ['a1']);
  assert.equal(matches.get('a1')!.bId, 'b1');
});

test('B before its A is not eligible; B exactly at A.time is', () => {
  const before = matchKeyEvents([ev('a', 's', 'k', 'A', 5), ev('b', 's', 'k', 'B', 4)], 10);
  assert.equal(before.matches.size, 0);

  const at = matchKeyEvents([ev('a', 's', 'k', 'A', 5), ev('b', 's', 'k', 'B', 5)], 10);
  assert.equal(at.matches.get('a')!.bId, 'b');
});

test('window is closed at A.time + T', () => {
  const inside = matchKeyEvents([ev('a', 's', 'k', 'A', 0), ev('b', 's', 'k', 'B', 10)], 10);
  assert.equal(inside.matches.size, 1);

  const outside = matchKeyEvents([ev('a', 's', 'k', 'A', 0), ev('b', 's', 'k', 'B', 11)], 10);
  assert.equal(outside.matches.size, 0);
});

test('a C in [A.time, B.time] blocks that B; an earlier B still works', () => {
  const blockedThenEarlier = matchKeyEvents(
    [
      ev('a', 's', 'k', 'A', 0),
      ev('c', 's', 'k', 'C', 4),
      ev('b1', 's', 'k', 'B', 2),
      ev('b2', 's', 'k', 'B', 9),
    ],
    10,
  );
  // b1 (time 2) sits before the C and is still eligible; b2 is blocked.
  assert.equal(blockedThenEarlier.matches.get('a')!.bId, 'b1');

  const onlyBlocked = matchKeyEvents(
    [ev('a', 's', 'k', 'A', 0), ev('c', 's', 'k', 'C', 4), ev('b', 's', 'k', 'B', 9)],
    10,
  );
  assert.equal(onlyBlocked.matches.size, 0);
});

test('a C after the chosen B does not block it', () => {
  const { matches } = matchKeyEvents(
    [ev('a', 's', 'k', 'A', 0), ev('b', 's', 'k', 'B', 5), ev('c', 's', 'k', 'C', 7)],
    10,
  );
  assert.equal(matches.get('a')!.bId, 'b');
});

test('a C at exactly B.time blocks (closed interval)', () => {
  const { matches } = matchKeyEvents(
    [ev('a', 's', 'k', 'A', 0), ev('c', 's', 'k', 'C', 5), ev('b', 's', 'k', 'B', 5)],
    10,
  );
  assert.equal(matches.size, 0);
});

test('a B is used by at most one A; earlier A wins', () => {
  const { matches } = matchKeyEvents(
    [ev('a2', 's', 'k', 'A', 1), ev('a1', 's', 'k', 'A', 0), ev('b', 's', 'k', 'B', 2)],
    10,
  );
  assert.deepEqual([...matches.keys()], ['a1']);
  assert.equal(matches.get('a1')!.bId, 'b');
});

test('earlier A takes the earliest B even if that forces a later A elsewhere', () => {
  // a1 can only use b1; a2 could use b1 or b2. Greedy: a1->b1, a2->b2.
  const { matches } = matchKeyEvents(
    [
      ev('a1', 's', 'k', 'A', 0),
      ev('a2', 's', 'k', 'A', 1),
      ev('b1', 's', 'k', 'B', 2),
      ev('b2', 's', 'k', 'B', 3),
    ],
    10,
  );
  assert.equal(matches.get('a1')!.bId, 'b1');
  assert.equal(matches.get('a2')!.bId, 'b2');
});

test('ties on time are broken by id, so input order is irrelevant', () => {
  const events = [
    ev('a2', 's', 'k', 'A', 5),
    ev('a1', 's', 'k', 'A', 5),
    ev('b2', 's', 'k', 'B', 6),
    ev('b1', 's', 'k', 'B', 6),
  ];
  const forward = matchKeyEvents(events, 10);
  const reversed = matchKeyEvents([...events].reverse(), 10);
  assert.deepEqual(matchKeys([...forward.matches.values()]), matchKeys([...reversed.matches.values()]));
  // a1 (smaller id) processed first and takes b1 (smaller id at equal time).
  assert.equal(forward.matches.get('a1')!.bId, 'b1');
  assert.equal(forward.matches.get('a2')!.bId, 'b2');
});

test('compareEvents orders by time then id', () => {
  const sorted = [ev('b', 's', 'k', 'A', 2), ev('a', 's', 'k', 'A', 1), ev('z', 's', 'k', 'A', 1)]
    .sort(compareEvents)
    .map((e) => e.id);
  assert.deepEqual(sorted, ['a', 'z', 'b']);
});

test('unmatched A is simply absent from the match map', () => {
  const { matches } = matchKeyEvents([ev('a', 's', 'k', 'A', 0)], 10);
  assert.equal(matches.size, 0);
});

test('referenceMatches ignores keys from each other', () => {
  const ref = referenceMatches(
    [
      ev('a1', 's', 'k1', 'A', 0),
      ev('b1', 's', 'k2', 'B', 1),
      ev('c1', 's', 'k1', 'C', 0),
    ],
    10,
  );
  // k1 A is blocked by its own C; k2's B has no A.
  assert.deepEqual(ref.matches, []);
  assert.deepEqual(ref.unmatchedA, ['a1']);
});
