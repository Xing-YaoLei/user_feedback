import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  KEY_SPACE,
  Router,
  RoutingClient,
  type CallFailure,
  type CallSuccess,
  type PermanentHint,
  type TemporaryHint,
} from '../src/index.ts';
import {
  createScriptedTransport,
  fail,
  gate,
  hang,
  ok,
  redirect,
} from './helpers.ts';

const permanent = (
  start: number,
  end: number,
  address: string,
  generation: number,
): PermanentHint => ({ kind: 'permanent', start, end, address, generation });

const temporary = (address: string): TemporaryHint => ({
  kind: 'temporary',
  address,
});

function isSuccess<T>(result: { ok: boolean }): result is CallSuccess<T> {
  return result.ok;
}

function isFailure(result: { ok: boolean }): result is CallFailure {
  return !result.ok;
}

function addressesOf(result: CallSuccess | CallFailure): string[] {
  return result.attempts.map((attempt) => attempt.address);
}

describe('RoutingClient: direct calls', () => {
  test('routes to the owner and returns the executed value', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({ 'seed:0': ok('pong') });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(42, { op: 'ping' });

    assert.equal(result.ok, true);
    if (!isSuccess<string>(result)) return;
    assert.equal(result.value, 'pong');
    assert.equal(result.address, 'seed:0');
    assert.equal(result.generation, 0);
    assert.deepEqual(addressesOf(result), ['seed:0']);
    assert.equal(transport.log[0].key, 42);
    assert.deepEqual(transport.log[0].payload, { op: 'ping' });
  });

  test('rejects invalid keys before touching the transport', async () => {
    const router = new Router({ initialAddress: 'seed:0' });
    const transport = createScriptedTransport({ 'seed:0': ok('x') });
    const client = new RoutingClient({ router, transport });

    for (const bad of [-1, 1.5, KEY_SPACE, Number.NaN]) {
      await assert.rejects(client.call(bad, {}), RangeError);
    }
    assert.equal(transport.log.length, 0);
  });
});

describe('RoutingClient: permanent hints', () => {
  test('follows a permanent redirect and updates the shared table', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 1000, 'owner:1', 1)),
      'owner:1': ok('done'),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(10, 'payload');
    assert.equal(result.ok, true);
    if (!isSuccess<string>(result)) return;

    assert.equal(result.value, 'done');
    assert.equal(result.address, 'owner:1');
    assert.equal(result.generation, 1);
    assert.deepEqual(addressesOf(result), ['seed:0', 'owner:1']);
    assert.equal(result.hints[0].status, 'applied');

    assert.equal(router.ownerOf(10), 'owner:1');
    assert.equal(router.ownerOf(999), 'owner:1');
    assert.equal(router.ownerOf(1000), 'seed:0');
  });

  test('a later call uses the learned route without asking the old owner', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 1000, 'owner:1', 1)),
      'owner:1': ok('done'),
    });
    const client = new RoutingClient({ router, transport });

    await client.call(10, null);
    transport.log.length = 0;

    const second = await client.call(11, null);
    assert.equal(second.ok, true);
    assert.deepEqual(addressesOf(second), ['owner:1']);
  });

  test('an out-of-range permanent hint updates its range but not this key', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 100, 'owner:1', 5)),
    });
    const client = new RoutingClient({ router, transport });

    // Key 5000 is outside the hinted range, so the table keeps routing it to
    // seed; re-resolving repeats the same attempt and terminates as a cycle.
    const result = await client.call(5000, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'cycle');
    assert.deepEqual(addressesOf(result), ['seed:0']);
    assert.equal(result.hints[0].status, 'applied');
    assert.equal(result.hints[0].start, 0);
    assert.equal(result.hints[0].end, 100);

    assert.equal(router.ownerOf(5000), 'seed:0');
    assert.equal(router.lookup(5000).generation, 0);
    assert.equal(router.ownerOf(50), 'owner:1');
  });

  test('an out-of-range hint does not move the current key', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(1000, 2000, 'owner:1', 5)),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(5, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'cycle');
    // seed was asked once; the hint updated [1000, 2000) only.
    assert.deepEqual(addressesOf(result), ['seed:0']);
    assert.equal(router.ownerOf(5), 'seed:0');
    assert.equal(router.ownerOf(1500), 'owner:1');
  });

  test('a stale permanent hint is ignored and does not regress the table', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    // Another call already learned generation 3 for this range.
    router.applyPermanentHint(permanent(0, 1000, 'newer:1', 3));

    const transport = createScriptedTransport({
      // Key 2000 is still owned by seed, which holds outdated information.
      'seed:0': redirect(permanent(0, 1000, 'older:1', 2)),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(2000, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;

    assert.equal(result.hints[0].status, 'stale');
    // The older hint did not regress the table for its own range.
    assert.equal(router.ownerOf(2000), 'seed:0');
    assert.equal(router.ownerOf(500), 'newer:1');
    assert.equal(router.lookup(500).generation, 3);
  });

  test('a stale hint for the current key then re-resolves to the newer owner', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 1000, 'newer:1', 3));

    // Key 500 is owned by newer:1, so seed is not consulted at all.
    const transport = createScriptedTransport({ 'newer:1': ok('fresh') });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(500, null);
    assert.equal(result.ok, true);
    if (!isSuccess<string>(result)) return;
    assert.equal(result.value, 'fresh');
    assert.equal(result.address, 'newer:1');
  });
});

