import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RouterError,
  parseRoutingKey,
  parseTopicPattern,
  topicMatches,
} from '../src/index.ts';

function matches(pattern: string, key: string): boolean {
  return topicMatches(parseTopicPattern(pattern), parseRoutingKey(key));
}

test('routing key: empty string is zero segments', () => {
  assert.deepEqual(parseRoutingKey('').segments, []);
  assert.deepEqual(parseRoutingKey('a.b.c').segments, ['a', 'b', 'c']);
});

test('routing key: empty segments are rejected', () => {
  for (const bad of ['a..b', '.a', 'a.', '.']) {
    assert.throws(
      () => parseRoutingKey(bad),
      (error: unknown) =>
        error instanceof RouterError && error.code === 'INVALID_ROUTING_KEY',
      `expected "${bad}" to be rejected`,
    );
  }
});

test('topic: literal patterns match exact segment sequences', () => {
  assert.equal(matches('a.b.c', 'a.b.c'), true);
  assert.equal(matches('a.b.c', 'a.b'), false);
  assert.equal(matches('a.b', 'a.b.c'), false);
  assert.equal(matches('a.b.c', 'a.x.c'), false);
});

test('topic: * matches exactly one segment', () => {
  assert.equal(matches('a.*.c', 'a.b.c'), true);
  assert.equal(matches('a.*.c', 'a.c'), false);
  assert.equal(matches('a.*.c', 'a.b.x.c'), false);
  assert.equal(matches('*', 'single'), true);
  assert.equal(matches('*', ''), false);
  assert.equal(matches('*', 'two.parts'), false);
});

test('topic: # matches zero or more segments', () => {
  assert.equal(matches('#', ''), true);
  assert.equal(matches('#', 'a'), true);
  assert.equal(matches('#', 'a.b.c.d'), true);
  assert.equal(matches('a.#', 'a'), true);
  assert.equal(matches('a.#', 'a.b.c'), true);
  assert.equal(matches('a.#', 'b.c'), false);
  assert.equal(matches('#.z', 'z'), true);
  assert.equal(matches('#.z', 'a.b.z'), true);
  assert.equal(matches('#.z', 'a.b'), false);
  assert.equal(matches('a.#.z', 'a.z'), true);
  assert.equal(matches('a.#.z', 'a.b.c.z'), true);
  assert.equal(matches('a.#.z', 'a.b.c'), false);
});

test('topic: empty pattern only matches the empty key', () => {
  assert.equal(matches('', ''), true);
  assert.equal(matches('', 'a'), false);
});

test('topic: consecutive # segments are allowed and behave like one #', () => {
  assert.equal(matches('#.#', ''), true);
  assert.equal(matches('#.#', 'a.b.c'), true);
  assert.equal(matches('a.#.#.b', 'a.b'), true);
  assert.equal(matches('a.#.#.b', 'a.x.y.b'), true);
  assert.equal(matches('a.#.#.b', 'a.x.y'), false);
});

test('topic: wildcard must occupy a whole segment', () => {
  for (const bad of ['a*b', 'orders.*x', '#x', 'x#']) {
    assert.throws(
      () => parseTopicPattern(bad),
      (error: unknown) => error instanceof RouterError && error.code === 'INVALID_PATTERN',
      `expected pattern "${bad}" to be rejected`,
    );
  }
  for (const bad of ['a..b', '.a', 'a.']) {
    assert.throws(
      () => parseTopicPattern(bad),
      (error: unknown) => error instanceof RouterError && error.code === 'INVALID_PATTERN',
    );
  }
});

test('topic: repeated wildcards and long keys stay polynomial', () => {
  // A naive backtracking matcher takes 2^segments here.
  const segments = 64;
  const pattern = new Array(segments + 1).fill('#').join('.') + '.tail';
  const key = new Array(segments).fill('x').join('.') + '.tail';

  const started = performance.now();
  assert.equal(matches(pattern, key), true);
  assert.equal(matches(pattern, key.replace(/tail$/, 'nope')), false);
  const elapsed = performance.now() - started;

  // Generous bound; the DP needs only a few thousand state visits.
  assert.ok(elapsed < 250, `topic matching took ${elapsed.toFixed(1)}ms`);
});

test('topic: crossing prefixes do not explode', () => {
  // Overlapping literal prefixes historically trigger exponential recursion.
  const pattern = ['#', 'a', '#', 'a', '#', 'a', '#', 'a', '#', 'a', '#', 'z'].join('.');
  const key = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a'].join('.');
  const started = performance.now();
  assert.equal(matches(pattern, key), false);
  assert.ok(performance.now() - started < 100);
});
