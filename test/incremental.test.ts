/**
 * Dependency-driven caching, incremental recomputation, revision pinning and
 * interleaved-update behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigEvaluator, deletePath, expr } from '../src/index.ts';
import { render, valueOf } from './helpers.ts';

test('repeated batches reuse every unaffected node', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1, 'b': 2 } }],
    expressions: {
      'sum': { $add: [{ $ref: 'a' }, { $ref: 'b' }] },
      'doubled': { $mul: [{ $ref: 'sum' }, { $const: 2 }] },
    },
  });
  evaluator.evaluate(['doubled', 'sum', 'a']);
  evaluator.resetStats();
  const again = evaluator.evaluate(['doubled', 'sum', 'a']);
  assert.equal(render(valueOf(again, 'doubled').value), '6');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {});
  assert.deepEqual(evaluator.getStats().hitsByPath, { a: 1, doubled: 1, sum: 1 });
});

test('an unrelated layer change forces no recomputation', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1, 'noise': 'x' } }],
    expressions: {
      'doubled': { $mul: [{ $ref: 'a' }, { $const: 2 }] },
    },
  });
  evaluator.evaluate(['doubled']);
  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'l', path: 'noise', value: 'y' });
  const result = evaluator.evaluate(['doubled']);
  assert.equal(render(valueOf(result, 'doubled').value), '2');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {});
});

test('an unread context field does not invalidate results', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'limit': 10 } }],
    expressions: {
      'effective': {
        $if: [{ $eq: [{ $ctx: 'region' }, { $const: 'eu' }] }, { $const: 20 }, { $ref: 'limit' }],
      },
    },
    context: { region: 'eu', deployment: 'blue' },
  });
  evaluator.evaluate(['effective']);
  evaluator.resetStats();
  evaluator.setContext({ region: 'eu', deployment: 'green' });
  const result = evaluator.evaluate(['effective']);
  assert.equal(render(valueOf(result, 'effective').value), '20');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {});
});

test('a read context change recomputes only its dependents', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'limit': 10 } }],
    expressions: {
      'scaled': { $mul: [{ $ref: 'limit' }, { $ctx: 'factor' }] },
      'derived': { $add: [{ $ref: 'scaled' }, { $const: 1 }] },
      'untouched': { $add: [{ $ref: 'limit' }, { $const: 1 }] },
    },
    context: { factor: 2, other: 0 },
  });
  evaluator.evaluate(['derived', 'untouched']);
  evaluator.resetStats();
  evaluator.setContext({ factor: 3, other: 0 });
  const result = evaluator.evaluate(['derived', 'untouched']);
  assert.equal(render(valueOf(result, 'derived').value), '31');
  assert.equal(render(valueOf(result, 'untouched').value), '11');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { derived: 1, scaled: 1 });
});

test('a change propagates through every transitive dependent', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'root': 1 } }],
    expressions: {
      'level1': { $mul: [{ $ref: 'root' }, { $const: 2 }] },
      'level2': { $add: [{ $ref: 'level1' }, { $const: 3 }] },
      'level3': { $mul: [{ $ref: 'level2' }, { $ref: 'root' }] },
    },
  });
  evaluator.evaluate(['level3']);
  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'l', path: 'root', value: 5 });
  const result = evaluator.evaluate(['level3']);
  assert.equal(render(valueOf(result, 'level3').value), '65');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {
    level1: 1,
    level2: 1,
    level3: 1,
    root: 1,
  });
});

test('a previously missing dependency invalidates its readers when added', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: {} }],
    expressions: {
      'needsB': { $add: [{ $ref: 'b' }, { $const: 1 }] },
      'checksB': { $exists: { $ref: 'b' } },
    },
  });
  const first = evaluator.evaluate(['needsB', 'checksB']);
  assert.equal(first.errors.needsB?.code, 'missing');
  assert.equal(render(valueOf(first, 'checksB').value), 'false');

  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'l', path: 'b', value: 41 });
  const second = evaluator.evaluate(['needsB', 'checksB']);
  assert.equal(render(valueOf(second, 'needsB').value), '42');
  assert.equal(render(valueOf(second, 'checksB').value), 'true');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {
    b: 1,
    checksB: 1,
    needsB: 1,
  });
});

test('a base reference revalidates when the lower definition fills in', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'pool': expr({ $coalesce: [{ $base: true }, { $const: 4 }] }) } },
      { id: 'env', values: {} },
    ],
  });
  assert.equal(render(valueOf(evaluator.evaluate(['pool']), 'pool').value), '4');
  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'env', path: 'pool', value: 40 });
  const result = evaluator.evaluate(['pool']);
  assert.equal(render(valueOf(result, 'pool').value), '40');
  // Two nodes carry the path "pool": the inline expression at the tenant
  // layer, and the base target it reads from the environment layer.
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { pool: 2 });
  assert.deepEqual(valueOf(result, 'pool').definition.baseLookups, [
    { path: 'pool', fromLayer: 'tenant', layer: 'env', result: 'value' },
  ]);
});

test('a restored definition invalidates results computed while it was deleted', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'top', values: { 'c': deletePath() } },
      { id: 'low', values: { 'c': 7 } },
    ],
    expressions: { 'view': { $add: [{ $ref: 'c' }, { $const: 0 }] } },
  });
  assert.equal(evaluator.evaluate(['view']).errors.view?.code, 'missing');

  evaluator.resetStats();
  evaluator.update({ type: 'delete', layer: 'top', path: 'c' });
  const result = evaluator.evaluate(['view']);
  assert.equal(render(valueOf(result, 'view').value), '7');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { c: 1, view: 1 });
});

test('deleting a previously present path invalidates its dependents', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'x': 3 } }],
    expressions: { 'view': { $add: [{ $ref: 'x' }, { $const: 1 }] } },
  });
  assert.equal(render(valueOf(evaluator.evaluate(['view']), 'view').value), '4');
  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'l', path: 'x', value: deletePath() });
  const result = evaluator.evaluate(['view']);
  assert.equal(result.errors.view?.code, 'missing');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { view: 1, x: 1 });
});

test('adding a layer above does not invalidate base-derived values', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'pool': expr({ $add: [{ $base: true }, { $const: 1 }] }) } },
      { id: 'env', values: { 'pool': 10 } },
    ],
  });
  assert.equal(render(valueOf(evaluator.evaluate(['pool']), 'pool').value), '11');
  evaluator.resetStats();
  evaluator.update({ type: 'addLayer', layer: { id: 'region', values: {} }, at: 0 });
  const result = evaluator.evaluate(['pool']);
  assert.equal(render(valueOf(result, 'pool').value), '11');
  // The inline expression is searched from the tenant layer by id, so the
  // insertion of an unrelated layer above leaves both it and its base intact.
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {});
  assert.deepEqual(valueOf(result, 'pool').definition.refs, [
    { path: 'pool', layer: 'env', via: 'base' },
  ]);
});

test('removing a shadowing layer falls back and recomputes', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'a': 1 } },
      { id: 'env', values: { 'a': 2 } },
    ],
  });
  assert.equal(render(valueOf(evaluator.evaluate(['a']), 'a').value), '1');
  evaluator.resetStats();
  evaluator.update({ type: 'removeLayer', layer: 'tenant' });
  const result = evaluator.evaluate(['a']);
  assert.equal(render(valueOf(result, 'a').value), '2');
  assert.equal(valueOf(result, 'a').layer, 'env');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { a: 1 });
});

test('a batch is pinned to one revision despite interleaved updates', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 1 } }],
    expressions: { 'n2': { $mul: [{ $ref: 'n' }, { $const: 2 }] } },
  });
  const batch = evaluator.beginBatch();
  assert.equal(batch.revision, 1);
  assert.equal(render(batch.evaluate(['n2']).values['n2']!.value), '2');

  evaluator.update({ type: 'set', layer: 'l', path: 'n', value: 10 });

  // The open batch keeps its pinned stack and revision.
  const pinned = batch.evaluate(['n2']);
  assert.equal(pinned.revision, 1);
  assert.equal(render(pinned.values['n2']!.value), '2');
  assert.equal(pinned.values['n2']!.definition.evaluatedAtRevision, 1);

  // A fresh batch sees the update.
  const fresh = evaluator.evaluate(['n2']);
  assert.equal(fresh.revision, 2);
  assert.equal(render(fresh.values['n2']!.value), '20');
  assert.equal(fresh.values['n2']!.definition.evaluatedAtRevision, 2);
});

test('every root in a batch is interpreted against the same revision', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1 } }],
    expressions: {
      'aView': { $ref: 'a' },
      'aDouble': { $mul: [{ $ref: 'a' }, { $const: 2 }] },
    },
  });
  const batch = evaluator.beginBatch();
  // Mutate between resolving individual roots of the same batch.
  const first = batch.evaluate(['aView']);
  evaluator.update({ type: 'set', layer: 'l', path: 'a', value: 100 });
  const second = batch.evaluate(['aDouble', 'a']);

  assert.equal(render(first.values['aView']!.value), '1');
  assert.equal(render(second.values['aDouble']!.value), '2');
  assert.equal(render(second.values['a']!.value), '1');
  // Branch selection and reference search also saw revision 1 only.
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);
});

test('branch selection inside a pinned batch uses the pinned context', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'eu.limit': 10, 'us.limit': 20 } }],
    expressions: {
      'limit': {
        $if: [
          { $eq: [{ $ctx: 'region' }, { $const: 'eu' }] },
          { $ref: 'eu.limit' },
          { $ref: 'us.limit' },
        ],
      },
    },
    context: { region: 'eu' },
  });
  const batch = evaluator.beginBatch();
  assert.equal(render(batch.evaluate(['limit']).values['limit']!.value), '10');
  evaluator.setContext({ region: 'us' });
  assert.equal(render(batch.evaluate(['limit']).values['limit']!.value), '10');
  assert.equal(render(evaluator.evaluate(['limit']).values['limit']!.value), '20');
});

test('type errors are also interpreted against the pinned revision', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1, 'b': 'text' } }],
    expressions: { 'sum': { $add: [{ $ref: 'a' }, { $ref: 'b' }] } },
  });
  const batch = evaluator.beginBatch();
  assert.equal(batch.evaluate(['sum']).errors['sum']?.code, 'type_mismatch');

  // Repairing the operand mid-batch must not change the pinned answer.
  evaluator.update({ type: 'set', layer: 'l', path: 'b', value: 2 });
  const pinned = batch.evaluate(['sum']);
  assert.equal(pinned.revision, 1);
  assert.equal(pinned.errors['sum']?.code, 'type_mismatch');
  assert.equal(pinned.errors['sum']?.source, 'b');
  assert.equal(pinned.errors['sum']?.revision, 1);

  // A fresh batch sees the repair.
  const fresh = evaluator.evaluate(['sum']);
  assert.equal(render(valueOf(fresh, 'sum').value), '3');
  assert.equal(fresh.revision, 2);
});

test('a failed update leaves the evaluator unchanged', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 1 } }],
    expressions: { 'n2': { $mul: [{ $ref: 'n' }, { $const: 2 }] } },
  });
  const before = render(valueOf(evaluator.evaluate(['n2']), 'n2').value);
  const revision = evaluator.currentRevision;
  assert.throws(() => evaluator.update({ type: 'set', layer: 'missing', path: 'n', value: 2 }));
  assert.throws(() =>
    evaluator.update({ type: 'addLayer', layer: { id: 'l', values: {} }, at: 0 }),
  );
  const after = render(valueOf(evaluator.evaluate(['n2']), 'n2').value);
  assert.equal(after, before);
  assert.equal(evaluator.currentRevision, revision);
});

test('a failed update does not leave a half-applied layer', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 1 } }],
  });
  assert.throws(() =>
    evaluator.update({ type: 'set', layer: 'l', path: 'bad', value: undefined as never }),
  );
  const result = evaluator.evaluate(['n', 'bad']);
  assert.equal(render(valueOf(result, 'n').value), '1');
  assert.equal(result.outcomes.bad && 'missing' in result.outcomes.bad, true);
});

test('withLayerUpdate returns an independent evaluator', () => {
  const base = createConfigEvaluator({ layers: [{ id: 'l', values: { 'n': 1 } }] });
  assert.equal(render(valueOf(base.evaluate(['n']), 'n').value), '1');
  const next = base.withLayerUpdate({ type: 'set', layer: 'l', path: 'n', value: 9 });
  assert.equal(render(valueOf(next.evaluate(['n']), 'n').value), '9');
  assert.equal(render(valueOf(base.evaluate(['n']), 'n').value), '1');
  assert.notEqual(base.currentRevision, next.currentRevision);
  // Statistics are carried over as a copy, not shared.
  const baseEvaluations = base.getStats().evaluations;
  const nextEvaluations = next.getStats().evaluations;
  next.evaluate(['n']);
  assert.equal(next.getStats().evaluations, nextEvaluations + 1);
  assert.equal(base.getStats().evaluations, baseEvaluations);
  base.evaluate(['n']);
  assert.equal(next.getStats().evaluations, nextEvaluations + 1);
});

test('interleaved failures do not poison the cache for later revisions', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1, 'b': 'text' } }],
    expressions: {
      'sum': { $add: [{ $ref: 'a' }, { $ref: 'b' }] },
    },
  });
  assert.equal(evaluator.evaluate(['sum']).errors.sum?.code, 'type_mismatch');
  evaluator.update({ type: 'set', layer: 'l', path: 'b', value: 2 });
  const fixed = evaluator.evaluate(['sum']);
  assert.equal(render(valueOf(fixed, 'sum').value), '3');
  // And back to failing again.
  evaluator.update({ type: 'set', layer: 'l', path: 'b', value: 'text' });
  assert.equal(evaluator.evaluate(['sum']).errors.sum?.code, 'type_mismatch');
});

test('stats track root hits and misses separately', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 1 } }],
    expressions: { 'a2': { $mul: [{ $ref: 'a' }, { $const: 2 }] } },
  });
  evaluator.evaluate(['a2', 'a']);
  const first = evaluator.getStats();
  assert.equal(first.cacheMisses, 2);
  assert.equal(first.cacheHits, 0);
  assert.equal(first.batches, 1);

  evaluator.evaluate(['a2', 'a']);
  const second = evaluator.getStats();
  assert.equal(second.cacheHits, 2);
  assert.equal(second.cacheMisses, 2);
  assert.equal(second.batches, 2);
  assert.equal(second.hitsByPath.a2, 1);
  assert.equal(second.hitsByPath.a, 1);
});
