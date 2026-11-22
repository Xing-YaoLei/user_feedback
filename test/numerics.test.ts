import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaRegistry } from '../src/registry.ts';
import { ParseError } from '../src/errors.ts';
import type { Schema, WireValue } from '../src/types.ts';
import { I64_MAX, I64_MIN } from '../src/types.ts';
import { numericLossless } from '../src/compat.ts';
import { decodeWire, encodeWire } from '../src/wire.ts';
import { analyzeStandalonePair, mustFailRegistration } from './helpers.ts';

function scalar(version: string, kind: 'i32' | 'i64' | 'f64' | 'bool' | 'string'): Schema {
  return { version, types: {}, root: { kind } };
}

/**
 * Build a registry holding two scalar versions. The second registration uses
 * the policy that permits the intended writer->reader ordering; individual
 * tests then assert via analyze()/parseAcross() on the ordered pair.
 */
function pairRegistry(
  writerVersion: string,
  writerKind: 'i32' | 'i64' | 'f64' | 'bool' | 'string',
  readerVersion: string,
  readerKind: 'i32' | 'i64' | 'f64' | 'bool' | 'string',
  secondPolicy: 'backward' | 'forward' | 'bidirectional' = 'backward',
): SchemaRegistry {
  const registry = new SchemaRegistry();
  registry.register(scalar(writerVersion, writerKind), 'bidirectional');
  registry.register(scalar(readerVersion, readerKind), secondPolicy);
  return registry;
}

describe('numeric promotion rules', () => {
  it('encodes the full lossless promotion table', () => {
    assert.equal(numericLossless('i32', 'i32'), true);
    assert.equal(numericLossless('i32', 'i64'), true);
    assert.equal(numericLossless('i32', 'f64'), true);
    assert.equal(numericLossless('i64', 'i64'), true);
    assert.equal(numericLossless('f64', 'f64'), true);

    assert.equal(numericLossless('i64', 'f64'), false);
    assert.equal(numericLossless('i64', 'i32'), false);
    assert.equal(numericLossless('f64', 'i32'), false);
    assert.equal(numericLossless('f64', 'i64'), false);
    assert.equal(numericLossless('bool', 'string'), false);
  });

  it('i32 -> i64 promotes numbers to exact bigints', () => {
    const registry = pairRegistry('w-i32', 'i32', 'r-i64', 'i64');
    assert.equal(registry.parseAcross('w-i32', 'r-i64', -2147483648), -2147483648n);
  });

  it('i32 -> f64 is exact for every signed 32 bit value', () => {
    const registry = pairRegistry('w-i32', 'i32', 'r-f64', 'f64');
    assert.equal(registry.parseAcross('w-i32', 'r-f64', 2147483647), 2147483647);
  });

  it('i64 -> f64 is incompatible: counterexample reproduces at parse entry', () => {
    const err = analyzeStandalonePair(scalar('w-i64', 'i64'), scalar('r-f64', 'f64'));
    assert.equal(err.reason, 'leaf-mismatch');
    // The counterexample is a real finite i64 wire value (bigint).
    assert.equal(typeof err.counterexample, 'bigint');
  });

  it('i64 stays exact at runtime, including through JSON encode/decode', () => {
    const registry = new SchemaRegistry();
    registry.register(scalar('w-i64', 'i64'), 'bidirectional');
    const big: WireValue = 9007199254740993n; // 2^53 + 1, not exactly representable as f64
    assert.equal(registry.parse('w-i64', big), big);

    const text = encodeWire(big);
    const back = decodeWire(text);
    assert.equal(back, big);
    assert.equal(registry.parse('w-i64', back), big);

    // Boundary values survive.
    for (const boundary of [I64_MIN, I64_MAX]) {
      assert.equal(decodeWire(encodeWire(boundary)), boundary);
    }
  });

  it('an out-of-range bigint is rejected when parsing i64', () => {
    const registry = new SchemaRegistry();
    registry.register(scalar('w-i64', 'i64'), 'bidirectional');
    assert.throws(
      () => registry.parse('w-i64', I64_MAX + 1n),
      (err: unknown) => err instanceof ParseError && err.reason === 'bad-i64',
    );
  });

  it('f64 -> i64 is incompatible and gives a finite numeric counterexample', () => {
    const err = analyzeStandalonePair(scalar('w-f64', 'f64'), scalar('r-i64', 'i64'));
    assert.equal(err.reason, 'leaf-mismatch');
    assert.equal(typeof err.counterexample, 'number');
  });

  it('bool writer vs i32 reader is rejected and the counterexample reproduces', () => {
    const err = analyzeStandalonePair(scalar('w-bool', 'bool'), scalar('r-i32', 'i32'));
    assert.equal(err.reason, 'leaf-mismatch');
    assert.equal(err.counterexample, false);
  });

  it('incompatible pairs cannot be registered under any direction', () => {
    const registry = new SchemaRegistry();
    registry.register(scalar('w-i64', 'i64'), 'bidirectional');
    mustFailRegistration(registry, scalar('r-f64', 'f64'), 'backward');
    // Forward for i64-existing vs f64-new: new f64 writer -> old i64 reader
    // is also a lossy pair, so it fails too.
    mustFailRegistration(registry, scalar('r-f64', 'f64'), 'forward');
    assert.deepEqual(registry.listVersions(), ['w-i64']);
  });
});
