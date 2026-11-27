import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  KEY_SPACE,
  Router,
  validatePermanentHint,
  type PermanentHint,
} from '../src/index.ts';

const permanent = (
  start: number,
  end: number,
  address: string,
  generation: number,
): PermanentHint => ({ kind: 'permanent', start, end, address, generation });

describe('Router: initial coverage', () => {
  test('covers the entire key space with one segment', () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 3 });
    router.assertInvariant();

    assert.equal(router.size, 1);
    assert.deepEqual(router.snapshot(), [
      { start: 0, end: KEY_SPACE, address: 'seed:0', generation: 3 },
    ]);
    assert.equal(router.ownerOf(0), 'seed:0');
    assert.equal(router.ownerOf(KEY_SPACE - 1), 'seed:0');
    assert.equal(router.ownerOf(0x8000_0000), 'seed:0');
  });

  test('boundary keys are exact', () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    assert.equal(KEY_SPACE, 4_294_967_296);
    assert.equal(router.lookup(4_294_967_295).end, 4_294_967_296);
  });

  test('rejects non-integer, negative, and out-of-range keys', () => {
    const router = new Router({ initialAddress: 'seed:0' });
    for (const bad of [-1, 0.5, KEY_SPACE, Number.NaN, Infinity, -Infinity]) {
      assert.throws(() => router.lookup(bad), RangeError);
      assert.throws(() => router.ownerOf(bad), RangeError);
    }
  });
});

