/**
 * Runnable walkthrough: load a local topology from JSON, print routing
 * results for a few keys, then add one ordinary binding and show the same
 * message immediately stop using the alternate chain.
 *
 *   npm run example
 *
 * Exits non-zero if any expected outcome from the scenario table is wrong.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router, compileTopology } from '../src/index.ts';
import type { TopologyInput } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const topologyPath = join(here, 'topology.json');

function load(): TopologyInput {
  const raw = readFileSync(topologyPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  assert.ok(parsed !== null && typeof parsed === 'object', 'topology.json must hold an object');
  return parsed as TopologyInput;
}

function describe(label: string, result: ReturnType<Router['route']>): void {
  const targets = result.targets
    .map((target) => `${target.queue} <= [${target.bindingPath.join(' -> ')}]`)
    .join(', ');
  const hops = result.alternates
    .map((hop) => `${hop.exchange} => ${hop.alternateExchange}`)
    .join(', ');
  console.log(`\n${label}`);
  console.log(`  routable     : ${result.routable}`);
  if (result.resolvedFrom) console.log(`  resolvedFrom : ${result.resolvedFrom}`);
  console.log(`  alternates   : ${hops || '(none)'}`);
  console.log(`  targets      : ${targets || '(none)'}`);
  if (result.alternateCycle) {
    console.log(`  alt cycle    : ${result.alternateCycle.exchanges.join(' -> ')}`);
  }
}

const input = load();
const snapshot = compileTopology(input);
console.log(
  `topology: ${snapshot.exchanges.size} exchanges, ${snapshot.queueNames.size} queues, ` +
    `${snapshot.bindings.length} bindings`,
);

const router = new Router(snapshot);

// 1. Diamond merge with a normal cycle: q-left appears once, via its shortest
//    path; the downstream shadow alternate is never consulted.
const diamond = router.route({ exchange: 'ingress', routingKey: 'order.created' });
describe('order.created (diamond + normal cycle)', diamond);
assert.deepEqual(
  diamond.targets.map((target) => [target.queue, [...target.bindingPath]]),
  [
    ['q-left', ['b01', 'b02', 'b04']],
    ['q-right', ['b01', 'b03', 'b05']],
  ],
);

// 2. No normal destination anywhere in the graph -> entry alternate fires.
const orphan = router.route({ exchange: 'ingress', routingKey: 'orphan.key' });
describe('orphan.key (alternate fallback)', orphan);
assert.deepEqual(orphan.alternates, [{ exchange: 'ingress', alternateExchange: 'dlx-entry' }]);
assert.deepEqual(orphan.targets.map((target) => target.queue), ['q-dead']);

// 3. A multi-hop alternate chain advances one exchange at a time.
describe('chain-a (alternate chain)', router.route({ exchange: 'chain-a', routingKey: 'x' }));

// 4. An alternate cycle is reported rather than looping forever.
const cycle = router.route({ exchange: 'alt-a', routingKey: 'x' });
describe('alt-a (alternate cycle)', cycle);
assert.equal(cycle.routable, false);
assert.deepEqual(cycle.alternateCycle, {
  reason: 'alternate-cycle',
  exchanges: ['alt-a', 'alt-b', 'alt-a'],
});

// 5. Route the same message, then add one ordinary binding for it. The very
//    next route must go direct and skip the alternate chain entirely.
console.log('\n--- add one normal binding for orphan.# and re-route ---');
router.replaceTopology({
  ...input,
  bindings: [
    ...(input.bindings ?? []),
    { id: 'b20', source: 'ingress', destination: 'q-orphan', destinationKind: 'queue', routingKey: 'orphan.#' },
  ],
});

const after = router.route({ exchange: 'ingress', routingKey: 'orphan.key' });
describe('orphan.key (after adding b20)', after);
assert.deepEqual(after.alternates, []);
assert.equal(after.resolvedFrom, 'ingress');
assert.deepEqual(
  after.targets.map((target) => [target.queue, [...target.bindingPath]]),
  [['q-orphan', ['b20']]],
);
assert.equal(after.topologyVersion, 1);

console.log('\nAll example expectations held.');
