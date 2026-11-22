/**
 * Unit-token and exact-arithmetic behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuantityError,
  addQuantities,
  compareQuantities,
  convertQuantity,
  divQuantities,
  equalQuantities,
  formatQuantity,
  makeQuantity,
  mulQuantities,
  parseQuantityText,
  quantityToValue,
  ratAdd,
  ratCmp,
  ratDiv,
  ratFromDecimal,
  ratMul,
  ratSub,
  ratToString,
  rational,
  subQuantities,
} from '../src/index.ts';

test('rationals normalize sign and reduce', () => {
  assert.deepEqual(rational(6n, -8n), { n: -3n, d: 4n });
  assert.deepEqual(rational(0n, 5n), { n: 0n, d: 1n });
});

test('decimal parsing is exact', () => {
  assert.equal(ratToString(ratFromDecimal('0.1')!), '0.1');
  assert.equal(ratToString(ratFromDecimal('-2.50')!), '-2.5');
  assert.equal(ratFromDecimal('1e3'), null);
  assert.equal(ratFromDecimal('abc'), null);
  assert.equal(ratFromDecimal(''), null);
  assert.equal(ratToString(ratAdd(ratFromDecimal('0.1')!, ratFromDecimal('0.2')!)), '0.3');
});

test('repeating fractions round half-up to 12 places', () => {
  assert.equal(ratToString(ratDiv(rational(1n), rational(3n))), '0.333333333333');
  assert.equal(ratToString(ratDiv(rational(2n), rational(3n))), '0.666666666667');
  assert.equal(ratToString(ratDiv(rational(1n), rational(8n))), '0.125');
  assert.equal(ratToString(ratSub(rational(1n), rational(1n))), '0');
});

test('time units convert exactly', () => {
  const oneSecond = makeQuantity('1', 's');
  assert.equal(formatQuantity(oneSecond), '1s');
  assert.equal(ratToString(convertQuantity(oneSecond, 'ms'), 20), '1000');
  assert.equal(ratToString(convertQuantity(oneSecond, 'min'), 20), '0.01666666666666666667');
  assert.equal(ratToString(convertQuantity(makeQuantity('1.5', 'h'), 'min'), 20), '90');
});

test('byte units distinguish decimal and binary', () => {
  assert.equal(ratToString(convertQuantity(makeQuantity('1', 'kb'), 'b'), 20), '1000');
  assert.equal(ratToString(convertQuantity(makeQuantity('1', 'kib'), 'b'), 20), '1024');
  assert.equal(ratToString(convertQuantity(makeQuantity('1', 'gib'), 'mib'), 20), '1024');
});

test('addition/subtraction align on the left operand unit', () => {
  const sum = addQuantities(makeQuantity('250', 'ms'), makeQuantity('0.75', 's'));
  assert.equal(formatQuantity(sum), '1000ms');
  const reversed = addQuantities(makeQuantity('1', 's'), makeQuantity('250', 'ms'));
  assert.equal(formatQuantity(reversed), '1.25s');
  const diff = subQuantities(makeQuantity('1', 'gib'), makeQuantity('1', 'mib'));
  assert.equal(formatQuantity(diff), '0.9990234375gib');
  const decimalDiff = subQuantities(makeQuantity('1', 'gib'), makeQuantity('1', 'mb'));
  assert.equal(formatQuantity(decimalDiff), '0.999068677425384521484375gib');
});

test('comparison ignores unit choice within a dimension', () => {
  assert.equal(compareQuantities(makeQuantity('1', 's'), makeQuantity('1000', 'ms')), 0);
  assert.equal(compareQuantities(makeQuantity('1', 'min'), makeQuantity('59', 's')), 1);
  assert.equal(equalQuantities(makeQuantity('1', 'gib'), makeQuantity('1024', 'mib')), true);
  assert.equal(equalQuantities(makeQuantity('1', 'gib'), makeQuantity('1', 'gb')), false);
});

test('multiplication and division handle counts and dimensions', () => {
  assert.equal(formatQuantity(mulQuantities(makeQuantity('3', 'count'), makeQuantity('2', 's'))), '6s');
  assert.equal(formatQuantity(mulQuantities(makeQuantity('2', 's'), makeQuantity('3', 'count'))), '6s');
  assert.equal(formatQuantity(divQuantities(makeQuantity('10', 's'), makeQuantity('2', 'count'))), '5s');
  const ratio = divQuantities(makeQuantity('10', 's'), makeQuantity('2', 's'));
  assert.equal(ratio.dimension, 'count');
  assert.equal(formatQuantity(ratio), '5');
  assert.throws(
    () => mulQuantities(makeQuantity('1', 's'), makeQuantity('1', 'b')),
    (error: unknown) => error instanceof QuantityError && error.code === 'unit_mismatch',
  );
  assert.throws(
    () => divQuantities(makeQuantity('1', 's'), makeQuantity('0', 'count')),
    (error: unknown) => error instanceof QuantityError && error.code === 'division_by_zero',
  );
});

test('cross-dimension conversion is refused', () => {
  assert.throws(
    () => convertQuantity(makeQuantity('1', 's'), 'b'),
    (error: unknown) => error instanceof QuantityError && error.code === 'unit_mismatch',
  );
});

test('parseQuantityText recognizes units and rejects plain words', () => {
  assert.equal(formatQuantity(parseQuantityText('250ms')!), '250ms');
  assert.equal(formatQuantity(parseQuantityText('1.5 GiB')!), '1.5gib');
  assert.equal(parseQuantityText('hello'), null);
  assert.equal(parseQuantityText('12'), null);
  assert.equal(parseQuantityText('12watts'), null);
});

test('quantity values round-trip through their literal form', () => {
  const value = quantityToValue(makeQuantity('0.05', 's'));
  assert.deepEqual(value, { kind: 'number', value: '0.05', unit: 's' });
  assert.equal(ratCmp(ratMul(rational(1n, 2n), rational(4n)), rational(2n)), 0);
});