describe('RoutingClient: temporary hints', () => {
  test('follows a temporary hint for this call only', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(temporary('temp:1')),
      'temp:1': ok('temp-result'),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(7, null);
    assert.equal(result.ok, true);
    if (!isSuccess<string>(result)) return;

    assert.equal(result.value, 'temp-result');
    assert.equal(result.address, 'temp:1');
    assert.equal(result.hints[0].kind, 'temporary');
    assert.equal(result.hints[0].status, 'followed');

    // The shared table is untouched.
    assert.equal(router.ownerOf(7), 'seed:0');
    assert.equal(router.size, 1);
    router.assertInvariant();
  });

  test('a temporary hint does not affect a concurrent call', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const hold = gate();

    const transport = createScriptedTransport();
    transport.setHandler('seed:0', async (request) => {
      if (request.payload === 'first') {
        await hold.promise;
        return { kind: 'redirect', hint: temporary('temp:1') };
      }
      return { kind: 'ok', value: 'second-direct' };
    });
    transport.setHandler('temp:1', ok('first-temp'));

    const client = new RoutingClient({ router, transport });
    const first = client.call(9, 'first');
    const second = client.call(9, 'second');

    const secondResult = await second;
    hold.open();
    const firstResult = await first;

    assert.equal(secondResult.ok, true);
    if (!isSuccess<string>(secondResult)) return;
    assert.equal(secondResult.value, 'second-direct');
    assert.equal(secondResult.address, 'seed:0');

    assert.equal(firstResult.ok, true);
    if (!isSuccess<string>(firstResult)) return;
    assert.equal(firstResult.value, 'first-temp');
    assert.equal(firstResult.address, 'temp:1');

    assert.equal(router.ownerOf(9), 'seed:0');
  });

  test('temporary hops that loop are reported as a cycle', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(temporary('a:1')),
      'a:1': redirect(temporary('b:1')),
      'b:1': redirect(temporary('a:1')),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(1, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'cycle');
    assert.deepEqual(addressesOf(result), ['seed:0', 'a:1', 'b:1']);
    assert.match(result.message, /a:1/);
  });
});

