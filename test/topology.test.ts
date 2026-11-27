import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RouterError, compileTopology } from '../src/index.ts';
import { shopTopology } from './fixtures.ts';

test('topology: valid fixture compiles and indexes bindings by source', () => {
  const topology = compileTopology(shopTopology());
  assert.equal(topology.exchanges.size, 14);
  assert.equal(topology.queueNames.size, 6);
  assert.equal(topology.bindings.length, 13);
  const ingress = topology.bindingsBySource.get('ingress');
  assert.ok(ingress);
  assert.deepEqual(ingress.map((binding) => binding.id), ['b01']);
});

test('topology: rejects unknown exchanges, queues and alternates', () => {
  const cases = [
    {
      name: 'binding source',
      input: {
        exchanges: [{ name: 'e', kind: 'direct' as const }],
        queues: [{ name: 'q' }],
        bindings: [{ id: 'b', source: 'nope', destination: 'q', destinationKind: 'queue' as const }],
      },
      match: /unknown source exchange/,
    },
    {
      name: 'binding queue',
      input: {
        exchanges: [{ name: 'e', kind: 'direct' as const }],
        bindings: [{ id: 'b', source: 'e', destination: 'q', destinationKind: 'queue' as const }],
      },
      match: /unknown destination queue/,
    },
    {
      name: 'binding exchange',
      input: {
        exchanges: [{ name: 'e', kind: 'direct' as const }],
        bindings: [{ id: 'b', source: 'e', destination: 'x', destinationKind: 'exchange' as const }],
      },
      match: /unknown destination exchange/,
    },
    {
      name: 'alternate',
      input: { exchanges: [{ name: 'e', kind: 'fanout' as const, alternateExchange: 'gone' }] },
      match: /unknown alternate/,
    },
  ];
  for (const testCase of cases) {
    assert.throws(
      () => compileTopology(testCase.input),
      (error: unknown) => {
        assert.ok(error instanceof RouterError, `${testCase.name}: wrong error type`);
        assert.equal(error.code, 'INVALID_TOPOLOGY');
        assert.match(error.message, testCase.match);
        return true;
      },
      testCase.name,
    );
  }
});

test('topology: rejects duplicates and malformed names', () => {
  assert.throws(
    () =>
      compileTopology({
        exchanges: [
          { name: 'e', kind: 'direct' },
          { name: 'e', kind: 'topic' },
        ],
      }),
    /duplicate exchange/,
  );
  assert.throws(() => compileTopology({ queues: [{ name: 'q' }, { name: 'q' }] }), /duplicate queue/);
  assert.throws(
    () =>
      compileTopology({
        exchanges: [{ name: 'e', kind: 'fanout' }],
        queues: [{ name: 'q' }],
        bindings: [
          { id: 'b', source: 'e', destination: 'q', destinationKind: 'queue' },
          { id: 'b', source: 'e', destination: 'q', destinationKind: 'queue' },
        ],
      }),
    /duplicate binding id/,
  );
  assert.throws(() => compileTopology({ exchanges: [{ name: '', kind: 'fanout' }] }), /non-empty/);
  assert.throws(
    () => compileTopology({ exchanges: [{ name: 'e', kind: 'bogus' as never }] }),
    /invalid kind/,
  );
});

test('topology: validates patterns only on topic sources', () => {
  // A `#` is literal text on a direct exchange, so this is fine.
  const direct = compileTopology({
    exchanges: [{ name: 'd', kind: 'direct' }],
    queues: [{ name: 'q' }],
    bindings: [{ id: 'b', source: 'd', destination: 'q', destinationKind: 'queue', routingKey: 'a.#' }],
  });
  assert.equal(direct.bindings[0].routingKey, 'a.#');

  // The same key is an invalid pattern on a topic exchange.
  assert.throws(
    () =>
      compileTopology({
        exchanges: [{ name: 't', kind: 'topic' }],
        queues: [{ name: 'q' }],
        bindings: [
          { id: 'b', source: 't', destination: 'q', destinationKind: 'queue', routingKey: 'a..#' },
        ],
      }),
    /empty segment/,
  );
});

test('topology: destination kind is inferred when unambiguous', () => {
  const topology = compileTopology({
    exchanges: [{ name: 'e', kind: 'fanout' }],
    queues: [{ name: 'q' }],
    bindings: [{ id: 'b', source: 'e', destination: 'q' }],
  });
  assert.equal(topology.bindings[0].destinationKind, 'queue');
});

test('topology: destination kind is required when a name is ambiguous', () => {
  assert.throws(
    () =>
      compileTopology({
        exchanges: [{ name: 'same', kind: 'fanout' }],
        queues: [{ name: 'same' }],
        bindings: [{ id: 'b', source: 'same', destination: 'same' }],
      }),
    /both a queue and an exchange/,
  );
});

test('topology: snapshot is immutable and independent of its input', () => {
  const input = shopTopology();
  const topology = compileTopology(input);
  assert.ok(Object.isFrozen(topology));
  assert.ok(Object.isFrozen(topology.bindings));
  assert.ok(Object.isFrozen(topology.bindingsBySource.get('ingress')));

  // Mutating the caller's arrays must not affect the compiled snapshot.
  (input.bindings as unknown as unknown[]).push({
    id: 'zz',
    source: 'ingress',
    destination: 'q-orphan',
    destinationKind: 'queue',
  });
  assert.equal(topology.bindings.length, 13);
});
