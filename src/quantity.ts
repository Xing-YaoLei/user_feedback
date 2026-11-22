/**
 * Exact numeric quantities with dimensions and units.
 *
 * Every value is carried as an exact bigint rational, so unit conversion,
 * addition, subtraction, multiplication, division and comparison never
 * accumulate floating-point drift (e.g. `0.1s + 150ms` is exactly `250ms`).
 */

import type { Dimension, QuantityValue, Unit } from './types.ts';

export type UnitErrorCode = 'unit_mismatch' | 'division_by_zero' | 'unknown_unit' | 'type_mismatch';

export class QuantityError extends Error {
  readonly code: UnitErrorCode;
  constructor(code: UnitErrorCode, message: string) {
    super(message);
    this.name = 'QuantityError';
    this.code = code;
  }
}

const TIME_FACTORS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  min: 60_000_000_000n,
  h: 3_600_000_000_000n,
  d: 86_400_000_000_000n,
};

const BYTE_FACTORS: Record<string, bigint> = {
  b: 1n,
  kb: 1_000n,
  mb: 1_000_000n,
  gb: 1_000_000_000n,
  tb: 1_000_000_000_000n,
  kib: 1_024n,
  mib: 1_048_576n,
  gib: 1_073_741_824n,
  tib: 1_099_511_627_776n,
};

const COUNT_FACTORS: Record<string, bigint> = { count: 1n };

const UNIT_ALIASES: Record<string, Unit> = {
  nsec: 'ns',
  nanosecond: 'ns',
  nanoseconds: 'ns',
  usec: 'us',
  microsecond: 'us',
  microseconds: 'us',
  msec: 'ms',
  millisecond: 'ms',
  milliseconds: 'ms',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  minute: 'min',
  minutes: 'min',
  hour: 'h',
  hours: 'h',
  day: 'd',
  days: 'd',
  byte: 'b',
  bytes: 'b',
  kilobyte: 'kb',
  kilobytes: 'kb',
  megabyte: 'mb',
  megabytes: 'mb',
  gigabyte: 'gb',
  gigabytes: 'gb',
  terabyte: 'tb',
  terabytes: 'tb',
  kibibyte: 'kib',
  kibibytes: 'kib',
  mebibyte: 'mib',
  mebibytes: 'mib',
  gibibyte: 'gib',
  gibibytes: 'gib',
  tebibyte: 'tib',
  tebibytes: 'tib',
};

interface UnitInfo {
  dimension: Dimension;
  factor: bigint;
}

function unitInfo(token: string): UnitInfo | null {
  const lowered = token.toLowerCase();
  const unit = (UNIT_ALIASES[lowered] ?? lowered) as Unit;
  if (Object.hasOwn(TIME_FACTORS, unit)) return { dimension: 'time', factor: TIME_FACTORS[unit]! };
  if (Object.hasOwn(BYTE_FACTORS, unit)) return { dimension: 'bytes', factor: BYTE_FACTORS[unit]! };
  if (Object.hasOwn(COUNT_FACTORS, unit)) return { dimension: 'count', factor: 1n };
  return null;
}

export function isKnownUnit(token: string): boolean {
  return unitInfo(token) !== null;
}

export function canonicalUnit(token: string): Unit | null {
  const lowered = token.toLowerCase();
  const canonical = UNIT_ALIASES[lowered] ?? lowered;
  return unitInfo(canonical) ? (canonical as Unit) : null;
}

/** A rational number. Always normalized: `d > 0`, gcd(n, d) = 1. */
export interface Rational {
  n: bigint;
  d: bigint;
}

export interface Quantity {
  unit: Unit;
  dimension: Dimension;
  /** Magnitude expressed *in* `unit`. */
  r: Rational;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export function rational(n: bigint, d: bigint = 1n): Rational {
  if (d === 0n) throw new QuantityError('division_by_zero', 'division by zero');
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd);
  return { n: nn / g, d: dd / g };
}