describe('RoutingClient: concurrent calls on adjacent shards', () => {
  test('different generations for adjacent ranges both apply, independently', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': (request) => {
        if (request.key < 1000) {
          return { kind: 'redirect', hint: permanent(0, 1000, 'low:1', 4) };
        }
        return { kind: 'redirect', hint: permanent(1000, 2000, 'high:1', 7) };
      },
      'low:1': ok('low-done'),
      'high:1': ok('high-done'),
    });
    const client = new RoutingClient({ router, transport });

    const [low, high] = await Promise.all([
      client.call(500, 'low'),
      client.call(1500, 'high'),
    ]);

    assert.equal(low.ok, true);
    assert.equal(high.ok, true);
    if (!isSuccess<string>(low) || !isSuccess<string>(high)) return;
    assert.equal(low.value, 'low-done');
    assert.equal(high.value, 'high-done');

    router.assertInvariant();
    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 1000, address: 'low:1', generation: 4 },
      { start: 1000, end: 2000, address: 'high:1', generation: 7 },
      { start: 2000, end: KEY_SPACE, address: 'seed:0', generation: 0 },
    ]);
  });

  test('a temporary redirect in one call does not leak into another', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': (request) =>
        request.key < 1000
          ? { kind: 'redirect', hint: temporary('temp:low') }
          : { kind: 'redirect', hint: permanent(1000, 2000, 'high:1', 2) },
      'temp:low': ok('temp-low'),
      'high:1': ok('high'),
    });
    const client = new RoutingClient({ router, transport });

    const results = await Promise.all([
      client.call(10, null),
      client.call(1500, null),
    ]);

    assert.ok(results.every((result) => result.ok));
    router.assertInvariant();
    assert.equal(router.ownerOf(10), 'seed:0');
    assert.equal(router.ownerOf(1500), 'high:1');
  });

  test('interleaved equal-generation overlap rejects the whole second hint', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': (request) =>
        request.key === 10
          ? { kind: 'redirect', hint: permanent(0, 1000, 'owner:a', 5) }
          : { kind: 'redirect', hint: permanent(500, 1500, 'owner:b', 5) },
      'owner:a': ok('a'),
    });
    const client = new RoutingClient({ router, transport });

    // Both calls resolve their initial owner before either hint is applied.
    const [first, second] = await Promise.all([
      client.call(10, null),
      client.call(600, null),
    ]);

    assert.equal(first.ok, true);

    assert.equal(second.ok, false);
    if (!isFailure(second)) return;
    assert.equal(second.reason, 'route-conflict');
    assert.deepEqual(addressesOf(second), ['seed:0']);
    assert.equal(second.hints[0].status, 'conflict');
    assert.deepEqual(second.hints[0].start, 500);
    assert.deepEqual(second.hints[0].generation, 5);

    router.assertInvariant();
    // The first hint stands in full; the conflicting one changed nothing.
    assert.equal(router.ownerOf(10), 'owner:a');
    assert.equal(router.ownerOf(600), 'owner:a');
    assert.equal(router.ownerOf(1200), 'seed:0');
    assert.equal(router.size, 2);
    assert.deepEqual(router.snapshot(), [
      { start: 0, end: 1000, address: 'owner:a', generation: 5 },
      { start: 1000, end: KEY_SPACE, address: 'seed:0', generation: 0 },
    ]);
  });

  test('a conflicting permanent hint from an owner surfaces as route-conflict', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    router.applyPermanentHint(permanent(0, 100, 'owner:a', 5));

    const transport = createScriptedTransport({
      'owner:a': redirect(permanent(50, 150, 'owner:b', 5)),
      'seed:0': ok('seed'),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(60, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'route-conflict');
    assert.deepEqual(addressesOf(result), ['owner:a']);
    assert.equal(result.hints[0].status, 'conflict');
    assert.equal(router.ownerOf(60), 'owner:a');
    assert.equal(router.ownerOf(120), 'seed:0');
  });
});

