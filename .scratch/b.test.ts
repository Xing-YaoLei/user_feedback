import test from 'node:test';
import assert from 'node:assert/strict';
import { f, type Foo } from './a.ts';

test('works', () => {
  const x: Foo = { a: f(2) };
  assert.equal(x.a, 4);
});
