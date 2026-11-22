/**
 * Acceptance scenarios, named after the behaviours the specification calls out.
 *
 *   base overrides            `$base` reading the value an expression replaced
 *   cycles in unselected      an unreachable branch never fails a result
 *   cross-tenant switching    switching tenant reuses the non-selected branch
 *   sibling unit conversions  `1GiB` vs `1024MiB` across sibling paths
 *   missing then filled       cached absence is invalidated when a value lands
 *
 * Each test asserts both the value and the recomputation counter, so "the
 * result is right" and "only what had to move moved" are checked together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigEvaluator, expr } from '../src/index.ts';
import { errorOf, missingOf, render, valueOf } from './helpers.ts';

test('acceptance: $base overrides compute on the replaced value', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'replicas': expr({ $add: [{ $base: true }, { $const: 2 }] }) } },
      { id: 'env', values: { 'replicas': 3 } },
      { id: 'platform', values: { 'replicas': 100 } },
    ],
  });
  const plate = evaluator.evaluate(['replicas']);
  assert.equal(render(valueOf(plate, 'replicas').value), '5');
  assert.equal(valueOf(plate, 'replicas').layer, 'tenant');
  assert.deepEqual(valueOf(plate, 'replicas').definition.baseLookups, [
    { path: 'replicas', fromLayer: 'tenant', layer: 'env', result: 'value' },
  ]);

  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'tenant', path: 'replicas', value: expr({ $mul: [{ $base: true }, { $const: 10 }] }) });
  const multiplied = evaluator.evaluate(['replicas']);
  assert.equal(render(valueOf(multiplied, 'replicas').value), '30');
  // Only the tenant expression recomputes; the environment value it reads via
  // `base` is unchanged, so that node is reused.
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { replicas: 1 });
});

test('acceptance: a cycle in an unselected branch never fails, and only then surfaces', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'canary': false, 'stable': 42 } }],
    expressions: {
      'loop.a': { $ref: 'loop.b' },
      'loop.b': { $ref: 'loop.a' },
      'effective': {
        $if: [{ $ref: 'canary' }, { $ref: 'loop.a' }, { $ref: 'stable' }],
      },
    },
  });
  const before = evaluator.evaluate(['effective']);
  assert.equal(render(valueOf(before, 'effective').value), '42');
  assert.deepEqual(valueOf(before, 'effective').definition.referencedPaths, ['canary', 'stable']);
  assert.equal(evaluator.getStats().recomputationsByPath['loop.a'], undefined);

  evaluator.update({ type: 'set', layer: 'env', path: 'canary', value: true });
  const after = evaluator.evaluate(['effective']);
  assert.equal(errorOf(after, 'effective').code, 'cycle');
});

test('acceptance: cross-tenant switching keeps each tenant cacheable', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant-a', values: { 'a.quota': 10 } },
      { id: 'tenant-b', values: { 'b.quota': 20 } },
    ],
    expressions: {
      'quota': {
        $if: [
          { $eq: [{ $ctx: 'tenant' }, { $const: 'a' }] },
          { $ref: 'a.quota' },
          { $ref: 'b.quota' },
        ],
      },
      'reserve': { $div: [{ $ref: 'quota' }, { $const: 4 }] },
    },
    context: { tenant: 'a' },
  });

  const tenantA = evaluator.evaluate(['quota', 'reserve']);
  assert.equal(render(valueOf(tenantA, 'quota').value), '10');
  assert.equal(render(valueOf(tenantA, 'reserve').value), '2.5');

  evaluator.setContext({ tenant: 'b' });
  const tenantB = evaluator.evaluate(['quota', 'reserve']);
  assert.equal(render(valueOf(tenantB, 'quota').value), '20');
  assert.equal(render(valueOf(tenantB, 'reserve').value), '5');

  // Switching back reuses the first tenant's branch without recomputing it
  // from scratch and without reading the other tenant's value.
  evaluator.resetStats();
  evaluator.setContext({ tenant: 'a' });
  const back = evaluator.evaluate(['quota', 'reserve']);
  assert.equal(render(valueOf(back, 'quota').value), '10');
  assert.deepEqual(valueOf(back, 'quota').definition.referencedPaths, ['a.quota']);
  assert.equal(evaluator.getStats().recomputationsByPath['a.quota'], undefined);
});

test('acceptance: sibling unit conversions are exact and dimension-safe', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      {
        id: 'env',
        values: {
          'a.cache': '1GiB',
          'a.staging': '1024MiB',
          'a.limit': '1s',
          'a.window': '1500ms',
        },
      },
    ],
    expressions: {
      'sameSize': { $eq: [{ $ref: 'a.cache' }, { $ref: 'a.staging' }] },
      'delta': { $sub: [{ $ref: 'a.cache' }, { $ref: 'a.staging' }] },
      'timeDelta': { $sub: [{ $ref: 'a.window' }, { $ref: 'a.limit' }] },
      'crossDimension': { $sub: [{ $ref: 'a.cache' }, { $ref: 'a.limit' }] },
    },
  });
  const result = evaluator.evaluate(['sameSize', 'delta', 'timeDelta', 'crossDimension']);
  assert.equal(render(valueOf(result, 'sameSize').value), 'true');
  assert.equal(render(valueOf(result, 'delta').value), '0gib');
  // `$sub` keeps the left operand's unit: 1500ms - 1s = 500ms.
  assert.equal(render(valueOf(result, 'timeDelta').value), '500ms');
  const error = errorOf(result, 'crossDimension');
  assert.equal(error.code, 'unit_mismatch');
  assert.deepEqual(error.sources, ['a.cache', 'a.limit']);
});

test('acceptance: missing-then-filled invalidates only dependents of that path', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'static': 1 } }],
    expressions: {
      'optional': { $coalesce: [{ $ref: 'late.value' }, { $const: -1 }] },
      'strict': { $add: [{ $ref: 'late.value' }, { $const: 0 }] },
      'staticView': { $add: [{ $ref: 'static' }, { $const: 1 }] },
    },
  });

  const first = evaluator.evaluate(['optional', 'strict', 'staticView']);
  assert.equal(render(valueOf(first, 'optional').value), '-1');
  assert.equal(missingOf(evaluator.evaluate(['late.value']), 'late.value').reason, 'absent');
  assert.equal(errorOf(first, 'strict').code, 'missing');

  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'env', path: 'late.value', value: 7 });
  const second = evaluator.evaluate(['optional', 'strict', 'staticView']);
  assert.equal(render(valueOf(second, 'optional').value), '7');
  assert.equal(render(valueOf(second, 'strict').value), '7');
  assert.equal(render(valueOf(second, 'staticView').value), '2');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {
    'late.value': 1,
    optional: 1,
    strict: 1,
  });
});
