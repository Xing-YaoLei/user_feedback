import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Router, compileTopology, routeOnTopology } from '../src/index.ts';
import {
  DIAMOND_KEY,
  DOWNSTREAM_ONLY_KEY,
  ORPHAN_KEY,
  PARTIAL_KEY,
  shopTopology,
} from './fixtures.ts';

function targets(result: ReturnType<typeof routeOnTopology>) {
  return result.targets.map((target) => ({ queue: target.queue, bindingPath: [...target.bindingPath] }));
}

test('diamond: a queue reachable along several branches is returned exactly once', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'ingress', routingKey: DIAMOND_KEY });

  assert.equal(result.routable, true);
  assert.equal(result.resolvedFrom, 'ingress');
  assert.deepEqual(result.alternates, []);
  // q-left is reachable via the left arm (b02) and the right arm (b03); it
  // must appear once, with the shortest id-sequence path (b02 < b03).
  assert.deepEqual(targets(result), [
    { queue: 'q-left', bindingPath: ['b01', 'b02', 'b04'] },
    { queue: 'q-right', bindingPath: ['b01', 'b03', 'b05'] },
  ]);
});

test('diamond: shorter path wins over a smaller binding id', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'ingress', routingKey: PARTIAL_KEY });
  // b00 is lexicographically smallest but reaches q-left in 4 hops via the
  // cycle; the 3-hop b01,b02,b04 path must win.
  assert.deepEqual(targets(result), [
    { queue: 'q-left', bindingPath: ['b01', 'b02', 'b04'] },
  ]);
});

test('normal cycle terminates and never uses a downstream alternate', () => {
  const router = new Router(shopTopology());
  const topology = compileTopology(shopTopology());
  const result = routeOnTopology(topology, { exchange: 'ingress', routingKey: DIAMOND_KEY });

  // shadow-dlx belongs to `right`; it would only be reachable if the router
  // consulted a downstream alternate during normal traversal.
  assert.equal(result.targets.some((target) => target.queue === 'q-shadow'), false);

  // The cycle left -> cycle-a -> cycle-b -> left is entered once, so the
  // b00 path (cycle-b -> q-left) loses to the 3-hop direct arm.
  assert.deepEqual(
    result.targets.map((target) => target.bindingPath),
    [
      ['b01', 'b02', 'b04'],
      ['b01', 'b03', 'b05'],
    ],
  );
});

test('downstream alternate is ignored: only the entry alternate may fire', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'ingress', routingKey: DOWNSTREAM_ONLY_KEY });

  // `order` reaches split -> left/right, but no queue matches the direct key.
  // `right` declares shadow-dlx; it must NOT be used. ingress's alternate is.
  assert.equal(result.routable, true);
  assert.deepEqual(result.alternates, [{ exchange: 'ingress', alternateExchange: 'dlx-entry' }]);
  assert.equal(result.resolvedFrom, 'dlx-entry');
  assert.deepEqual(targets(result), [{ queue: 'q-dead', bindingPath: ['b11'] }]);
  assert.equal(result.targets.some((target) => target.queue === 'q-shadow'), false);
});

test('alternate fallback starts from the entry and exposes each hop', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'ingress', routingKey: ORPHAN_KEY });

  assert.equal(result.routable, true);
  assert.equal(result.exchange, 'ingress');
  assert.equal(result.routingKey, ORPHAN_KEY);
  assert.deepEqual(result.alternates, [{ exchange: 'ingress', alternateExchange: 'dlx-entry' }]);
  assert.deepEqual(targets(result), [{ queue: 'q-dead', bindingPath: ['b11'] }]);
});

test('alternate chain advances hop by hop until a non-empty result', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'chain-a', routingKey: 'anything' });

  assert.equal(result.routable, true);
  assert.equal(result.resolvedFrom, 'chain-c');
  assert.deepEqual(result.alternates, [
    { exchange: 'chain-a', alternateExchange: 'chain-b' },
    { exchange: 'chain-b', alternateExchange: 'chain-c' },
  ]);
  assert.deepEqual(targets(result), [{ queue: 'q-chain', bindingPath: ['b12'] }]);
});

test('alternate cycle: unroutable, cycle reported from the repeated exchange', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'alt-a', routingKey: 'anything' });

  assert.equal(result.routable, false);
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.alternateCycle, {
    reason: 'alternate-cycle',
    exchanges: ['alt-a', 'alt-b', 'alt-a'],
  });
  // Only hops actually taken are listed; the loop-closing jump lives in the
  // cycle marker instead.
  assert.deepEqual(result.alternates, [{ exchange: 'alt-a', alternateExchange: 'alt-b' }]);
});

test('alternate cycle entered midway reports only the cycle', () => {
  const topology = compileTopology({
    exchanges: [
      { name: 'start', kind: 'fanout', alternateExchange: 'loop-b' },
      { name: 'loop-a', kind: 'fanout', alternateExchange: 'loop-b' },
      { name: 'loop-b', kind: 'fanout', alternateExchange: 'loop-a' },
    ],
    queues: [{ name: 'q' }],
  });
  const result = routeOnTopology(topology, { exchange: 'start', routingKey: '' });

  assert.equal(result.routable, false);
  // Chain: start -> loop-b -> loop-a, whose alternate is loop-b (already
  // visited). The preamble `start` is outside the cycle and must not appear.
  assert.deepEqual(result.alternateCycle, {
    reason: 'alternate-cycle',
    exchanges: ['loop-b', 'loop-a', 'loop-b'],
  });
  assert.deepEqual(result.alternates, [
    { exchange: 'start', alternateExchange: 'loop-b' },
    { exchange: 'loop-b', alternateExchange: 'loop-a' },
  ]);
});

