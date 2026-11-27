import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RouteResult } from '../src/index.ts';
import { Router, RouterError, compileTopology } from '../src/index.ts';
import { ORPHAN_KEY, shopTopology } from './fixtures.ts';

function addBinding(input: ReturnType<typeof shopTopology>, binding: {
  id: string;
  source: string;
  destination: string;
  destinationKind: 'queue' | 'exchange';
  routingKey?: string;
}) {
  return {
    ...input,
    bindings: [...(input.bindings ?? []), binding],
  };
}

test('version starts at 0 and increments once per successful replacement', () => {
  const router = new Router(shopTopology());
  assert.equal(router.version, 0);
  assert.equal(router.snapshotInfo().version, 0);

  router.replaceTopology(shopTopology());
  assert.equal(router.version, 1);
  assert.deepEqual(router.snapshotInfo(), {
    version: 1,
    exchangeCount: 14,
    queueCount: 6,
    bindingCount: 13,
  });
});

test('a failed replacement is atomic: previous topology and version survive', () => {
  const router = new Router(shopTopology());
  const before = router.topology;
  const versionBefore = router.version;

  assert.throws(
    () =>
      router.replaceTopology({
        exchanges: [{ name: 'broken', kind: 'topic' }],
        queues: [{ name: 'q' }],
        bindings: [
          // Invalid topic pattern: compilation must fail before any swap.
          { id: 'b', source: 'broken', destination: 'q', destinationKind: 'queue', routingKey: 'a..b' },
        ],
      }),
    (error: unknown) => error instanceof RouterError && error.code === 'INVALID_TOPOLOGY',
  );

  assert.equal(router.version, versionBefore);
  assert.equal(router.topology, before);
  assert.equal(router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY }).routable, true);
});

test('every result carries the topology version that produced it', () => {
  const router = new Router(shopTopology());
  assert.equal(router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY }).topologyVersion, 0);

  router.replaceTopology(shopTopology());
  assert.equal(router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY }).topologyVersion, 1);
});

test('adding a normal exit stops the alternate chain immediately', () => {
  const router = new Router(shopTopology());

  const before = router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY });
  assert.deepEqual(before.alternates, [{ exchange: 'ingress', alternateExchange: 'dlx-entry' }]);
  assert.deepEqual(before.targets.map((target) => target.queue), ['q-dead']);

  // One more ordinary binding that catches the same key. Nothing else changes.
  router.replaceTopology(
    addBinding(shopTopology(), {
      id: 'b20',
      source: 'ingress',
      destination: 'q-orphan',
      destinationKind: 'queue',
      routingKey: 'orphan.#',
    }),
  );

  const after = router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY });
  assert.equal(after.routable, true);
  assert.deepEqual(after.alternates, []);
  assert.equal(after.resolvedFrom, 'ingress');
  assert.deepEqual(after.targets, [{ queue: 'q-orphan', bindingPath: ['b20'] }]);
  assert.equal(after.topologyVersion, 1);
});

test('removing the normal exit re-enables the alternate chain', () => {
  const router = new Router(
    addBinding(shopTopology(), {
      id: 'b20',
      source: 'ingress',
      destination: 'q-orphan',
      destinationKind: 'queue',
      routingKey: 'orphan.#',
    }),
  );
  assert.deepEqual(router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY }).alternates, []);

  router.replaceTopology(shopTopology());
  const result = router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY });
  assert.deepEqual(result.alternates, [{ exchange: 'ingress', alternateExchange: 'dlx-entry' }]);
  assert.deepEqual(result.targets.map((target) => target.queue), ['q-dead']);
});

test('an in-flight route keeps its captured snapshot across a replacement', async () => {
  const router = new Router(shopTopology());
  const pinned = router.capture();
  assert.equal(pinned.version, 0);

  // Yield to the event loop, then replace the topology. The pinned handle must
  // still route against the version it captured.
  await Promise.resolve();
  router.replaceTopology(
    addBinding(shopTopology(), {
      id: 'b20',
      source: 'ingress',
      destination: 'q-orphan',
      destinationKind: 'queue',
      routingKey: 'orphan.#',
    }),
  );

  const old = pinned.route({ exchange: 'ingress', routingKey: ORPHAN_KEY });
  assert.deepEqual(old.alternates, [{ exchange: 'ingress', alternateExchange: 'dlx-entry' }]);
  assert.equal(old.topologyVersion, 0);

  // A fresh route sees the new topology.
  const fresh = router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY });
  assert.deepEqual(fresh.alternates, []);
  assert.equal(fresh.topologyVersion, 1);

  // Pin metadata is a frozen snapshot of the captured version.
  assert.ok(Object.isFrozen(pinned.info));
  assert.equal(pinned.info.version, 0);
  assert.equal(pinned.info.bindingCount, 13);
});

