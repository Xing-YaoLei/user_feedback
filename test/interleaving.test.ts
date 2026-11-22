/**
 * Interleaving and crash-style scenarios.
 *
 * The point of these tests is consistency under failure and under concurrent
 * mutation: a batch must behave as if it took a snapshot, a thrown update must
 * leave no partial state behind, and a reused cache entry must never carry a
 * stale dependency chain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigEvaluator,
  createConfigEvaluator,
  deletePath,
  expr,
} from '../src/index.ts';
import { errorOf, missingOf, render, valueOf } from './helpers.ts';

test('many batches interleaved with updates agree with a fresh evaluator', () => {
  const build = () =>
    createConfigEvaluator({
      layers: [
        { id: 'tenant', values: { 'limit': 10, 'flag': true } },
        { id: 'env', values: { 'limit': 20, 'multiplier': 3 } },
      ],
      expressions: {
        'effective': {
          $if: [{ $ref: 'flag' }, { $ref: 'limit' }, { $const: -1 }],
        },
        'total': { $mul: [{ $ref: 'effective' }, { $ref: 'multiplier' }] },
      },
    });

  const incremental = build();
  const updates: Array<(evaluator: ConfigEvaluator) => void> = [
    (evaluator) => evaluator.update({ type: 'set', layer: 'tenant', path: 'limit', value: 11 }),
    (evaluator) => evaluator.update({ type: 'set', layer: 'env', path: 'multiplier', value: 4 }),
    (evaluator) => evaluator.update({ type: 'set', layer: 'tenant', path: 'flag', value: false }),
    (evaluator) => evaluator.update({ type: 'removeLayer', layer: 'tenant' }),
    (evaluator) => evaluator.update({ type: 'addLayer', layer: { id: 'tenant', values: { limit: 99 } }, at: 0 }),
    (evaluator) => evaluator.update({ type: 'set', layer: 'tenant', path: 'limit', value: deletePath() }),
    (evaluator) => evaluator.update({ type: 'delete', layer: 'tenant', path: 'limit' }),
  ];

  for (const apply of updates) {
    apply(incremental);
    const incrementalResult = incremental.evaluate(['effective', 'total']);
    // Replay the same history on a fresh evaluator and compare.
    const replay = build();
    for (const step of updates.slice(0, updates.indexOf(apply) + 1)) step(replay);
    const replayResult = replay.evaluate(['effective', 'total']);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(incrementalResult.outcomes).map(([path, outcome]) => [
          path,
          outcome.ok
            ? render(outcome.result.value)
            : 'missing' in outcome
              ? `missing:${outcome.missing.reason}`
              : `error:${outcome.error.code}:${outcome.error.source}`,
        ]),
      ),
      Object.fromEntries(
        Object.entries(replayResult.outcomes).map(([path, outcome]) => [
          path,
          outcome.ok
            ? render(outcome.result.value)
            : 'missing' in outcome
              ? `missing:${outcome.missing.reason}`
              : `error:${outcome.error.code}:${outcome.error.source}`,
        ]),
      ),
    );
  }
});

test('a crash mid-batch leaves the cache usable and consistent', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1, 'b': 2 } }],
    expressions: {
      'sum': { $add: [{ $ref: 'a' }, { $ref: 'b' }] },
      'double': { $mul: [{ $ref: 'sum' }, { $const: 2 }] },
    },
  });
  const batch = evaluator.beginBatch();
  // Evaluate one root, then "crash" by abandoning the batch object.
  assert.equal(render(batch.evaluate(['sum']).values['sum']!.value), '3');
  // The evaluator never saw a partial transactional state; a fresh batch works.
  const after = evaluator.evaluate(['double']);
  assert.equal(render(valueOf(after, 'double').value), '6');
});

test('an invalid registry entry is rejected at construction, not mid-evaluation', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'x': 2 } }],
    expressions: { 'ok': { $mul: [{ $ref: 'x' }, { $const: 3 }] } },
  });
  // A malformed expression makes construction fail fast, so a bad registry
  // can never surface halfway through a batch.
  assert.throws(() => createConfigEvaluator({
    layers: [{ id: 'l', values: { 'x': 2 } }],
    expressions: { 'bad': null as never },
  }));
  assert.equal(render(valueOf(evaluator.evaluate(['ok']), 'ok').value), '6');
});

test('updates that throw leave the evaluator exactly as it was', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'a', values: { 'v': 1 } },
      { id: 'b', values: { 'v': 2 } },
    ],
    expressions: { 'derived': { $ref: 'v' } },
  });
  const snapshot = JSON.stringify(evaluator.evaluate(['v', 'derived']));
  const revision = evaluator.currentRevision;

  const failing: Array<() => void> = [
    () => evaluator.update({ type: 'set', layer: 'nope', path: 'v', value: 3 }),
    () => evaluator.update({ type: 'delete', layer: 'nope', path: 'v' }),
    () => evaluator.update({ type: 'removeLayer', layer: 'nope' }),
    () => evaluator.update({ type: 'addLayer', layer: { id: 'a', values: {} } }),
    () => evaluator.update({ type: 'addLayer', layer: { id: 'c', values: {} }, at: 99 }),
    () => evaluator.update({ type: 'set', layer: 'a', path: 'bad', value: undefined as never }),
    () => evaluator.update({ type: 'setExpressions', expressions: { 'bad': null as never } }),
    () => evaluator.update({ type: 'unknown' } as never),
  ];

  for (const attempt of failing) {
    assert.throws(attempt);
    assert.equal(evaluator.currentRevision, revision);
  }
  assert.equal(JSON.stringify(evaluator.evaluate(['v', 'derived'])), snapshot);
});

test('a batch opened before an update is unaffected by that update', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 1, 'm': 1 } }],
    expressions: { 'sum': { $add: [{ $ref: 'n' }, { $ref: 'm' }] } },
  });
  const pinned = evaluator.beginBatch();
  evaluator.update({ type: 'set', layer: 'l', path: 'n', value: 50 });
  evaluator.update({ type: 'set', layer: 'l', path: 'm', value: 50 });
  assert.equal(render(pinned.evaluate(['sum']).values['sum']!.value), '2');
  assert.equal(render(evaluator.evaluate(['sum']).values['sum']!.value), '100');
});

test('two open batches at different revisions stay isolated', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 1 } }],
    expressions: { 'square': { $mul: [{ $ref: 'n' }, { $ref: 'n' }] } },
  });
  const first = evaluator.beginBatch();
  evaluator.update({ type: 'set', layer: 'l', path: 'n', value: 4 });
  const second = evaluator.beginBatch();

  assert.equal(render(first.evaluate(['n', 'square']).values['square']!.value), '1');
  assert.equal(render(second.evaluate(['n', 'square']).values['square']!.value), '16');
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
});

test('a reused node reports a chain consistent with its current definition', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'x': expr({ $add: [{ $base: true }, { $const: 1 }] }) } },
      { id: 'env', values: { 'x': 10 } },
    ],
    expressions: { 'x2': { $mul: [{ $ref: 'x' }, { $const: 2 }] } },
  });
  const first = evaluator.evaluate(['x2']);
  assert.equal(render(valueOf(first, 'x2').value), '22');
  assert.deepEqual(valueOf(first, 'x2').definition.refs, [
    { path: 'x', layer: 'tenant', via: 'ref' },
    { path: 'x', layer: 'env', via: 'base' },
  ]);

  // Changing only the base value keeps `x2`'s own definition, but its recorded
  // chain must still describe the current state after reuse.
  evaluator.update({ type: 'set', layer: 'env', path: 'x', value: 21 });
  const second = evaluator.evaluate(['x2']);
  assert.equal(render(valueOf(second, 'x2').value), '44');
  assert.deepEqual(valueOf(second, 'x2').definition.refs, [
    { path: 'x', layer: 'tenant', via: 'ref' },
    { path: 'x', layer: 'env', via: 'base' },
  ]);

  // A later no-op batch reuses everything and reports the same chain.
  evaluator.resetStats();
  const third = evaluator.evaluate(['x2']);
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {});
  assert.deepEqual(valueOf(third, 'x2').definition.refs, [
    { path: 'x', layer: 'tenant', via: 'ref' },
    { path: 'x', layer: 'env', via: 'base' },
  ]);
});

test('a node does not stay cached after a type error is repaired', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1, 'b': 'text' } }],
    expressions: { 'sum': { $add: [{ $ref: 'a' }, { $ref: 'b' }] } },
  });
  assert.equal(errorOf(evaluator.evaluate(['sum']), 'sum').code, 'type_mismatch');
  evaluator.update({ type: 'set', layer: 'l', path: 'b', value: 2 });
  assert.equal(render(valueOf(evaluator.evaluate(['sum']), 'sum').value), '3');
});

test('a cache hit never re-reports an older revision', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1 } }],
    expressions: { 'aView': { $ref: 'a' } },
  });
  evaluator.evaluate(['aView']);
  evaluator.update({ type: 'set', layer: 'l', path: 'b', value: 2 });
  const result = evaluator.evaluate(['aView']);
  assert.equal(result.revision, 2);
  assert.equal(result.values['aView']!.definition.evaluatedAtRevision, 2);
  assert.equal(result.values['aView']!.revision, 2);
});

test('deleting a layer whose value is only reached by base is safe', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'p': expr({ $coalesce: [{ $base: true }, { $const: 0 }] }) } },
      { id: 'env', values: { 'p': 5 } },
    ],
  });
  assert.equal(render(valueOf(evaluator.evaluate(['p']), 'p').value), '5');
  evaluator.update({ type: 'removeLayer', layer: 'env' });
  const result = evaluator.evaluate(['p']);
  assert.equal(render(valueOf(result, 'p').value), '0');
  assert.deepEqual(valueOf(result, 'p').definition.baseLookups, [
    { path: 'p', fromLayer: 'tenant', layer: null, result: 'absent' },
  ]);
});

test('a batch can be evaluated repeatedly without drifting', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 3 } }],
    expressions: { 'sq': { $mul: [{ $ref: 'n' }, { $ref: 'n' }] } },
  });
  const batch = evaluator.beginBatch();
  const runs = [batch.evaluate(['sq']), batch.evaluate(['sq']), batch.evaluate(['sq'])];
  for (const run of runs) assert.equal(render(run.values['sq']!.value), '9');
});

test('concurrent batches sharing a cache do not interfere', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1, 'b': 2 } }],
    expressions: {
      'sum': { $add: [{ $ref: 'a' }, { $ref: 'b' }] },
      'product': { $mul: [{ $ref: 'a' }, { $ref: 'b' }] },
    },
    context: { tag: 'first' },
  });
  const batchA = evaluator.beginBatch();
  const batchB = evaluator.beginBatch({ context: { tag: 'second' } });
  const [resultA, resultB] = [batchA.evaluate(['sum', 'product']), batchB.evaluate(['sum', 'product'])];
  assert.equal(render(resultA.values['sum']!.value), '3');
  assert.equal(render(resultB.values['sum']!.value), '3');
  assert.equal(render(resultA.values['product']!.value), '2');
  assert.equal(render(resultB.values['product']!.value), '2');
});

test('a deleted root, an alias of it, and a consumer of it each report honestly', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'gone': deletePath() } }],
    expressions: {
      'alias': { $ref: 'gone' },
      'consumer': { $add: [{ $ref: 'gone' }, { $const: 1 }] },
    },
  });
  const result = evaluator.evaluate(['gone', 'alias', 'consumer']);
  assert.equal(missingOf(result, 'gone').reason, 'deleted');
  // A pure alias of a removed path is itself removed.
  assert.equal(missingOf(result, 'alias').reason, 'deleted');
  // An expression that needs the value cannot proceed and names the source.
  assert.equal(errorOf(result, 'consumer').code, 'missing');
  assert.equal(errorOf(result, 'consumer').source, 'gone');
});

test('a cycle caused only by a diagnostic view is reported once and recovers', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'real': 5 } }],
    expressions: {
      'a': { $ref: 'b' },
      'b': { $ref: 'a' },
      'view': { $add: [{ $ref: 'real' }, { $const: 1 }] },
    },
  });
  assert.equal(errorOf(evaluator.evaluate(['a']), 'a').code, 'cycle');
  assert.equal(render(valueOf(evaluator.evaluate(['view']), 'view').value), '6');
  // Repairing the registry restores `a`.
  evaluator.update({ type: 'setExpressions', expressions: { 'a': { $ref: 'real' } } });
  assert.equal(render(valueOf(evaluator.evaluate(['a']), 'a').value), '5');
});