export function ratAdd(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function ratSub(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function ratMul(a: Rational, b: Rational): Rational {
  return rational(a.n * b.n, a.d * b.d);
}

export function ratDiv(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new QuantityError('division_by_zero', 'division by zero');
  return rational(a.n * b.d, a.d * b.n);
}

export function ratCmp(a: Rational, b: Rational): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Parses a plain decimal string exactly. Returns null when malformed. */
export function ratFromDecimal(text: string): Rational | null {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) return null;
  const sign = match[1] ?? '';
  const whole = match[2] ?? '';
  const frac = match[3] ?? '';
  if (whole === '' && frac === '') return null;
  const digits = `${whole}${frac}` || '0';
  const numerator = BigInt(`${sign}${digits}` || '0');
  const denominator = 10n ** BigInt(frac.length);
  return rational(numerator, denominator);
}

function tenPow(exp: number): bigint {
  return 10n ** BigInt(exp);
}

/** Terminating decimal expansion length, or -1 when the fraction repeats. */
function terminatingScale(d: bigint): number {
  let tmp = d;
  let twos = 0;
  let fives = 0;
  while (tmp % 2n === 0n) {
    tmp /= 2n;
    twos += 1;
  }
  while (tmp % 5n === 0n) {
    tmp /= 5n;
    fives += 1;
  }
  if (tmp !== 1n) return -1;
  return Math.max(twos, fives);
}

/**
 * Renders a rational as a decimal string.
 *
 * Terminating fractions are rendered exactly. Repeating fractions are rounded
 * half-up to `maxDecimals` places.
 */
export function ratToString(value: Rational, maxDecimals = 12): string {
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  const d = value.d;

  const scale = terminatingScale(d);
  let whole: bigint;
  let fraction: string;

  if (scale >= 0) {
    const scaled = (n * tenPow(scale)) / d;
    const divisor = tenPow(scale);
    whole = scaled / divisor;
    fraction = (scaled % divisor).toString().padStart(scale, '0');
  } else {
    const divisor = tenPow(maxDecimals);
    let scaled = (n * divisor) / d;
    const remainder = n * divisor - scaled * d;
    if (remainder * 2n >= d) scaled += 1n;
    whole = scaled / divisor;
    fraction = (scaled % divisor).toString().padStart(maxDecimals, '0');
  }

  fraction = fraction.replace(/0+$/, '');
  const magnitude = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

/** Builds a quantity from a decimal string and a unit token. */
export function makeQuantity(decimal: string | number, unitToken: string): Quantity {
  const unit = unitInfo(unitToken);
  if (!unit) throw new QuantityError('unknown_unit', `unknown unit "${unitToken}"`);
  const text = typeof decimal === 'number' ? formatNumber(decimal) : decimal;
  const r = ratFromDecimal(text);
  if (!r) throw new QuantityError('unknown_unit', `invalid numeric value "${text}"`);
  const canonical = canonicalUnit(unitToken)!;
  return { unit: canonical, dimension: unit.dimension, r };
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new QuantityError('unknown_unit', `non-finite number ${String(value)}`);
  }
  return String(value);
}

export function quantityFromValue(value: QuantityValue): Quantity {
  return makeQuantity(value.value, value.unit);
}

export function quantityToValue(q: Quantity): QuantityValue {
  return { kind: 'number', value: ratToString(q.r), unit: q.unit };
}

export function formatQuantity(q: Quantity): string {
  const rendered = ratToString(q.r);
  return q.unit === 'count' ? rendered : `${rendered}${q.unit}`;
}

function dimensionFactor(unit: Unit): bigint {
  return unitInfo(unit)!.factor;
}

export function dimensionOf(unit: Unit): Dimension {
  return unitInfo(unit)!.dimension;
}

/** Value of `q` expressed in `unit`; requires the same dimension. */
export function convertQuantity(q: Quantity, unit: Unit): Rational {
  const target = unitInfo(unit);
  if (!target) throw new QuantityError('unknown_unit', `unknown unit "${unit}"`);
  if (target.dimension !== q.dimension) {
    throw new QuantityError(
      'unit_mismatch',
      `cannot convert ${q.dimension} (${formatQuantity(q)}) to ${target.dimension} (${unit})`,
    );
  }
  const from = dimensionFactor(q.unit);
  const to = target.factor;
  if (from === to) return q.r;
  return rational(q.r.n * from, q.r.d * to);
}

function align(a: Quantity, b: Quantity): [Rational, Rational] {
  if (a.dimension !== b.dimension) {
    throw new QuantityError(
      'unit_mismatch',
      `dimension mismatch: ${formatQuantity(a)} (${a.dimension}) vs ${formatQuantity(b)} (${b.dimension})`,
    );
  }
  return [a.r, convertQuantity(b, a.unit)];
}

export function addQuantities(a: Quantity, b: Quantity): Quantity {
  const [x, y] = align(a, b);
  return { unit: a.unit, dimension: a.dimension, r: ratAdd(x, y) };
}

export function subQuantities(a: Quantity, b: Quantity): Quantity {
  const [x, y] = align(a, b);
  return { unit: a.unit, dimension: a.dimension, r: ratSub(x, y) };
}

export function mulQuantities(a: Quantity, b: Quantity): Quantity {
  if (a.dimension === 'count') {
    return { unit: b.unit, dimension: b.dimension, r: ratMul(a.r, b.r) };
  }
  if (b.dimension === 'count') {
    return { unit: a.unit, dimension: a.dimension, r: ratMul(a.r, b.r) };
  }
  throw new QuantityError(
    'unit_mismatch',
    `cannot multiply ${a.dimension} (${formatQuantity(a)}) by ${b.dimension} (${formatQuantity(b)})`,
  );
}

export function divQuantities(a: Quantity, b: Quantity): Quantity {
  if (b.r.n === 0n) throw new QuantityError('division_by_zero', 'division by zero');
  if (b.dimension === 'count') {
    return { unit: a.unit, dimension: a.dimension, r: ratDiv(a.r, b.r) };
  }
  if (a.dimension === b.dimension) {
    return {
      unit: 'count',
      dimension: 'count',
      r: ratDiv(a.r, convertQuantity(b, a.unit)),
    };
  }
  throw new QuantityError(
    'unit_mismatch',
    `cannot divide ${a.dimension} (${formatQuantity(a)}) by ${b.dimension} (${formatQuantity(b)})`,
  );
}

export function compareQuantities(a: Quantity, b: Quantity): number {
  const [x, y] = align(a, b);
  return ratCmp(x, y);
}

export function equalQuantities(a: Quantity, b: Quantity): boolean {
  return compareQuantities(a, b) === 0;
}

const QUANTITY_TEXT = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-zA-Z]+)$/;

/** Parses `"250ms"`, `"1.5 GiB"`, `"3 count"`. Returns null when not quantity-like. */
export function parseQuantityText(text: string): Quantity | null {
  const match = QUANTITY_TEXT.exec(text.trim());
  if (!match) return null;
  const numeric = match[1]!;
  const unitToken = match[2]!;
  if (!isKnownUnit(unitToken)) return null;
  return makeQuantity(numeric, unitToken);
}