test('routeBatch pins one version even if the topology changes between calls', () => {
  const router = new Router(shopTopology());

  // A batch routed against version 0.
  const batchV0 = router.routeBatch([
    { exchange: 'ingress', routingKey: ORPHAN_KEY },
    { exchange: 'ingress', routingKey: 'order.created' },
  ]);
  assert.deepEqual(batchV0.map((result) => result.topologyVersion), [0, 0]);

  router.replaceTopology(
    addBinding(shopTopology(), {
      id: 'b20',
      source: 'ingress',
      destination: 'q-orphan',
      destinationKind: 'queue',
      routingKey: 'orphan.#',
    }),
  );

  const batchV1 = router.routeBatch([
    { exchange: 'ingress', routingKey: ORPHAN_KEY },
    { exchange: 'ingress', routingKey: 'order.created' },
  ]);
  assert.deepEqual(batchV1.map((result) => result.topologyVersion), [1, 1]);
  assert.deepEqual(batchV1[0].alternates, []);
});

test('interleaved replaces and routes never yield a torn topology', async () => {
  const base = shopTopology();
  const withExit = addBinding(base, {
    id: 'b20',
    source: 'ingress',
    destination: 'q-orphan',
    destinationKind: 'queue',
    routingKey: 'orphan.#',
  });

  const router = new Router(base);
  const observed: RouteResult[] = [];

  const routes: Promise<void>[] = [];
  for (let i = 0; i < 50; i++) {
    routes.push(
      (async () => {
        await Promise.resolve();
        observed.push(router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY }));
      })(),
    );
    if (i % 5 === 0) {
      await Promise.resolve();
      router.replaceTopology(i % 10 === 0 ? withExit : base);
    }
  }
  await Promise.all(routes);

  assert.equal(observed.length, 50);
  for (const result of observed) {
    // Every observation must be internally consistent: either it used the
    // alternate (version without the exit) or it went direct, never both.
    const usedAlternate = result.alternates.length > 0;
    const wentDirect = result.resolvedFrom === 'ingress';
    assert.equal(usedAlternate, !wentDirect);
    if (usedAlternate) assert.deepEqual(result.targets.map((t) => t.queue), ['q-dead']);
    else assert.deepEqual(result.targets.map((t) => t.queue), ['q-orphan']);
    assert.ok(result.topologyVersion >= 0);
  }
});

test('compiled snapshots can be swapped in directly and are not re-validated', () => {
  const compiled = compileTopology(shopTopology());
  const router = new Router(compiled);
  assert.equal(router.topology, compiled);
  router.replaceTopology(compiled);
  assert.equal(router.topology, compiled);
  assert.equal(router.version, 1);
});

test('replacement is whole-batch: nothing from the previous topology survives', () => {
  const router = new Router(shopTopology());
  assert.deepEqual(
    router
      .route({ exchange: 'ingress', routingKey: 'order.created' })
      .targets.map((target) => target.queue),
    ['q-left', 'q-right'],
  );

  // A brand-new graph that happens to reuse the `ingress` name but has no
  // q-left/q-right bindings and no alternate. The old graph must be gone.
  router.replaceTopology({
    exchanges: [{ name: 'ingress', kind: 'fanout' }],
    queues: [{ name: 'fresh' }],
    bindings: [{ id: 'n1', source: 'ingress', destination: 'fresh', destinationKind: 'queue' }],
  });

  const result = router.route({ exchange: 'ingress', routingKey: 'order.created' });
  assert.deepEqual(result.targets.map((target) => target.queue), ['fresh']);
  assert.deepEqual(result.alternates, []);
  assert.throws(() => router.route({ exchange: 'split', routingKey: 'x' }), /not in the topology/);
});

test('empty topology is valid and everything is unroutable', () => {
  const router = new Router();
  assert.equal(router.version, 0);
  assert.equal(router.snapshotInfo().exchangeCount, 0);
  assert.throws(() => router.route({ exchange: 'anything', routingKey: 'x' }), /not in the topology/);
});