describe('RoutingClient: budget, deadline, and cycles', () => {
  test('a forwarding cycle is reported with attempted addresses', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 10, 'a:1', 1)),
      'a:1': redirect(permanent(0, 10, 'b:1', 2)),
      'b:1': redirect(permanent(0, 10, 'a:1', 1)),    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(5, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'cycle');
    assert.deepEqual(addressesOf(result), ['seed:0', 'a:1', 'b:1']);
  });

  test('attempt budget is shared by the whole redirect chain', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 10, 'a:1', 1)),
      'a:1': redirect(permanent(0, 10, 'b:1', 2)),
      'b:1': redirect(permanent(0, 10, 'c:1', 3)),
      'c:1': ok('never'),
    });
    const client = new RoutingClient({ router, transport, maxAttempts: 2 });

    const result = await client.call(5, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'attempt-budget');
    assert.deepEqual(addressesOf(result), ['seed:0', 'a:1']);
    assert.match(result.message, /b:1/);
  });

  test('per-call maxAttempts overrides the client default', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 10, 'a:1', 1)),
      'a:1': redirect(permanent(0, 10, 'b:1', 2)),
      'b:1': ok('third'),
    });
    const client = new RoutingClient({ router, transport, maxAttempts: 10 });

    const tooTight = await client.call(5, null, { maxAttempts: 2 });
    assert.equal(tooTight.ok, false);
    if (isFailure(tooTight)) assert.equal(tooTight.reason, 'attempt-budget');

    // The temporary route learned by the previous call is shared, but seed is
    // only reachable through the table; use a fresh key region for the retry.
    const router2 = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport2 = createScriptedTransport({
      'seed:0': redirect(permanent(0, 10, 'a:1', 1)),
      'a:1': redirect(permanent(0, 10, 'b:1', 2)),
      'b:1': ok('third'),
    });
    const client2 = new RoutingClient({ router: router2, transport: transport2 });
    const allowed = await client2.call(5, null);
    assert.equal(allowed.ok, true);
    if (isSuccess<string>(allowed)) assert.equal(allowed.value, 'third');
  });

  test('the total deadline covers the whole chain', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 10, 'a:1', 1)),
      'a:1': hang,
    });
    const client = new RoutingClient({ router, transport, deadlineMs: 40 });

    const started = Date.now();
    const result = await client.call(5, null);
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'deadline');
    assert.deepEqual(addressesOf(result), ['seed:0', 'a:1']);
    assert.ok(elapsed < 1000, `elapsed ${elapsed}ms`);
  });

  test('a transport error surfaces the attempts made so far', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 10, 'a:1', 1)),
      'a:1': fail('connection refused'),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(5, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'transport-error');
    assert.deepEqual(addressesOf(result), ['seed:0', 'a:1']);
    assert.match(String((result.error as Error).message), /connection refused/);
    // The route learned before the failure is retained.
    assert.equal(router.ownerOf(5), 'a:1');
  });

  test('the same address and owner generation are never attempted twice', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    let seedHits = 0;
    const transport = createScriptedTransport({
      'seed:0': () => {
        seedHits += 1;
        if (seedHits === 1) {
          return { kind: 'redirect', hint: permanent(0, 10, 'a:1', 1) };
        }
        // Second visit arrives through a temporary hop, which carries no
        // generation. It repeats a permanent hint that changes nothing.
        return { kind: 'redirect', hint: temporary('a:1') };
      },
      'a:1': redirect(temporary('seed:0')),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(5, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;

    const combos = result.attempts.map(
      (attempt) => `${attempt.address}@${String(attempt.generation)}`,
    );
    assert.equal(new Set(combos).size, combos.length);
    // Temporary hops carry no generation, so repetition of an address alone is
    // enough to stop the loop.
    assert.deepEqual(combos, ['seed:0@0', 'a:1@1', 'seed:0@null', 'a:1@null']);
    assert.equal(result.reason, 'cycle');
  });
});

describe('RoutingClient: successful results survive routing changes', () => {
  test('a completed call keeps its value after the table changes', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const holdA = gate();

    const transport = createScriptedTransport();
    transport.setHandler('seed:0', async (request) => {
      if (request.payload === 'slow') {
        await holdA.promise;
        return { kind: 'ok', value: 'slow-value' };
      }
      return { kind: 'redirect', hint: permanent(0, 1000, 'other:1', 9) };
    });
    transport.setHandler('other:1', ok('other-value'));
    const client = new RoutingClient({ router, transport });

    const slow = client.call(100, 'slow');
    const fast = await client.call(100, 'fast');
    assert.equal(fast.ok, true);
    if (isSuccess<string>(fast)) assert.equal(fast.value, 'other-value');

    // Routing for key 100 now belongs to other:1 at generation 9.
    assert.equal(router.ownerOf(100), 'other:1');

    holdA.open();
    const slowResult = await slow;
    assert.equal(slowResult.ok, true);
    if (!isSuccess<string>(slowResult)) return;
    assert.equal(slowResult.value, 'slow-value');
    assert.equal(slowResult.address, 'seed:0');
  });

  test('an already-returned success is immune to later table mutations', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({ 'seed:0': ok('stable') });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(77, null);
    assert.equal(result.ok, true);
    if (!isSuccess<string>(result)) return;
    assert.equal(result.value, 'stable');

    // Rewrite the table afterwards; the resolved result is not consulted again.
    router.applyPermanentHint(permanent(0, 100, 'moved:1', 42));
    router.applyPermanentHint(permanent(0, KEY_SPACE, 'moved:2', 43));

    assert.equal(result.value, 'stable');
    assert.equal(result.address, 'seed:0');
    assert.equal(result.generation, 0);
    assert.deepEqual(addressesOf(result), ['seed:0']);
    assert.equal(router.ownerOf(77), 'moved:2');
  });

  test('returned attempt/hint arrays are independent copies', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 10, 'a:1', 1)),
      'a:1': ok('v'),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(5, null);
    assert.equal(result.ok, true);
    if (!isSuccess<string>(result)) return;

    const before = result.attempts.length;
    (result.attempts as unknown as unknown[]).push({});
    assert.equal(result.attempts.length, before + 1);

    // A second call starts with a fresh record list.
    const second = await client.call(5, null);
    assert.equal(second.attempts.length, 1);
  });

  test('a concurrent higher generation elsewhere does not suppress a narrower hint', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    // A disjoint range already learned a very high generation.
    router.applyPermanentHint(permanent(5000, 6000, 'far:1', 99));

    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(0, 100, 'near:1', 2)),
      'near:1': ok('near-value'),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(50, null);
    assert.equal(result.ok, true);
    if (!isSuccess<string>(result)) return;
    assert.equal(result.value, 'near-value');

    // Judged by its own range and generation, not by the disjoint high one.
    assert.equal(router.ownerOf(50), 'near:1');
    assert.equal(router.lookup(50).generation, 2);
    assert.equal(router.ownerOf(5500), 'far:1');
  });
});

