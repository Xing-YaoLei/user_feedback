import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  KEY_SPACE,
  Router,
  RoutingClient,
  type PermanentHint,
} from '../src/index.ts';
import { createScriptedTransport, ok, type Handler } from './helpers.ts';

const permanent = (
  start: number,
  end: number,
  address: string,
  generation: number,
): PermanentHint => ({ kind: 'permanent', start, end, address, generation });

describe('stress: partition invariants', () => {
  test('the table stays a valid partition under many random hints', () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });

    // Deterministic pseudo-random generator so failures reproduce.
    let state = 0x1234_5678;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let index = 0; index < 500; index += 1) {
      const a = random() % KEY_SPACE;
      const b = random() % KEY_SPACE;
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      if (start === end) continue;

      const generation = random() % 32;
      const address = `owner:${random() % 8}`;
      router.applyPermanentHint(permanent(start, end, address, generation));
      router.assertInvariant();
    }

    const segments = router.snapshot();
    assert.ok(segments.length > 1);
    for (const segment of segments) {
      assert.equal(router.ownerOf(segment.start), segment.address);
      assert.equal(router.ownerOf(segment.end - 1), segment.address);
    }
    assert.equal(router.lookup(0).start, 0);
    assert.equal(router.lookup(KEY_SPACE - 1).end, KEY_SPACE);
  });

  test('full-space hints always restore a single segment', () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    for (let generation = 1; generation <= 50; generation += 1) {
      router.applyPermanentHint(
        permanent(0, KEY_SPACE, `owner:${generation % 3}`, generation),
      );
      router.assertInvariant();
      assert.equal(router.size, 1);
      assert.equal(router.lookup(12345).generation, generation);
    }
  });
});

describe('stress: interleaved calls on disjoint ranges', () => {
  test('every call adopts its own range and generation, and no hint conflicts', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });

    // Eight disjoint buckets, each with its own owner and generation. This is
    // the "adjacent shards, different generations" case from the spec.
    const bucketSize = KEY_SPACE / 8;
    const bucketOf = (key: number): number => Math.floor(key / bucketSize);
    const ownerOf = (key: number): string => `owner:${bucketOf(key)}`;
    const generationOf = (key: number): number => bucketOf(key) + 1;

    const transport = createScriptedTransport();
    transport.setHandler('seed:0', ((request) => {
      const bucket = bucketOf(request.key);
      return {
        kind: 'redirect',
        hint: permanent(
          bucket * bucketSize,
          (bucket + 1) * bucketSize,
          ownerOf(request.key),
          generationOf(request.key),
        ),
      };
    }) satisfies Handler);

    for (let bucket = 0; bucket < 8; bucket += 1) {
      transport.setHandler(`owner:${bucket}`, ok(`value-${bucket}`));
    }

    const client = new RoutingClient({ router, transport });
    const keys = [
      0,
      1,
      bucketSize,
      bucketSize * 3 + 7,
      bucketSize * 4,
      KEY_SPACE - 2,
    ];

    // All calls start before any redirect has been applied, so their initial
    // owners are read from the same table state.
    const results = await Promise.all(keys.map((key) => client.call(key, key)));

    for (const [index, result] of results.entries()) {
      const key = keys[index];
      assert.equal(result.ok, true, `key ${key}: ${JSON.stringify(result)}`);
      if (!result.ok) continue;
      assert.equal(result.value, `value-${bucketOf(key)}`);
      assert.equal(result.address, ownerOf(key));
      assert.equal(result.generation, generationOf(key));
    }

    router.assertInvariant();

    // Each adopted bucket is exactly the owner it learned.
    for (const key of keys) {
      const segment = router.lookup(key);
      assert.equal(segment.address, ownerOf(key));
      assert.equal(segment.generation, generationOf(key));
      assert.ok(key >= segment.start && key < segment.end);
    }

    // Untouched regions still belong to the seed.
    assert.equal(router.ownerOf(bucketSize * 2), 'seed:0');
    assert.equal(router.lookup(bucketSize * 2).generation, 0);
  });

  test('a later permanent hint from a stale owner cannot regress a range', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 100, 'current:1', 10));

    const transport = createScriptedTransport({ 'current:1': ok('ok') });
    const client = new RoutingClient({ router, transport });

    // An old request that was already in flight returns an outdated hint.
    const stale: PermanentHint = permanent(0, 100, 'ancient:1', 4);
    const outcome = router.applyPermanentHint(stale);
    assert.equal(outcome.status, 'stale');
    assert.equal(router.ownerOf(50), 'current:1');

    const result = await client.call(50, null);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 'ok');
  });
});
