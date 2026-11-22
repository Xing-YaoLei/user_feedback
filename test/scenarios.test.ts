/**
 * End-to-end scenarios that mirror real configuration concerns:
 * base overrides, cycles hidden in unselected branches, cross-tenant
 * switching, sibling unit conversions, and missing-then-filled dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigEvaluator, deletePath, expr } from '../src/index.ts';
import { errorOf, missingOf, render, valueOf } from './helpers.ts';

test('base override: tenant computes on top of the environment value', () => {
  const build = () =>
    createConfigEvaluator({
      layers: [
        {
          id: 'tenant',
          values: {
            'cache.size': expr({ $mul: [{ $base: true }, { $const: 2 }] }),
            'cache.ttl': expr({ $add: [{ $base: true }, { $qty: '30s' }] }),
          },
        },
        {
          id: 'env',
          values: { 'cache.size': '512MiB', 'cache.ttl': '1min' },
        },
        {
          id: 'platform',
          values: { 'cache.size': '1GiB', 'cache.ttl': '5min' },
        },
      ],
    });

  const evaluator = build();
  const first = evaluator.evaluate(['cache.size', 'cache.ttl']);
  // Arithmetic keeps the left operand's unit: 512MiB x 2 = 1024MiB,
  // 1min + 30s = 1.5min.
  assert.equal(render(valueOf(first, 'cache.size').value), '1024mib');
  assert.equal(render(valueOf(first, 'cache.ttl').value), '1.5min');
  // Same amounts, independent of the unit spelling.
  assert.equal(
    render(valueOf(first, 'cache.ttl').value),
    render(valueOf(evaluator.evaluate(['cache.ttl']), 'cache.ttl').value),
  );
  // The higher-priority `platform` values are never consulted.
  assert.deepEqual(
    valueOf(first, 'cache.size').definition.baseLookups.map((lookup) => lookup.layer),
    ['env'],
  );

  // Retuning the environment flows into both derived values.
  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'env', path: 'cache.size', value: '256MiB' });
  const second = evaluator.evaluate(['cache.size', 'cache.ttl']);
  assert.equal(render(valueOf(second, 'cache.size').value), '512mib');
  assert.equal(render(valueOf(second, 'cache.ttl').value), '1.5min');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { 'cache.size': 2 });});

test('a cycle inside an unselected branch never fails the result', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'mode': 'simple', 'limit': 10 } }],
    expressions: {
      'a': { $ref: 'b' },
      'b': { $ref: 'a' },
      'effective': {
        $if: [
          { $eq: [{ $ctx: 'tier' }, { $const: 'premium' }] },
          { $ref: 'a' },
          { $ref: 'limit' },
        ],
      },
      'premiumEffective': {
        $if: [
          { $eq: [{ $ctx: 'tier' }, { $const: 'premium' }] },
          { $ref: 'a' },
          { $const: -1 },
        ],
      },
    },
    context: { tier: 'basic' },
  });
  const basic = evaluator.evaluate(['effective', 'premiumEffective']);
  assert.equal(render(valueOf(basic, 'effective').value), '10');
  assert.equal(render(valueOf(basic, 'premiumEffective').value), '-1');
  assert.deepEqual(valueOf(basic, 'effective').definition.referencedPaths, ['limit']);

  // Switching the tier makes the cyclic branch reachable, and only then
  // does the cycle surface.
  evaluator.setContext({ tier: 'premium' });
  const premium = evaluator.evaluate(['effective', 'premiumEffective']);
  assert.equal(errorOf(premium, 'effective').code, 'cycle');
  assert.equal(errorOf(premium, 'premiumEffective').code, 'cycle');
});

test('cross-tenant switching reuses non-selected tenant values', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      {
        id: 'tenant-acme',
        values: { 'acme.limit': 100, 'acme.region': 'eu', 'acme.tier': 'gold' },
      },
      {
        id: 'tenant-globex',
        values: { 'globex.limit': 5, 'globex.region': 'us', 'globex.tier': 'silver' },
      },
    ],
    expressions: {
      'effective.limit': {
        $if: [
          { $eq: [{ $ctx: 'tenant' }, { $const: 'acme' }] },
          { $ref: 'acme.limit' },
          { $ref: 'globex.limit' },
        ],
      },
      'effective.burst': {
        $mul: [{ $ref: 'effective.limit' }, { $const: 1.5 }],
      },
      'effective.region': {
        $if: [
          { $eq: [{ $ctx: 'tenant' }, { $const: 'acme' }] },
          { $ref: 'acme.region' },
          { $ref: 'globex.region' },
        ],
      },
    },
    context: { tenant: 'acme' },
  });

  const acme = evaluator.evaluate(['effective.limit', 'effective.burst', 'effective.region']);
  assert.equal(render(valueOf(acme, 'effective.limit').value), '100');
  assert.equal(render(valueOf(acme, 'effective.burst').value), '150');
  assert.equal(render(valueOf(acme, 'effective.region').value), 'eu');
  // The globex value was never read.
  assert.deepEqual(valueOf(acme, 'effective.limit').definition.referencedPaths, [
    'acme.limit',
  ]);

  evaluator.resetStats();
  evaluator.setContext({ tenant: 'globex' });
  const globex = evaluator.evaluate(['effective.limit', 'effective.burst', 'effective.region']);
  assert.equal(render(valueOf(globex, 'effective.limit').value), '5');
  assert.equal(render(valueOf(globex, 'effective.burst').value), '7.5');
  assert.equal(render(valueOf(globex, 'effective.region').value), 'us');
  // The three expressions recompute, the acme values stay cached, and the
  // globex values are read for the first time.
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {
    'effective.burst': 1,
    'effective.limit': 1,
    'effective.region': 1,
    'globex.limit': 1,
    'globex.region': 1,
  });

  // Switching back is a cache hit for the expressions, and must not read acme
  // values that are not part of the selected branch.
  evaluator.resetStats();
  evaluator.setContext({ tenant: 'acme' });
  const back = evaluator.evaluate(['effective.limit', 'effective.burst', 'effective.region']);
  assert.equal(render(valueOf(back, 'effective.limit').value), '100');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {
    'effective.burst': 1,
    'effective.limit': 1,
    'effective.region': 1,
  });
});

test('sibling unit conversions preserve exactness and dimensions', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      {
        id: 'env',
        values: {
          'io.readTimeout': '0.5s',
          'io.writeTimeout': '250ms',
          'io.blob': '1MiB',
          'io.window': '1.5GiB',
        },
      },
    ],
    expressions: {
      'io.totalTimeout': { $add: [{ $ref: 'io.readTimeout' }, { $ref: 'io.writeTimeout' }] },
      'io.timeoutsEqual': { $eq: [{ $ref: 'io.readTimeout' }, { $ref: 'io.writeTimeout' }] },
      'io.windowInMib': { $div: [{ $ref: 'io.window' }, { $ref: 'io.blob' }] },
      'io.windowFits': { $lt: [{ $ref: 'io.window' }, { $qty: '1536MiB' }] },
      'io.crossDimension': { $add: [{ $ref: 'io.blob' }, { $ref: 'io.readTimeout' }] },
      'io.third': { $div: [{ $ref: 'io.readTimeout' }, { $const: 3 }] },
      'io.thirdSum': {
        $add: [{ $ref: 'io.third' }, { $ref: 'io.third' }, { $ref: 'io.third' }],
      },
    },
  });

  const result = evaluator.evaluate([
    'io.totalTimeout',
    'io.timeoutsEqual',
    'io.windowInMib',
    'io.windowFits',
    'io.crossDimension',
    'io.third',
    'io.thirdSum',
  ]);

  assert.equal(render(valueOf(result, 'io.totalTimeout').value), '0.75s');
  assert.equal(render(valueOf(result, 'io.timeoutsEqual').value), 'false');
  assert.equal(render(valueOf(result, 'io.windowInMib').value), '1536');
  assert.equal(render(valueOf(result, 'io.windowFits').value), 'false');
  assert.equal(errorOf(result, 'io.crossDimension').code, 'unit_mismatch');
  assert.equal(render(valueOf(result, 'io.third').value), '0.166666666667s');
  assert.equal(render(valueOf(result, 'io.thirdSum').value), '0.5s');
});

test('missing-then-filled dependency recomputes only what it must', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'stable': 10 } }],
    expressions: {
      'primary': { $ref: 'tenant.limit' },
      'fallback': { $coalesce: [{ $ref: 'tenant.limit' }, { $ref: 'stable' }] },
      'doubled': { $mul: [{ $ref: 'primary' }, { $const: 2 }] },
      'unrelated': { $add: [{ $ref: 'stable' }, { $const: 1 }] },
    },
  });

  const before = evaluator.evaluate(['primary', 'fallback', 'doubled', 'unrelated']);
  assert.equal(missingOf(before, 'primary').reason, 'absent');
  assert.equal(errorOf(before, 'doubled').code, 'missing');
  assert.equal(render(valueOf(before, 'fallback').value), '10');
  assert.equal(render(valueOf(before, 'unrelated').value), '11');

  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'env', path: 'tenant.limit', value: 20 });
  const after = evaluator.evaluate(['primary', 'fallback', 'doubled', 'unrelated']);

  assert.equal(render(valueOf(after, 'primary').value), '20');
  assert.equal(render(valueOf(after, 'fallback').value), '20');
  assert.equal(render(valueOf(after, 'doubled').value), '40');
  assert.equal(render(valueOf(after, 'unrelated').value), '11');
  assert.deepEqual(evaluator.getStats().recomputationsByPath, {
    doubled: 1,
    fallback: 1,
    primary: 1,
    'tenant.limit': 1,
  });
});

test('a dependency introduced by a branch switch invalidates only readers', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'env', values: { 'a': 1, 'b': 2 } }],
    expressions: {
      'picked': {
        $if: [{ $eq: [{ $ctx: 'useB' }, { $const: true }] }, { $ref: 'b' }, { $ref: 'a' }],
      },
      'scaled': { $mul: [{ $ref: 'picked' }, { $const: 10 }] },
      'other': { $add: [{ $ref: 'a' }, { $const: 100 }] },
    },
    context: { useB: false },
  });
  evaluator.evaluate(['scaled', 'other', 'picked']);
  evaluator.resetStats();
  evaluator.setContext({ useB: true });
  const result = evaluator.evaluate(['scaled', 'other', 'picked']);
  assert.equal(render(valueOf(result, 'scaled').value), '20');
  assert.equal(render(valueOf(result, 'other').value), '101');
  // `b` is read for the first time; `a` and `other` stay cached.
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { b: 1, picked: 1, scaled: 1 });
  assert.deepEqual(valueOf(result, 'picked').definition.referencedPaths, ['b']);
});

test('a batch root list mixing successes, misses and errors stays consistent', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'env', values: { 'good': '1s', 'badUnit': 5, 'removed': deletePath() } },
    ],
    expressions: {
      'bad': { $add: [{ $ref: 'good' }, { $ref: 'badUnit' }] },
    },
  });
  const result = evaluator.evaluate(['good', 'missing', 'removed', 'bad']);
  assert.deepEqual(Object.keys(result.values), ['good']);
  assert.deepEqual(result.missing.sort(), ['missing', 'removed']);
  assert.deepEqual(Object.keys(result.errors), ['bad']);
  assert.equal(result.outcomes.good && result.outcomes.good.ok, true);
  assert.equal(result.missingDetail.removed?.reason, 'deleted');
  assert.equal(result.missingDetail.missing?.reason, 'absent');
  assert.equal(result.errors.bad?.code, 'unit_mismatch');
});
