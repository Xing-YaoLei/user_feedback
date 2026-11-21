import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../src/index.ts';

test('public API surface is stable', () => {
  assert.equal(typeof api.CorrelationEngine, 'function');
  assert.equal(typeof api.CorrelationSubscription, 'function');
  assert.equal(typeof api.matchKeyEvents, 'function');
  assert.equal(typeof api.referenceMatches, 'function');
  assert.equal(typeof api.compareEvents, 'function');
  assert.equal(typeof api.emptyDelta, 'function');
});

test('emptyDelta returns fresh, independent objects', () => {
  const a = api.emptyDelta();
  const b = api.emptyDelta();
  assert.notEqual(a, b);
  a.added.push({ key: 'k', aId: 'a', bId: 'b', aTime: 0, bTime: 1 });
  assert.equal(b.added.length, 0);
  assert.equal(api.isDeltaEmpty(b), true);
  assert.equal(api.isDeltaEmpty(a), false);
});