describe('Router: point-wise generation adoption', () => {
  test('a newer permanent hint splits the original range', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    const result = router.applyPermanentHint(permanent(100, 200, 'b:1', 1));

    assert.equal(result.status, 'applied');
    assert.equal(result.changed, true);
    router.assertInvariant();

    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 100, address: 'a:1', generation: 0 },
      { start: 100, end: 200, address: 'b:1', generation: 1 },
      { start: 200, end: KEY_SPACE, address: 'a:1', generation: 0 },
    ]);
    assert.equal(router.ownerOf(99), 'a:1');
    assert.equal(router.ownerOf(100), 'b:1');
    assert.equal(router.ownerOf(199), 'b:1');
    assert.equal(router.ownerOf(200), 'a:1');
  });

  test('routes outside the hint stay valid and untouched', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 10, 'b:1', 1));
    router.applyPermanentHint(permanent(20, 30, 'c:1', 1));

    const before = router.snapshot();
    const result = router.applyPermanentHint(permanent(10, 20, 'd:1', 2));
    assert.equal(result.status, 'applied');
    router.assertInvariant();

    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 10, address: 'b:1', generation: 1 },
      { start: 10, end: 20, address: 'd:1', generation: 2 },
      { start: 20, end: 30, address: 'c:1', generation: 1 },
      { start: 30, end: KEY_SPACE, address: 'a:1', generation: 0 },
    ]);
    assert.equal(before.length, 4);
    assert.deepEqual(before[0], { start: 0, end: 10, address: 'b:1', generation: 1 });
  });

  test('lower generation hints are ignored without changing the table', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 5 });
    const snapshot = router.snapshot();

    const result = router.applyPermanentHint(permanent(0, KEY_SPACE, 'b:1', 4));
    assert.equal(result.status, 'stale');
    assert.equal(result.changed, false);
    assert.deepEqual(router.snapshot(), snapshot);
    assert.equal(router.ownerOf(1234), 'a:1');
  });

  test('adoption is per point: a higher generation wins only where it overlaps', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 100, 'b:1', 2));
    // Generation 3 covers a wider, partly newer region.
    const result = router.applyPermanentHint(permanent(50, 150, 'c:1', 3));

    assert.equal(result.status, 'applied');
    router.assertInvariant();
    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 50, address: 'b:1', generation: 2 },
      { start: 50, end: 150, address: 'c:1', generation: 3 },
      { start: 150, end: KEY_SPACE, address: 'a:1', generation: 0 },
    ]);
  });

  test('a hint spanning several routes adopts only the older points', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 10, 'x:1', 9));
    router.applyPermanentHint(permanent(20, 30, 'y:1', 9));

    const result = router.applyPermanentHint(permanent(5, 25, 'z:1', 5));
    assert.equal(result.status, 'applied');
    router.assertInvariant();

    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 10, address: 'x:1', generation: 9 },
      { start: 10, end: 20, address: 'z:1', generation: 5 },
      { start: 20, end: 30, address: 'y:1', generation: 9 },
      { start: 30, end: KEY_SPACE, address: 'a:1', generation: 0 },
    ]);
  });

  test('re-applying the same hint coalesces and reports stale', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(100, 200, 'b:1', 1));
    const result = router.applyPermanentHint(permanent(100, 200, 'b:1', 1));

    assert.equal(result.status, 'stale');
    assert.equal(result.changed, false);
    assert.equal(router.size, 3);
    router.assertInvariant();
  });

  test('same generation and same owner is harmless', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 7 });
    const result = router.applyPermanentHint(
      permanent(10, 20, 'a:1', 7),
    );
    assert.equal(result.status, 'stale');
    assert.equal(router.size, 1);
  });

  test('a newer hint can re-assert generation monotonicity across splits', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 50, 'b:1', 1));
    router.applyPermanentHint(permanent(50, 100, 'c:1', 1));
    router.applyPermanentHint(permanent(0, 100, 'd:1', 2));
    router.assertInvariant();

    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 100, address: 'd:1', generation: 2 },
      { start: 100, end: KEY_SPACE, address: 'a:1', generation: 0 },
    ]);
  });

  test('a hint that is newer in one part and equal elsewhere applies only the newer part', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 100, 'b:1', 3));
    router.applyPermanentHint(permanent(100, 200, 'c:1', 5));

    const result = router.applyPermanentHint(permanent(0, 200, 'c:1', 5));
    assert.equal(result.status, 'applied');
    router.assertInvariant();

    // [100, 200) was already c:1@5; [0, 100) upgrades from b:1@3.
    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 200, address: 'c:1', generation: 5 },
      { start: 200, end: KEY_SPACE, address: 'a:1', generation: 0 },
    ]);
  });

  test('a hint is stale when every overlapping point is already equal or newer', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 50, 'b:1', 4));
    router.applyPermanentHint(permanent(50, 100, 'c:1', 6));
    const before = router.snapshot();

    const result = router.applyPermanentHint(permanent(10, 90, 'd:1', 3));
    assert.equal(result.status, 'stale');
    assert.equal(result.changed, false);
    assert.deepEqual(router.snapshot(), before);
  });

  test('partial adoption splits at both hint boundaries', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(25, 75, 'b:1', 1));

    const result = router.applyPermanentHint(permanent(50, 100, 'c:1', 2));
    assert.equal(result.status, 'applied');
    router.assertInvariant();

    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 25, address: 'a:1', generation: 0 },
      { start: 25, end: 50, address: 'b:1', generation: 1 },
      { start: 50, end: 100, address: 'c:1', generation: 2 },
      { start: 100, end: KEY_SPACE, address: 'a:1', generation: 0 },
    ]);
  });

  test('zero-width boundaries at 0 and KEY_SPACE are handled exactly', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    assert.equal(router.applyPermanentHint(permanent(0, 1, 'first', 1)).status, 'applied');
    assert.equal(
      router.applyPermanentHint(
        permanent(KEY_SPACE - 1, KEY_SPACE, 'last', 1),
      ).status,
      'applied',
    );
    router.assertInvariant();
    assert.equal(router.lookup(0).address, 'first');
    assert.equal(router.lookup(KEY_SPACE - 1).address, 'last');
    assert.equal(router.size, 3);
  });
});

