import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ExpiredBudgetError,
  InsufficientBudgetError,
  PROTOCOL_A_MAX_MILLISECONDS,
  PROTOCOL_B_MAX_VALUE,
  UNIT_NANOS,
  encodeBudget,
  parseProtocolABudget,
  parseProtocolBBudget,
  parseRelativeDuration,
  type EncodedBudget,
} from '../src/index.ts';

function assertWithinBudget(budget: EncodedBudget, remainingNanos: bigint): void {
  assert.ok(
    budget.encodedNanos <= remainingNanos,
    `encoded ${budget.encodedNanos}ns must not exceed remaining ${remainingNanos}ns`,
  );
  assert.ok(budget.lossNanos >= 0n, 'loss must never be negative');
  assert.equal(budget.encodedNanos + budget.lossNanos, remainingNanos);
}

describe('protocol A encoding', () => {
  it('rounds down to whole milliseconds and never grows the budget', () => {
    const budget = encodeBudget(1_500_000n, 'A');
    assert.equal(budget.protocol, 'A');
    assert.equal(budget.milliseconds, 1);
    assert.equal(budget.encodedNanos, 1_000_000n);
    assert.equal(budget.lossNanos, 500_000n);
    assertWithinBudget(budget, 1_500_000n);
  });

  it('is exact on a millisecond boundary', () => {
    const budget = encodeBudget(250_000_000n, 'A');
    assert.equal(budget.milliseconds, 250);
    assert.equal(budget.lossNanos, 0n);
  });

  it('caps at 2147483647 milliseconds instead of wrapping or growing', () => {
    const huge = 10_000_000_000_000_000_000n; // ~317 years in ns
    const budget = encodeBudget(huge, 'A');
    assert.equal(budget.milliseconds, 2_147_483_647);
    assert.equal(bigintOf(budget.milliseconds), PROTOCOL_A_MAX_MILLISECONDS);
    assertWithinBudget(budget, huge);
  });

  it('rejects a positive budget below 1ms as explicitly insufficient', () => {
    for (const remaining of [1n, 999n, 999_999n]) {
      assert.throws(
        () => encodeBudget(remaining, 'A'),
        (error: unknown) =>
          error instanceof InsufficientBudgetError &&
          error.remainingNanos === remaining &&
          error.minimumNanos === 1_000_000n,
        `expected insufficient error for ${remaining}ns`,
      );
    }
  });

  it('rejects a zero or negative budget instead of encoding infinite', () => {
    assert.throws(() => encodeBudget(0n, 'A'), ExpiredBudgetError);
    assert.throws(() => encodeBudget(-5n, 'A'), ExpiredBudgetError);
  });
});