test('an alternate hop that lands on queues stops the chain immediately', () => {
  // start has no normal bindings; its alternate has one. The alternate
  // exchange's own alternate (never-reached) must not add a hop.
  const topology = compileTopology({
    exchanges: [
      { name: 'start', kind: 'fanout', alternateExchange: 'fallback' },
      { name: 'fallback', kind: 'fanout', alternateExchange: 'never' },
      { name: 'never', kind: 'fanout' },
    ],
    queues: [{ name: 'dq' }],
    bindings: [{ id: 'b1', source: 'fallback', destination: 'dq', destinationKind: 'queue' }],
  });
  const result = routeOnTopology(topology, { exchange: 'start' });
  assert.equal(result.resolvedFrom, 'fallback');
  assert.deepEqual(result.alternates, [{ exchange: 'start', alternateExchange: 'fallback' }]);
  assert.deepEqual(result.targets.map((target) => target.queue), ['dq']);
});

test('unroutable without a cycle returns no targets and no cycle marker', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'dead-end', routingKey: 'x' });

  assert.equal(result.routable, false);
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.alternates, []);
  assert.equal(result.alternateCycle, undefined);
  assert.equal(result.resolvedFrom, undefined);
});

test('empty routing key is zero segments', () => {
  const topology = compileTopology({
    exchanges: [{ name: 't', kind: 'topic' }],
    queues: [{ name: 'zero' }, { name: 'one' }],
    bindings: [
      { id: 'b-zero', source: 't', destination: 'zero', destinationKind: 'queue', routingKey: '' },
      { id: 'b-one', source: 't', destination: 'one', destinationKind: 'queue', routingKey: '#' },
    ],
  });
  const result = routeOnTopology(topology, { exchange: 't' });
  assert.equal(result.routingKey, '');
  assert.deepEqual(
    result.targets.map((target) => target.queue),
    ['one', 'zero'],
  );
});

test('fanout delivers to every binding regardless of key', () => {
  const topology = compileTopology({
    exchanges: [{ name: 'f', kind: 'fanout' }],
    queues: [{ name: 'a' }, { name: 'b' }],
    bindings: [
      { id: 'b1', source: 'f', destination: 'a', destinationKind: 'queue', routingKey: 'ignored' },
      { id: 'b2', source: 'f', destination: 'b', destinationKind: 'queue' },
    ],
  });
  const result = routeOnTopology(topology, { exchange: 'f', routingKey: 'whatever' });
  assert.deepEqual(result.targets.map((target) => target.queue), ['a', 'b']);
});

test('direct matches literally, including dots', () => {
  const topology = compileTopology({
    exchanges: [{ name: 'd', kind: 'direct' }],
    queues: [{ name: 'exact' }, { name: 'star' }],
    bindings: [
      { id: 'b1', source: 'd', destination: 'exact', destinationKind: 'queue', routingKey: 'a.b' },
      { id: 'b2', source: 'd', destination: 'star', destinationKind: 'queue', routingKey: '*' },
    ],
  });
  const result = routeOnTopology(topology, { exchange: 'd', routingKey: 'a.b' });
  assert.deepEqual(result.targets.map((target) => target.queue), ['exact']);
});

test('routing rejects unknown exchanges and malformed keys', () => {
  const router = new Router(shopTopology());
  assert.throws(
    () => router.route({ exchange: 'missing', routingKey: 'a' }),
    /not in the topology/,
  );
  assert.throws(() => router.route({ exchange: 'ingress', routingKey: 'a..b' }), /empty segment/);
});

test('route results are frozen values', () => {
  const router = new Router(shopTopology());
  const result = router.route({ exchange: 'ingress', routingKey: DIAMOND_KEY });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.targets));
  assert.ok(Object.isFrozen(result.targets[0].bindingPath));
});

test('tie-break by binding-id sequence does not depend on declaration order', () => {
  const bindings = [
    { id: 'b10', source: 'entry', destination: 'x1', destinationKind: 'exchange' as const },
    { id: 'b09', source: 'entry', destination: 'x2', destinationKind: 'exchange' as const },
    { id: 'b21', source: 'x1', destination: 'q', destinationKind: 'queue' as const },
    { id: 'b20', source: 'x2', destination: 'q', destinationKind: 'queue' as const },
  ];
  const exchanges = [
    { name: 'entry', kind: 'fanout' as const },
    { name: 'x1', kind: 'fanout' as const },
    { name: 'x2', kind: 'fanout' as const },
  ];
  const queues = [{ name: 'q' }];

  // Same graph, both declaration orders; both must pick b09,b20.
  for (const order of [bindings, [...bindings].reverse()]) {
    const topology = compileTopology({ exchanges, queues, bindings: order });
    const result = routeOnTopology(topology, { exchange: 'entry' });
    assert.deepEqual(
      result.targets.map((target) => [target.queue, [...target.bindingPath]]),
      [['q', ['b09', 'b20']]],
    );
  }
});

test('routing the same publish repeatedly is deterministic', () => {
  const router = new Router(shopTopology());
  const first = router.route({ exchange: 'ingress', routingKey: DIAMOND_KEY });
  for (let i = 0; i < 25; i++) {
    assert.deepEqual(router.route({ exchange: 'ingress', routingKey: DIAMOND_KEY }), first);
  }
});
