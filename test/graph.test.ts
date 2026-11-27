import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileTopology, routeOnTopology, traverseNormal, parseRoutingKey } from '../src/index.ts';

/**
 * Build a layered, highly connected topology: `width` exchanges per layer,
 * every exchange binding to every exchange in the next layer, and each one
 * also binding to the previous layer (criss-crossing back edges).
 */
function layeredTopology(layers: number, width: number) {
  const exchanges = [];
  const bindings = [];
  for (let layer = 0; layer < layers; layer++) {
    for (let index = 0; index < width; index++) {
      exchanges.push({ name: `e${layer}-${index}`, kind: 'fanout' as const });
    }
  }
  let counter = 0;
  const id = () => `b${String(counter++).padStart(5, '0')}`;
  for (let layer = 0; layer < layers; layer++) {
    for (let index = 0; index < width; index++) {
      for (let other = 0; other < width; other++) {
        if (layer + 1 < layers) {
          bindings.push({
            id: id(),
            source: `e${layer}-${index}`,
            destination: `e${layer + 1}-${other}`,
            destinationKind: 'exchange' as const,
          });
        }
        if (layer > 0) {
          // Back edge to the previous layer: creates many normal cycles.
          bindings.push({
            id: id(),
            source: `e${layer}-${index}`,
            destination: `e${layer - 1}-${other}`,
            destinationKind: 'exchange' as const,
          });
        }
      }
      bindings.push({
        id: id(),
        source: `e${layer}-${index}`,
        destination: `q${layer}-${index}`,
        destinationKind: 'queue' as const,
      });
    }
  }
  const queues = [];
  for (let layer = 0; layer < layers; layer++) {
    for (let index = 0; index < width; index++) queues.push({ name: `q${layer}-${index}` });
  }
  return { exchanges, queues, bindings };
}

test('dense cyclic graphs stay linear in bindings, not exponential in paths', () => {
  const layers = 6;
  const width = 5;
  const input = layeredTopology(layers, width);
  const topology = compileTopology(input);

  const started = performance.now();
  const traversal = traverseNormal(topology, 'e0-0', parseRoutingKey(''));
  const elapsed = performance.now() - started;

  // Every exchange is expanded at most once; with width^2 edges per layer the
  // number of path expansions would be astronomically larger for a matcher
  // that enumerated paths.
  assert.ok(
    traversal.stats.exchangesExpanded <= topology.exchanges.size,
    `expanded ${traversal.stats.exchangesExpanded} > ${topology.exchanges.size}`,
  );
  assert.ok(
    traversal.stats.bindingsEvaluated <= topology.bindings.length,
    `evaluated ${traversal.stats.bindingsEvaluated} bindings; topology has ${topology.bindings.length}`,
  );
  assert.equal(traversal.queues.size, layers * width);
  assert.ok(elapsed < 250, `dense traversal took ${elapsed.toFixed(1)}ms`);
});

test('many diamond merges yield one target per queue with a shortest path', () => {
  // Three parallel branches of length 1, 2 and 3 all meet at `merge`.
  const topology = compileTopology({
    exchanges: [
      { name: 'entry', kind: 'fanout' },
      { name: 'long1', kind: 'fanout' },
      { name: 'long2', kind: 'fanout' },
      { name: 'merge', kind: 'fanout' },
    ],
    queues: [{ name: 'q' }],
    bindings: [
      { id: 'c-short', source: 'entry', destination: 'merge', destinationKind: 'exchange' },
      { id: 'a-long1', source: 'entry', destination: 'long1', destinationKind: 'exchange' },
      { id: 'b-long1', source: 'long1', destination: 'merge', destinationKind: 'exchange' },
      { id: 'b-long2', source: 'long2', destination: 'merge', destinationKind: 'exchange' },
      { id: 'd-long2', source: 'long1', destination: 'long2', destinationKind: 'exchange' },
      { id: 'e-q', source: 'merge', destination: 'q', destinationKind: 'queue' },
    ],
  });
  const result = routeOnTopology(topology, { exchange: 'entry' });
  assert.deepEqual(
    result.targets.map((target) => ({ queue: target.queue, bindingPath: [...target.bindingPath] })),
    [{ queue: 'q', bindingPath: ['c-short', 'e-q'] }],
  );
});

test('consecutive # patterns across a deep chain do not expand paths', () => {
  // A long chain of topic exchanges, each bound with a `#.#.#` style pattern,
  // forms exponentially many matching characterisations per route. Only the
  // binding set matters, so traversal must stay linear.
  const depth = 40;
  const exchanges = [{ name: 'root', kind: 'topic' as const }];
  const bindings = [];
  for (let i = 0; i < depth; i++) {
    exchanges.push({ name: `n${i}`, kind: 'topic' });
    bindings.push({
      id: `edge-${String(i).padStart(3, '0')}`,
      source: i === 0 ? 'root' : `n${i - 1}`,
      destination: `n${i}`,
      destinationKind: 'exchange' as const,
      routingKey: '#.#.#',
    });
    // Back edge to the root, matching the same pattern.
    bindings.push({
      id: `back-${String(i).padStart(3, '0')}`,
      source: `n${i}`,
      destination: 'root',
      destinationKind: 'exchange' as const,
      routingKey: '#.#',
    });
  }
  bindings.push({
    id: 'zzz-sink',
    source: `n${depth - 1}`,
    destination: 'sink',
    destinationKind: 'queue' as const,
    routingKey: '#',
  });
  const topology = compileTopology({
    exchanges,
    queues: [{ name: 'sink' }],
    bindings,
  });

  const started = performance.now();
  const result = routeOnTopology(topology, { exchange: 'root', routingKey: 'a.b.c.d' });
  const elapsed = performance.now() - started;

  assert.equal(result.routable, true);
  assert.deepEqual(result.targets.map((target) => target.queue), ['sink']);
  assert.ok(elapsed < 250, `deep wildcard chain took ${elapsed.toFixed(1)}ms`);
});

test('a queue bound many times from the same exchange is returned once', () => {
  const bindings = [];
  for (let i = 0; i < 100; i++) {
    bindings.push({
      id: `b${String(i).padStart(3, '0')}`,
      source: 'hot',
      destination: 'q',
      destinationKind: 'queue' as const,
      routingKey: 'k',
    });
  }
  const topology = compileTopology({
    exchanges: [{ name: 'hot', kind: 'topic' }],
    queues: [{ name: 'q' }],
    bindings,
  });
  const result = routeOnTopology(topology, { exchange: 'hot', routingKey: 'k' });
  assert.equal(result.targets.length, 1);
  assert.deepEqual([...result.targets[0].bindingPath], ['b000']);
});
