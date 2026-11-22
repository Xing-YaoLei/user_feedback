/**
 * Expression semantics: constants, context reads, lazy branches, comparisons,
 * arithmetic, exact units and failure attribution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigEvaluator } from '../src/index.ts';
import { errorOf, missingOf, render, valueOf } from './helpers.ts';

test('constants and context reads produce typed values', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: {} }],
    expressions: {
      'c.string': { $const: 'hello' },
      'c.count': { $const: 4 },
      'c.null': { $const: null },
      'c.bool': { $const: true },
      'c.qty': { $qty: '2.5GiB' },
      'c.ctx': { $ctx: 'region' },
      'c.ctxNested': { $ctx: 'request.tier' },
    },
    context: { region: 'eu', request: { tier: 'gold' } },
  });
  const result = evaluator.evaluate(Object.keys({
    'c.string': 1, 'c.count': 1, 'c.null': 1, 'c.bool': 1, 'c.qty': 1, 'c.ctx': 1, 'c.ctxNested': 1,
  }));
  assert.equal(render(valueOf(result, 'c.string').value), 'hello');
  assert.equal(render(valueOf(result, 'c.count').value), '4');
  assert.deepEqual(valueOf(result, 'c.null').value, { kind: 'null' });
  assert.equal(render(valueOf(result, 'c.bool').value), 'true');
  assert.equal(render(valueOf(result, 'c.qty').value), '2.5gib');
  assert.equal(render(valueOf(result, 'c.ctx').value), 'eu');
  assert.equal(render(valueOf(result, 'c.ctxNested').value), 'gold');
  assert.deepEqual(valueOf(result, 'c.ctx').definition.contextKeys, ['region']);
});

test('a missing context field is missing, and an error when required', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: {} }],
    expressions: {
      'plain': { $ctx: 'absent' },
      'coalesced': { $coalesce: [{ $ctx: 'absent' }, { $const: 'fallback' }] },
      'required': { $add: [{ $ctx: 'absent' }, { $const: 1 }] },
    },
    context: {},
  });
  const result = evaluator.evaluate(['plain', 'coalesced', 'required']);
  assert.equal(missingOf(result, 'plain').reason, 'absent');
  assert.equal(render(valueOf(result, 'coalesced').value), 'fallback');
  const error = errorOf(result, 'required');
  assert.equal(error.code, 'missing');
  assert.equal(error.source, 'context:absent');
});

test('$if evaluates only the selected branch', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'flag': true } }],
    expressions: {
      'loop.a': { $ref: 'loop.b' },
      'loop.b': { $ref: 'loop.a' },
      'safe': { $if: [{ $ref: 'flag' }, { $const: 'ok' }, { $ref: 'loop.a' }] },
      'unsafe': { $if: [{ $ref: 'flag' }, { $ref: 'loop.a' }, { $const: 'ok' }] },
    },
    context: { unusedBranchFlag: false },
  });
  const result = evaluator.evaluate(['safe', 'unsafe']);
  assert.equal(render(valueOf(result, 'safe').value), 'ok');
  // The cycle lives only in the unselected branch, so it contributes no
  // dependencies and is never checked.
  assert.deepEqual(valueOf(result, 'safe').definition.referencedPaths, ['flag']);
  assert.equal(errorOf(result, 'unsafe').code, 'cycle');
});

test('$and and $or short-circuit', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 't': true, 'f': false } }],
    expressions: {
      'loop.a': { $ref: 'loop.a' },
      'andShort': { $and: [{ $ref: 'f' }, { $ref: 'loop.a' }] },
      'andFull': { $and: [{ $ref: 't' }, { $ref: 't' }] },
      'orShort': { $or: [{ $ref: 't' }, { $ref: 'loop.a' }] },
      'orFull': { $or: [{ $ref: 'f' }, { $ref: 'f' }] },
    },
  });
  const result = evaluator.evaluate(['andShort', 'andFull', 'orShort', 'orFull']);
  assert.equal(render(valueOf(result, 'andShort').value), 'false');
  assert.equal(render(valueOf(result, 'andFull').value), 'true');
  assert.equal(render(valueOf(result, 'orShort').value), 'true');
  assert.equal(render(valueOf(result, 'orFull').value), 'false');
  assert.deepEqual(valueOf(result, 'andShort').definition.referencedPaths, ['f']);
});

test('cycles are detected with the full chain', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: {} }],
    expressions: {
      a: { $ref: 'b' },
      b: { $ref: 'c' },
      c: { $ref: 'a' },
    },
  });
  const error = errorOf(evaluator.evaluate(['a']), 'a');
  assert.equal(error.code, 'cycle');
  assert.match(error.message, /a -> b -> c -> a/);
  assert.deepEqual(
    error.refs.map((hop) => hop.path),
    ['b', 'c', 'a'],
  );
});

test('a cycle reported once does not corrupt later evaluations', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'ok': 1 } }],
    expressions: { a: { $ref: 'b' }, b: { $ref: 'a' } },
  });
  assert.equal(errorOf(evaluator.evaluate(['a']), 'a').code, 'cycle');
  assert.equal(errorOf(evaluator.evaluate(['a']), 'a').code, 'cycle');
  assert.equal(render(valueOf(evaluator.evaluate(['ok']), 'ok').value), '1');
});

test('comparisons work across units and types', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'limit': '1s', 'name': 'alpha', 'n': 5 } }],
    expressions: {
      'eqUnits': { $eq: [{ $ref: 'limit' }, { $qty: '1000ms' }] },
      'ltUnits': { $lt: [{ $ref: 'limit' }, { $qty: '1500ms' }] },
      'ltStrings': { $lt: [{ $ref: 'name' }, { $const: 'beta' }] },
      'neCounts': { $ne: [{ $ref: 'n' }, { $const: 6 }] },
      'typeMismatch': { $lt: [{ $ref: 'name' }, { $const: 3 }] },
      'dimensionMismatch': { $lt: [{ $ref: 'limit' }, { $qty: '1kb' }] },
    },
  });
  const result = evaluator.evaluate([
    'eqUnits', 'ltUnits', 'ltStrings', 'neCounts', 'typeMismatch', 'dimensionMismatch',
  ]);
  assert.equal(render(valueOf(result, 'eqUnits').value), 'true');
  assert.equal(render(valueOf(result, 'ltUnits').value), 'true');
  assert.equal(render(valueOf(result, 'ltStrings').value), 'true');
  assert.equal(render(valueOf(result, 'neCounts').value), 'true');
  assert.equal(errorOf(result, 'typeMismatch').code, 'type_mismatch');
  assert.equal(errorOf(result, 'dimensionMismatch').code, 'unit_mismatch');
});

test('arithmetic accepts mixed units within a dimension', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'a': '500ms', 'b': '1.5s', 'c': '1024KiB', 'n': 3 } }],
    expressions: {
      'sum': { $add: [{ $ref: 'a' }, { $ref: 'b' }] },
      'diff': { $sub: [{ $ref: 'b' }, { $ref: 'a' }] },
      'scale': { $mul: [{ $ref: 'c' }, { $ref: 'n' }] },
      'ratio': { $div: [{ $ref: 'b' }, { $ref: 'a' }] },
      'chain': { $add: [{ $ref: 'sum' }, { $qty: '0.25s' }] },
    },
  });
  const result = evaluator.evaluate(['sum', 'diff', 'scale', 'ratio', 'chain']);
  assert.equal(render(valueOf(result, 'sum').value), '2000ms');
  assert.equal(render(valueOf(result, 'diff').value), '1s');
  assert.equal(render(valueOf(result, 'scale').value), '3072kib');
  assert.equal(render(valueOf(result, 'ratio').value), '3');
  assert.equal(render(valueOf(result, 'chain').value), '2250ms');
});

test('unit mismatches name the offending source path', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'l', values: { 'timeout': '1s', 'disk': '1GiB' } },
    ],
    expressions: {
      'bad': { $add: [{ $ref: 'timeout' }, { $ref: 'disk' }] },
      'nested': { $add: [{ $const: 1 }, { $ref: 'bad' }] },
    },
  });
  const result = evaluator.evaluate(['bad', 'nested']);
  const error = errorOf(result, 'bad');
  assert.equal(error.code, 'unit_mismatch');
  assert.equal(error.source, 'timeout');
  assert.deepEqual(error.sources, ['timeout', 'disk']);
  assert.match(error.message, /dimension mismatch/);
  assert.deepEqual(error.refs, [
    { path: 'timeout', layer: 'l', via: 'ref' },
    { path: 'disk', layer: 'l', via: 'ref' },
  ]);

  // A dependent of a failing expression reports the same root cause.
  const nested = errorOf(result, 'nested');
  assert.equal(nested.code, 'unit_mismatch');
  assert.equal(nested.source, 'timeout');
});

test('type mismatches name the offending source path', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'num': 1, 'text': 'abc', 'flag': true } }],
    expressions: {
      'addTypes': { $add: [{ $ref: 'num' }, { $ref: 'text' }] },
      'ifNonBool': { $if: [{ $ref: 'num' }, { $const: 1 }, { $const: 2 }] },
      'mulText': { $mul: [{ $ref: 'text' }, { $ref: 'text' }] },
      'notNum': { $not: { $ref: 'num' } },
    },
  });
  const result = evaluator.evaluate(['addTypes', 'ifNonBool', 'mulText', 'notNum']);
  const addTypes = errorOf(result, 'addTypes');
  assert.equal(addTypes.code, 'type_mismatch');
  assert.equal(addTypes.source, 'text');
  assert.deepEqual(addTypes.sources, ['num', 'text']);
  assert.equal(errorOf(result, 'ifNonBool').source, 'num');
  assert.equal(errorOf(result, 'mulText').source, 'text');
  assert.equal(errorOf(result, 'notNum').source, 'num');
});

test('division by zero is reported, not thrown', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'n': 10, 'zero': 0 } }],
    expressions: { 'bad': { $div: [{ $ref: 'n' }, { $ref: 'zero' }] } },
  });
  const error = errorOf(evaluator.evaluate(['bad']), 'bad');
  assert.equal(error.code, 'division_by_zero');
});

test('an unselected branch is not type-checked either', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: { 'flag': false, 'text': 'abc' } }],
    expressions: {
      'guarded': {
        $if: [{ $ref: 'flag' }, { $add: [{ $ref: 'text' }, { $const: 1 }] }, { $const: 'safe' }],
      },
    },
  });
  assert.equal(render(valueOf(evaluator.evaluate(['guarded']), 'guarded').value), 'safe');
});

test('malformed expression nodes fail with invalid_expression', () => {
  const evaluator = createConfigEvaluator({
    layers: [{ id: 'l', values: {} }],
    expressions: {
      'noArray': { $add: { $const: 1 } } as never,
      'oneArg': { $add: [{ $const: 1 }] } as never,
      'threeArgsSub': { $sub: [{ $const: 1 }, { $const: 2 }, { $const: 3 }] } as never,
      'unknownOp': { $frobnicate: 1 } as never,
      'badQty': { $qty: 'not-a-quantity' } as never,
      'badUnit': { $qty: '5parsecs' } as never,
    },
  });
  const result = evaluator.evaluate(['noArray', 'oneArg', 'threeArgsSub', 'unknownOp', 'badQty', 'badUnit']);
  assert.equal(errorOf(result, 'noArray').code, 'invalid_expression');
  assert.equal(errorOf(result, 'oneArg').code, 'invalid_expression');
  assert.equal(errorOf(result, 'threeArgsSub').code, 'invalid_expression');
  assert.equal(errorOf(result, 'unknownOp').code, 'invalid_expression');
  assert.equal(errorOf(result, 'badQty').code, 'invalid_expression');
  assert.equal(errorOf(result, 'badUnit').code, 'unknown_unit');
});

test('$exists and $coalesce observe presence without failing', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'top', values: { 'gone': { kind: 'delete' } } },
      { id: 'low', values: { 'gone': 1, 'value': 2, 'none': null } },
    ],
    expressions: {
      'goneExists': { $exists: { $ref: 'gone' } },
      'valueExists': { $exists: { $ref: 'value' } },
      'nullExists': { $exists: { $ref: 'none' } },
      'coalesceMissing': { $coalesce: [{ $ref: 'gone' }, { $ref: 'value' }] },
    },
  });
  const result = evaluator.evaluate(['goneExists', 'valueExists', 'nullExists', 'coalesceMissing']);
  assert.equal(render(valueOf(result, 'goneExists').value), 'false');
  assert.equal(render(valueOf(result, 'valueExists').value), 'true');
  assert.equal(render(valueOf(result, 'nullExists').value), 'true');
  assert.equal(render(valueOf(result, 'coalesceMissing').value), '2');
});

test('deletion markers also work as {$delete: true} in layer values', () => {
  const evaluator = createConfigEvaluator({
    layers: [
      { id: 'top', values: { 'x': { $delete: true } as never } },
      { id: 'low', values: { 'x': 5 } },
    ],
  });
  assert.equal(missingOf(evaluator.evaluate(['x']), 'x').reason, 'deleted');
});
