/**
 * Shared subexpressions and batch-level reuse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigEvaluator } from '../src/index.ts';
import { render, valueOf } from './helpers.ts';

test('a shared subexpression is computed once per batch', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': 6, 'b': 4 } }],
    expressions: {
      'common': { $add: [{ $ref: 'a' }, { $ref: 'b' }] },
      'left': { $mul: [{ $ref: 'common' }, { $const: 2 }] },
      'right': { $sub: [{ $ref: 'common' }, { $const: 1 }] },
      'top': { $add: [{ $ref: 'left' }, { $ref: 'right' }, { $ref: 'common' }] },
    },
  });
  const result = evaluator.evaluate(['left', 'right', 'top']);
  assert.equal(render(valueOf(result, 'left').value), '20');
  assert.equal(render(valueOf(result, 'right').value), '9');
  assert.equal(render(valueOf(result, 'top').value), '39');
  const recomputations = evaluator.getStats().recomputationsByPath;
  assert.equal(recomputations.common, 1);
  assert.equal(recomputations.left, 1);
  assert.equal(recomputations.right, 1);
  assert.equal(recomputations.top, 1);
  assert.equal(recomputations.a, 1);
  assert.equal(recomputations.b, 1);
});

test('listing the same root twice resolves it once', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 2 } }],
    expressions: { 'sq': { $mul: [{ $ref: 'n' }, { $ref: 'n' }] } },
  });
  const result = evaluator.evaluate(['sq', 'sq']);
  assert.equal(render(valueOf(result, 'sq').value), '4');
  assert.equal(evaluator.getStats().recomputationsByPath.sq, 1);
  // The second request is a memo hit but was computed in this batch, so it is
  // not reported as a cache hit either.
  assert.equal(evaluator.getStats().cacheHits + evaluator.getStats().cacheMisses, 2);
});

test('a wide fan-out invalidates exactly the affected subtree', () => {
  const expressions: Record<string, unknown> = {
    'shared': { $ref: 'seed' },
  };
  const consumers = Array.from({ length: 20 }, (_, index) => `c${index}`);
  for (const [index, name] of consumers.entries()) {
    expressions[name] = { $add: [{ $ref: 'shared' }, { $const: index }] };
  }
  expressions['independent'] = { $ref: 'other' };

  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'seed': 1, 'other': 'fixed' } }],
    expressions: expressions as never,
  });

  const first = evaluator.evaluate([...consumers, 'independent']);
  assert.equal(render(valueOf(first, 'c19').value), '20');

  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'l', path: 'other', value: 'changed' });
  evaluator.evaluate([...consumers, 'independent']);
  // The unrelated `other` change touches only its own consumer.
  assert.deepEqual(evaluator.getStats().recomputationsByPath, { independent: 1, other: 1 });

  evaluator.resetStats();
  evaluator.update({ type: 'set', layer: 'l', path: 'seed', value: 10 });
  const third = evaluator.evaluate([...consumers, 'independent']);
  assert.equal(render(valueOf(third, 'c19').value), '29');
  const counts = evaluator.getStats().recomputationsByPath;
  assert.equal(counts.shared, 1);
  assert.equal(counts.seed, 1);
  assert.equal(counts.independent, undefined);
  for (const name of consumers) assert.equal(counts[name], 1);
});

test('deep chains resolve iteratively without exponential work', () => {
  const expressions: Record<string, unknown> = { n0: { $const: 1 } };
  for (let index = 1; index <= 60; index += 1) {
    expressions[`n${index}`] = { $add: [{ $ref: `n${index - 1}` }, { $const: 1 }] };
  }
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: {} }],
    expressions: expressions as never,
  });
  const result = evaluator.evaluate(['n60']);
  assert.equal(render(valueOf(result, 'n60').value), '61');
  const recomputations = evaluator.getStats().recomputationsByPath;
  for (let index = 0; index <= 60; index += 1) {
    assert.equal(recomputations[`n${index}`], 1, `n${index} should compute once`);
  }
});