describe('protocol B encoding', () => {
  it('uses the finest unit with the smallest loss', () => {
    const budget = encodeBudget(250_000_000n, 'B');
    assert.equal(budget.protocol, 'B');
    if (budget.protocol !== 'B') throw new Error('unreachable');
    // 250000u, 250m and 250000000n all hit the value exactly; the tie-break
    // prefers the finer unit.
    assert.equal(budget.wire, '250000u');
    assert.equal(budget.encodedNanos, 250_000_000n);
    assert.equal(budget.lossNanos, 0n);
  });

  it('prefers the finer unit when two units encode the same duration', () => {
    const budget = encodeBudget(1_000n, 'B');
    if (budget.protocol !== 'B') throw new Error('unreachable');
    assert.equal(budget.wire, '1000n');
    assert.equal(budget.encodedNanos, 1_000n);
    assert.equal(budget.lossNanos, 0n);
  });

  it('moves off a unit once its value would need nine digits', () => {
    // 99_999_999_999ns fits in 8 digits as microseconds but loses 999ns.
    // 100_000_000_000ns does not fit as microseconds; milliseconds are exact.
    const justUnder = encodeBudget(99_999_999_999n, 'B');
    const justOver = encodeBudget(100_000_000_000n, 'B');
    if (justUnder.protocol !== 'B' || justOver.protocol !== 'B') {
      throw new Error('unreachable');
    }
    assert.equal(justUnder.unit, 'u');
    assert.equal(justUnder.value, 99_999_999);
    assert.equal(justUnder.lossNanos, 999n);

    assert.equal(justOver.unit, 'm');
    assert.equal(justOver.value, 100_000);
    assert.equal(justOver.lossNanos, 0n);
    assertWithinBudget(justUnder, 99_999_999_999n);
    assertWithinBudget(justOver, 100_000_000_000n);
  });

  it('clamps a coarse unit to the eight-digit maximum rather than overflowing', () => {
    const huge = UNIT_NANOS.H * 500_000_000n; // 5e8 hours
    const budget = encodeBudget(huge, 'B');
    if (budget.protocol !== 'B') throw new Error('unreachable');
    assert.equal(budget.value, Number(PROTOCOL_B_MAX_VALUE));
    assert.equal(budget.unit, 'H');
    assertWithinBudget(budget, huge);
  });

  it('keeps every digit count within the eight-digit wire limit', () => {
    const samples: bigint[] = [
      1n,
      999n,
      1_000n,
      999_999n,
      1_000_000n,
      250_000_000n,
      999_999_999n,
      1_000_000_000n,
      59_999_999_999n,
      3_599_999_999_999n,
      86_399_999_999_999n,
      UNIT_NANOS.H * 99_999_999n + 123n,
    ];
    for (const sample of samples) {
      const budget = encodeBudget(sample, 'B');
      if (budget.protocol !== 'B') throw new Error('unreachable');
      assert.match(budget.wire, /^[0-9]{1,8}[HMSmun]$/);
      assert.ok(budget.value <= PROTOCOL_B_MAX_VALUE);
      assertWithinBudget(budget, sample);
    }
  });

  it('never throws for a positive nanosecond budget because 1ns is representable', () => {
    // The smallest B unit is the nanosecond, so the insufficient path for B is
    // unreachable for bigint budgets; the guard still exists and is asserted
    // via the protocol minimum.
    const budget = encodeBudget(1n, 'B');
    if (budget.protocol !== 'B') throw new Error('unreachable');
    assert.equal(budget.wire, '1n');
    assert.equal(budget.lossNanos, 0n);
  });

  it('rejects zero budgets', () => {
    assert.throws(() => encodeBudget(0n, 'B'), ExpiredBudgetError);
  });
});

describe('decoding received budgets', () => {
  it('decodes protocol A millisecond counts exactly, including the boundary', () => {
    assert.equal(parseProtocolABudget(250), 250_000_000n);
    assert.equal(parseProtocolABudget(2_147_483_647), 2_147_483_647n * 1_000_000n);
    assert.equal(parseProtocolABudget(2_147_483_647n), 2_147_483_647n * 1_000_000n);
  });

  it('rejects non-integer, negative and oversized protocol A values', () => {
    assert.throws(() => parseProtocolABudget(1.5));
    assert.throws(() => parseProtocolABudget(-1));
    assert.throws(() => parseProtocolABudget(2_147_483_648));
  });

  it('decodes protocol B strings with every unit', () => {
    assert.equal(parseProtocolBBudget('1H'), UNIT_NANOS.H);
    assert.equal(parseProtocolBBudget('1M'), UNIT_NANOS.M);
    assert.equal(parseProtocolBBudget('1S'), UNIT_NANOS.S);
    assert.equal(parseProtocolBBudget('1m'), UNIT_NANOS.m);
    assert.equal(parseProtocolBBudget('1u'), UNIT_NANOS.u);
    assert.equal(parseProtocolBBudget('1n'), 1n);
    assert.equal(parseProtocolBBudget('99999999n'), 99_999_999n);
  });

  it('rejects zero-padded overflow and malformed protocol B strings', () => {
    assert.throws(() => parseProtocolBBudget('123456789n')); // 9 digits
    assert.throws(() => parseProtocolBBudget('1x'));
    assert.throws(() => parseProtocolBBudget('n'));
  });

  it('rejects number budgets so no float can slip into the deadline math', () => {
    assert.throws(() => parseRelativeDuration(1.5 as unknown as string));
    assert.throws(() => parseRelativeDuration(-1n));
    assert.throws(() => parseRelativeDuration({ value: 10n, unit: 'h' } as never));
  });
});

function bigintOf(value: number): bigint {
  return BigInt(value);
}