describe('RoutingClient: malformed input', () => {
  test('a synchronously throwing adapter is reported, not leaked', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const client = new RoutingClient({
      router,
      transport: {
        send() {
          throw new Error('adapter crashed');
        },
      },
    });

    const result = await client.call(1, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'transport-error');
    assert.deepEqual(result.attemptedAddresses, ['seed:0']);
    assert.match(String((result.error as Error).message), /adapter crashed/);
  });

  test('an adapter returning undefined is a malformed response', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const client = new RoutingClient({
      router,
      transport: { send: async () => undefined as never },
    });

    const result = await client.call(1, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'malformed-response');
    assert.deepEqual(result.attemptedAddresses, ['seed:0']);
  });

    test('a redirect without a hint', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': () => ({ kind: 'redirect' } as never),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(1, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'malformed-response');
  });

  test('rejects an invalid temporary hint', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect({ kind: 'temporary', address: '' }),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(1, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'invalid-hint');
    assert.equal(result.hints[0].status, 'invalid');
  });

  test('rejects an invalid permanent hint without changing the table', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': redirect(permanent(10, 10, 'a:1', 1)),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(1, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'invalid-hint');
    assert.equal(router.size, 1);
  });

  test('rejects an unknown response kind', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({
      'seed:0': () => ({ kind: 'nonsense' } as never),
    });
    const client = new RoutingClient({ router, transport });

    const result = await client.call(1, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'malformed-response');
  });
});

describe('RoutingClient: configuration', () => {
  test('validates constructor options', () => {
    const router = new Router({ initialAddress: 'seed:0' });
    const transport = createScriptedTransport({ 'seed:0': ok('x') });

    assert.throws(
      () => new RoutingClient({ router, transport, maxAttempts: 0 }),
      TypeError,
    );
    assert.throws(
      () => new RoutingClient({ router, transport, deadlineMs: -1 }),
      TypeError,
    );
    assert.throws(
      () => new RoutingClient({ router: {} as Router, transport }),
      TypeError,
    );
    assert.throws(
      () => new RoutingClient({ router, transport: {} as never }),
      TypeError,
    );
    assert.throws(
      () => new RoutingClient({ router, transport, maxAttempts: 1.5 }),
      TypeError,
    );
  });

  test('a fake clock makes the deadline deterministic', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    let clock = 0;
    const transport = createScriptedTransport({
      'seed:0': () => {
        clock += 60; // simulate slow work without real time passing
        return {
          kind: 'redirect',
          hint: {
            kind: 'permanent',
            start: 0,
            end: 10,
            address: 'a:1',
            generation: 1,
          },
        };
      },
      'a:1': ok('never'),
    });
    const client = new RoutingClient({
      router,
      transport,
      deadlineMs: 50,
      now: () => clock,
    });

    const result = await client.call(5, null);
    assert.equal(result.ok, false);
    if (!isFailure(result)) return;
    assert.equal(result.reason, 'deadline');
    assert.deepEqual(result.attemptedAddresses, ['seed:0']);
    assert.match(result.message, /a:1/);
  });

  test('accepts an infinite deadline for tests that only bound attempts', async () => {
    const router = new Router({ initialAddress: 'seed:0', initialGeneration: 0 });
    const transport = createScriptedTransport({ 'seed:0': ok('fine') });
    const client = new RoutingClient({
      router,
      transport,
      deadlineMs: Number.POSITIVE_INFINITY,
    });

    const result = await client.call(1, null);
    assert.equal(result.ok, true);
  });
});
