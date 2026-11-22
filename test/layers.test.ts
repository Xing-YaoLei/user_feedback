/**
 * Layer resolution, deletions, nulls, base references and provenance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigEvaluator, deletePath, expr } from '../src/index.ts';
import { missingOf, render, valueOf } from './helpers.ts';

test('layers override by priority, highest first', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'a': 1, 'b': 1 } },
      { id: 'env', values: { 'a': 2, 'b': 2 } },
      { id: 'platform', values: { 'a': 3 } },
    ],
  });
  const result = evaluator.evaluate(['a', 'b', 'c']);
  assert.equal(render(valueOf(result, 'a').value), '1');
  assert.equal(valueOf(result, 'a').layer, 'tenant');
  assert.equal(render(valueOf(result, 'b').value), '1');
  assert.equal(valueOf(result, 'b').layer, 'tenant');
  assert.equal(missingOf(result, 'c').reason, 'absent');
});

test('a deletion hides every lower definition', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'top', values: { 'feature.x': deletePath() } },
      { id: 'mid', values: { 'feature.x': 'mid-value' } },
      { id: 'low', values: { 'feature.x': 'low-value' } },
    ],
  });
  const result = evaluator.evaluate(['feature.x']);
  const missing = missingOf(result, 'feature.x');
  assert.equal(missing.reason, 'deleted');
  assert.equal(missing.definitionLayer, 'top');
});

test('an explicit null is a value, not a deletion', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'top', values: { 'explicit.null': null } },
      { id: 'low', values: { 'explicit.null': 'shadowed' } },
    ],
    expressions: { 'derived': { $ref: 'explicit.null' } },
  });
  const result = evaluator.evaluate(['explicit.null', 'derived']);
  assert.deepEqual(valueOf(result, 'explicit.null').value, { kind: 'null' });
  assert.equal(result.errors.derived, undefined);
  assert.deepEqual(valueOf(result, 'derived').value, { kind: 'null' });
});

test('$base resolves the nearest lower definition of the same path', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'pool': expr({ $add: [{ $base: true }, { $const: 2 }] }) } },
      { id: 'env', values: { 'pool': 8 } },
      { id: 'platform', values: { 'pool': 64 } },
    ],
  });
  const result = evaluator.evaluate(['pool']);
  assert.equal(render(valueOf(result, 'pool').value), '10');
  const definition = valueOf(result, 'pool').definition;
  assert.equal(definition.layer, 'tenant');
  assert.equal(definition.baseLookups.length, 1);
  assert.equal(definition.baseLookups[0]!.layer, 'env');
  assert.equal(definition.baseLookups[0]!.result, 'value');
  assert.deepEqual(definition.refs, [{ path: 'pool', layer: 'env', via: 'base' }]);
});

test('$base chains through several defining layers', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'pool': expr({ $add: [{ $base: true }, { $const: 100 }] }) } },
      { id: 'env', values: { 'pool': expr({ $add: [{ $base: true }, { $const: 10 }] }) } },
      { id: 'platform', values: { 'pool': 1 } },
    ],
  });
  const result = evaluator.evaluate(['pool']);
  assert.equal(render(valueOf(result, 'pool').value), '111');
  assert.deepEqual(
    valueOf(result, 'pool').definition.baseLookups.map((lookup) => [lookup.fromLayer, lookup.layer]),
    [
      ['env', 'platform'],
      ['tenant', 'env'],
    ],
  );
  assert.deepEqual(valueOf(result, 'pool').definition.refs, [
    { path: 'pool', layer: 'env', via: 'base' },
    { path: 'pool', layer: 'platform', via: 'base' },
  ]);
});

test('$base with no lower definition reports missing, not an error', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'only', values: { 'pool': expr({ $base: true }) } }],
  });
  const result = evaluator.evaluate(['pool']);
  assert.equal(missingOf(result, 'pool').reason, 'absent');
});

test('$base stops at a deletion below instead of skipping past it', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'pool': expr({ $exists: { $base: true } }) } },
      { id: 'gate', values: { 'pool': deletePath() } },
      { id: 'env', values: { 'pool': 8 } },
    ],
  });
  const result = evaluator.evaluate(['pool']);
  assert.equal(render(valueOf(result, 'pool').value), 'false');
  const lookups = valueOf(result, 'pool').definition.baseLookups;
  assert.equal(lookups[0]!.result, 'deleted');
});

test('$base accepts an explicit path argument', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'a', values: { 'alias': expr({ $add: [{ $base: { path: 'source' } }, { $const: 1 }] }) } },
      { id: 'b', values: { 'source': 41 } },
    ],
  });
  const result = evaluator.evaluate(['alias']);
  assert.equal(render(valueOf(result, 'alias').value), '42');
  assert.equal(valueOf(result, 'alias').definition.baseLookups[0]!.path, 'source');
});

test('registered expressions default a path that no layer defines', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'base.value': 5 } }],
    expressions: {
      'computed': { $mul: [{ $ref: 'base.value' }, { $const: 3 }] },
    },
  });
  const result = evaluator.evaluate(['computed']);
  assert.equal(render(valueOf(result, 'computed').value), '15');
  assert.equal(valueOf(result, 'computed').layer, '<expression>');
});

test('a registered expression is the computed definition of its path', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'value': 7 } }],
    expressions: { 'value': { $add: [{ $base: true }, { $const: 1 }] } },
  });
  const result = evaluator.evaluate(['value']);
  const outcome = valueOf(result, 'value');
  assert.equal(render(outcome.value), '8');
  assert.equal(outcome.layer, '<expression>');
  // `base` reaches the layer value the expression sits on top of.
  assert.deepEqual(outcome.definition.baseLookups, [
    { path: 'value', fromLayer: '<expression>', layer: 'env', result: 'value' },
  ]);
});

test('a deletion also suppresses a registered expression', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'value': deletePath() } }],
    expressions: { 'value': { $const: 999 } },
  });
  assert.equal(missingOf(evaluator.evaluate(['value']), 'value').reason, 'deleted');
});

test('provenance records layers, dependencies and chains', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'tenant', values: { 'limit': 10 } },
      { id: 'env', values: { 'limit': 20 } },
    ],
    expressions: {
      'doubled': { $mul: [{ $ref: 'limit' }, { $const: 2 }] },
      'final': { $add: [{ $ref: 'doubled' }, { $ctx: 'bump' }] },
    },
    context: { bump: 1, unused: 'ignored' },
  });
  const result = evaluator.evaluate(['final', 'doubled']);
  const final = valueOf(result, 'final');
  assert.equal(final.layer, '<expression>');
  assert.equal(final.definition.path, 'final');
  assert.equal(final.definition.kind, 'expression');
  assert.deepEqual(final.definition.contextKeys, ['bump']);
  assert.deepEqual(final.definition.referencedPaths, ['doubled', 'limit']);
  assert.deepEqual(final.definition.refs, [
    { path: 'doubled', layer: '<expression>', via: 'ref' },
    { path: 'limit', layer: 'tenant', via: 'ref' },
  ]);
  assert.ok(final.definition.dependencies.includes('ctx:bump'));
  assert.equal(final.definition.evaluatedAtRevision, result.revision);
});

test('layerIndex points at the caller layer array', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'top', values: {} },
      { id: 'middle', values: { 'x': 1 } },
      { id: 'bottom', values: { 'x': 2 } },
    ],
  });
  const result = evaluator.evaluate(['x']);
  assert.equal(valueOf(result, 'x').definition.layerIndex, 1);
  assert.equal(valueOf(result, 'x').definition.kind, 'layer');
});
