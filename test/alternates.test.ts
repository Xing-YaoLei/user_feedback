import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileTopology, routeOnTopology } from '../src/index.ts';

/**
 * Build a topology where the entry exchange has an alternate and the alternate
 * itself has a downstream exchange equipped with its own alternate. The
 * downstream alternate must stay dormant even while solving from the
 * alternate root.
 */
function nestedAlternateTopology() {
  return compileTopology({
    exchanges: [
      { name: 'entry', kind: 'direct', alternateExchange: 'alt-root' },
      { name: 'alt-root', kind: 'fanout' },
      { name: 'alt-down', kind: 'fanout', alternateExchange: 'wrong-alt' },
      { name: 'wrong-alt', kind: 'fanout' },
      { name: 'alt-queue-root', kind: 'fanout' },
    ],
    queues: [{ name: 'q-wrong' }, { name: 'q-alt' }],
    bindings: [
      // alt-root -> alt-down, and alt-down -> nothing. If a downstream
      // alternate were honoured, q-wrong would be reached via wrong-alt.
      { id: 'a1', source: 'alt-root', destination: 'alt-down', destinationKind: 'exchange' },
      { id: 'a2', source: 'wrong-alt', destination: 'q-wrong', destinationKind: 'queue' },
      // A second alternate root reachable only by a chain step.
      { id: 'a3', source: 'alt-queue-root', destination: 'q-alt', destinationKind: 'queue' },
    ],
  });
}

test('downstream alternates stay dormant while solving from an alternate root', () => {
  const topology = nestedAlternateTopology();
  // Nothing in this topology can deliver: entry has no bindings, alt-root only
  // reaches an exchange graph with no queues, and neither alternate can fire
  // (alt-root has none; alt-down's is downstream). So unroutable, with no
  // q-wrong leak and exactly one hop taken.
  const result = routeOnTopology(topology, { exchange: 'entry', routingKey: 'k' });

  assert.equal(result.routable, false);
  assert.deepEqual(result.alternates, [{ exchange: 'entry', alternateExchange: 'alt-root' }]);
  assert.deepEqual(result.targets, []);
  assert.equal(result.alternateCycle, undefined);
});

test('an empty alternate result keeps walking the alternate chain', () => {
  const topology = compileTopology({
    exchanges: [
      { name: 'entry', kind: 'direct', alternateExchange: 'empty-alt' },
      { name: 'empty-alt', kind: 'fanout', alternateExchange: 'good-alt' },
      { name: 'good-alt', kind: 'fanout' },
    ],
    queues: [{ name: 'q' }],
    bindings: [{ id: 'g1', source: 'good-alt', destination: 'q', destinationKind: 'queue' }],
  });
  const result = routeOnTopology(topology, { exchange: 'entry', routingKey: 'k' });

  assert.equal(result.routable, true);
  assert.equal(result.resolvedFrom, 'good-alt');
  assert.deepEqual(result.alternates, [
    { exchange: 'entry', alternateExchange: 'empty-alt' },
    { exchange: 'empty-alt', alternateExchange: 'good-alt' },
  ]);
  assert.deepEqual(result.targets.map((target) => target.queue), ['q']);
});

test('self-referencing alternate is reported as a one-exchange cycle', () => {
  const topology = compileTopology({
    exchanges: [{ name: 'self', kind: 'fanout', alternateExchange: 'self' }],
    queues: [{ name: 'unused' }],
  });
  const result = routeOnTopology(topology, { exchange: 'self' });
  assert.equal(result.routable, false);
  assert.deepEqual(result.alternateCycle, {
    reason: 'alternate-cycle',
    exchanges: ['self', 'self'],
  });
  assert.deepEqual(result.alternates, []);
});

test('alternate chain is not followed after a direct normal hit', () => {
  const topology = compileTopology({
    exchanges: [
      { name: 'entry', kind: 'fanout', alternateExchange: 'alt' },
      { name: 'alt', kind: 'fanout', alternateExchange: 'alt2' },
      { name: 'alt2', kind: 'fanout' },
    ],
    queues: [{ name: 'q-main' }, { name: 'q-alt' }],
    bindings: [
      { id: 'm1', source: 'entry', destination: 'q-main', destinationKind: 'queue' },
      { id: 'x1', source: 'alt', destination: 'q-alt', destinationKind: 'queue' },
    ],
  });
  const result = routeOnTopology(topology, { exchange: 'entry' });
  assert.equal(result.resolvedFrom, 'entry');
  assert.deepEqual(result.alternates, []);
  assert.deepEqual(result.targets.map((target) => target.queue), ['q-main']);
});

test('alternate solve also traverses exchange-to-exchange bindings', () => {
  const topology = compileTopology({
    exchanges: [
      { name: 'entry', kind: 'fanout', alternateExchange: 'alt-root' },
      { name: 'alt-root', kind: 'fanout' },
      { name: 'alt-mid', kind: 'fanout' },
    ],
    queues: [{ name: 'q-far' }],
    bindings: [
      { id: 'm1', source: 'alt-root', destination: 'alt-mid', destinationKind: 'exchange' },
      { id: 'm2', source: 'alt-mid', destination: 'q-far', destinationKind: 'queue' },
    ],
  });
  const result = routeOnTopology(topology, { exchange: 'entry' });
  assert.equal(result.resolvedFrom, 'alt-root');
  assert.deepEqual(
    result.targets.map((target) => ({ queue: target.queue, bindingPath: [...target.bindingPath] })),
    [{ queue: 'q-far', bindingPath: ['m1', 'm2'] }],
  );
});