describe('Router: conflicts', () => {
  test('same generation with a different owner rejects the entire hint', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 100, 'b:1', 5));
    const snapshot = router.snapshot();

    const result = router.applyPermanentHint(permanent(50, 150, 'c:1', 5));
    assert.equal(result.status, 'conflict');
    assert.equal(result.changed, false);
    assert.deepEqual(router.snapshot(), snapshot);
    assert.deepEqual(result.conflict, {
      start: 50,
      end: 100,
      generation: 5,
      existingAddress: 'b:1',
      incomingAddress: 'c:1',
    });
    // The non-overlapping tail was not applied either.
    assert.equal(router.ownerOf(120), 'a:1');
  });

  test('conflict detection happens before any mutation, even if part is newer', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 100, 'b:1', 5));
    const snapshot = router.snapshot();

    // [100, 200) would be newer, but [50, 100) conflicts at generation 5.
    const result = router.applyPermanentHint(permanent(50, 200, 'c:1', 5));
    assert.equal(result.status, 'conflict');
    assert.deepEqual(router.snapshot(), snapshot);
    assert.equal(router.ownerOf(150), 'a:1');
  });

  test('equal generation with the same owner is not a conflict', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 100, 'b:1', 5));
    const result = router.applyPermanentHint(permanent(0, 100, 'b:1', 5));
    assert.equal(result.status, 'stale');
    assert.equal(result.conflict, undefined);
  });

  test('a conflict does not disturb unrelated ranges', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 10, 'b:1', 3));
    router.applyPermanentHint(permanent(90, 100, 'c:1', 3));
    const before = router.snapshot();

    router.applyPermanentHint(permanent(0, 10, 'x:1', 3));
    assert.deepEqual(router.snapshot(), before);
    assert.equal(router.ownerOf(95), 'c:1');
  });
});

describe('Router: validation', () => {
  test('rejects empty, inverted, and out-of-range intervals', () => {
    const router = new Router({ initialAddress: 'a:1' });
    const snapshot = router.snapshot();

    for (const hint of [
      permanent(5, 5, 'b:1', 1),
      permanent(10, 5, 'b:1', 1),
      permanent(-1, 5, 'b:1', 1),
      permanent(0, KEY_SPACE + 1, 'b:1', 1),
      permanent(0.5, 5, 'b:1', 1),
      permanent(0, Number.NaN, 'b:1', 1),
      permanent(0, 5, '', 1),
      permanent(0, 5, 'b:1', -1),
      permanent(0, 5, 'b:1', 1.5),
    ]) {
      const result = router.applyPermanentHint(hint);
      assert.equal(result.status, 'invalid', JSON.stringify(hint));
      assert.equal(result.changed, false);
    }

    assert.deepEqual(router.snapshot(), snapshot);
  });

  test('accepts the full key space as one hint', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    const result = router.applyPermanentHint(
      permanent(0, KEY_SPACE, 'b:1', 1),
    );
    assert.equal(result.status, 'applied');
    assert.equal(router.size, 1);
    assert.equal(router.ownerOf(KEY_SPACE - 1), 'b:1');
  });

  test('validator reports reasons for malformed hints', () => {
    assert.equal(validatePermanentHint(permanent(0, 1, 'a', 1)), null);
    assert.match(
      validatePermanentHint(permanent(10, 10, 'a', 1)) ?? '',
      /empty/,
    );
    assert.match(
      validatePermanentHint(permanent(0, 1, ' ', 1)) ?? '',
      /address/,
    );
  });
});

describe('Router: snapshot isolation', () => {
  test('mutating a snapshot does not affect the table', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    const snapshot = router.snapshot();
    snapshot[0] = { start: 0, end: 1, address: 'hacked', generation: 99 };
    snapshot.push({ start: 1, end: KEY_SPACE, address: 'hacked', generation: 99 });

    router.assertInvariant();
    assert.equal(router.ownerOf(0), 'a:1');
  });

  test('mutating a lookup result does not affect the table', () => {
    const router = new Router({ initialAddress: 'a:1', initialGeneration: 0 });
    const segment = router.lookup(0) as { address: string };
    segment.address = 'hacked';
    assert.equal(router.ownerOf(0), 'a:1');
  });
});
