/**
 * Algebra of single-segment languages.
 *
 * Languages:
 *   lit    — exactly one literal string
 *   int    — canonical decimal representations of integers in [min, max]
 *   chars  — strings of length [minLength, maxLength] over a char set
 *   any    — the universe of single non-empty segments
 *   minus  — base language with finitely many languages excluded
 *
 * `minus` keeps set difference closed and exact without enumerating whole
 * universes. A digit DP gives exact (non-)intersection for int x chars,
 * covering arbitrary integer ranges without iterating them.
 */
import { DecidabilityLimitError } from './errors.ts';
import type { SegmentLanguage } from './types.ts';

export const ANY: SegmentLanguage = { kind: 'any' };

/** Brute-force enumeration safety valve. Digit DP avoids this for ints. */
export const ENUM_CAP = 200_000;

/* ---------------- membership ---------------- */

export function member(lang: SegmentLanguage, segment: string): boolean {
  switch (lang.kind) {
    case 'lit':
      return lang.value === segment;
    case 'any':
      return segment.length > 0;
    case 'int':
      if (!canonicalIntString(segment)) return false;
      return intStringInRange(segment, lang.min, lang.max);
    case 'chars':
      return (
        segment.length >= lang.minLength &&
        segment.length <= lang.maxLength &&
        allCharsIn(segment, lang.chars)
      );
    case 'minus':
      return member(lang.base, segment) && !lang.exclusions.some((e) => member(e, segment));
  }
}

/* ---------------- containment (raw languages only) ---------------- */

export function contains(lang: SegmentLanguage, sub: SegmentLanguage): boolean {
  if (sub.kind === 'minus') {
    throw new Error('contains() does not support minus operands');
  }
  if (lang.kind === 'minus') {
    throw new Error('contains() does not support minus operands');
  }
  if (sub.kind === 'any') return lang.kind === 'any';
  if (lang.kind === 'any') return true;

  if (lang.kind === 'lit') return sub.kind === 'lit' && lang.value === sub.value;
  if (sub.kind === 'lit')
    return sub.value.length > 0 && member(lang, sub.value);

  if (lang.kind === 'int' && sub.kind === 'int') {
    return sub.min >= lang.min && sub.max <= lang.max;
  }
  if (lang.kind === 'chars' && sub.kind === 'chars') {
    return (
      sub.minLength >= lang.minLength &&
      sub.maxLength <= lang.maxLength &&
      isSubsetOfCharset(sub.chars, lang.chars)
    );
  }
  // Cross-kind: only tiny finite sets can be contained in another kind.
  if (sub.kind === 'int') {
    // int ⊆ chars: every canonical number in range must fit the charset
    return intContainedInChars(sub, lang.kind === 'chars' ? lang : null);
  }
  if (sub.kind === 'chars') {
    return finiteAll(sub, (s) => member(lang, s));
  }
  return false;
}

/* ---------------- intersection witness ---------------- */

/**
 * Return a segment belonging to both languages (canonical smallest),
 * or null when the languages are disjoint.
 */
export function intersectWitness(
  a: SegmentLanguage,
  b: SegmentLanguage,
): string | null {
  if (a.kind === 'minus') return minusIntersectWitness(a, b);
  if (b.kind === 'minus') return minusIntersectWitness(b, a);

  if (a.kind === 'any') return canonicalWitness(b);
  if (b.kind === 'any') return canonicalWitness(a);

  if (a.kind === 'lit') return member(b, a.value) ? a.value : null;
  if (b.kind === 'lit') return member(a, b.value) ? b.value : null;

  if (a.kind === 'int' && b.kind === 'int') {
    const lo = Math.max(a.min, b.min);
    const hi = Math.min(a.max, b.max);
    return lo <= hi ? String(lo) : null;
  }

  if (a.kind === 'chars' && b.kind === 'chars') {
    return firstCharsIntersection(a, b);
  }

  const intLang = a.kind === 'int' ? a : (b as Extract<SegmentLanguage, { kind: 'int' }>);
  const charsLang =
    a.kind === 'chars' ? a : (b as Extract<SegmentLanguage, { kind: 'chars' }>);
  return intCharsWitness(intLang, charsLang);
}

/** Smallest canonical element of a raw language. */
export function canonicalWitness(lang: SegmentLanguage): string {
  switch (lang.kind) {
    case 'lit':
      return lang.value;
    case 'int':
      return String(lang.min);
    case 'chars': {
      const ch = lang.chars[0];
      return ch.repeat(lang.minLength);
    }
    case 'any':
      return 'a';
    case 'minus':
      return minusCanonicalWitness(lang);
  }
}

/* ---------------- exact difference ---------------- */

/**
 * Exact partition of `a \\ b` into SegmentLanguage pieces.
 * `b` is always a raw cylinder language (never a minus) by construction.
 */
export function subtract(
  a: SegmentLanguage,
  b: SegmentLanguage,
): SegmentLanguage[] {
  if (b.kind === 'any') return [];

  if (a.kind === 'minus') {
    if (b.kind === 'lit' && !member(a.base, b.value)) return [a];
    const next: SegmentLanguage = {
      kind: 'minus',
      base: a.base,
      exclusions: [...a.exclusions, b],
    };
    return isEmpty(next) ? [] : [next];
  }

  if (a.kind === 'any') {
    // Universe minus a finite cylinder language: exact minus representation.
    const next: SegmentLanguage = { kind: 'minus', base: ANY, exclusions: [b] };
    return isEmpty(next) ? [] : [next];
  }

  if (a.kind === 'lit') {
    return member(b, a.value) ? [] : [a];
  }

  if (a.kind === 'int' && b.kind === 'int') {
    const pieces: SegmentLanguage[] = [];
    if (b.min > a.min) pieces.push({ kind: 'int', min: a.min, max: Math.min(a.max, b.min - 1) });
    if (b.max < a.max) pieces.push({ kind: 'int', min: Math.max(a.min, b.max + 1), max: a.max });
    return pieces.filter((p) => p.kind === 'int' && p.min <= p.max);
  }

  if (a.kind === 'chars' && b.kind === 'chars' && isSubsetOfCharset(b.chars, a.chars) &&
      b.minLength >= a.minLength && b.maxLength <= a.maxLength) {
    const next: SegmentLanguage = { kind: 'minus', base: a, exclusions: [b] };
    return isEmpty(next) ? [] : [next];
  }

  // All remaining cross/same-kind pairs: exact via minus representation.
  if (!intersectWitness(a, b)) return [a];
  const fallback: SegmentLanguage = { kind: 'minus', base: a, exclusions: [b] };
  return isEmpty(fallback) ? [] : [fallback];
}

/** True when a language has no elements. Minus languages are tested by scan. */
export function isEmpty(lang: SegmentLanguage): boolean {
  if (lang.kind === 'minus') {
    if (lang.base.kind === 'any') {
      return minusCanonicalWitnessOrNull(lang) === null;
    }
    for (const candidate of enumerate(lang.base)) {
      if (!lang.exclusions.some((e) => member(e, candidate))) return false;
    }
    return true;
  }
  if (lang.kind === 'int') return lang.min > lang.max;
  if (lang.kind === 'chars') return lang.minLength > lang.maxLength || lang.chars.length === 0;
  return false;
}

/* ---------------- finite enumeration (capped) ---------------- */

/** Iterate canonical elements of a raw finite language in canonical order. */
export function* enumerate(
  lang: SegmentLanguage,
  cap: number = ENUM_CAP,
): Generator<string> {
  if (lang.kind === 'lit') {
    yield lang.value;
    return;
  }
  if (lang.kind === 'int') {
    if (lang.max - lang.min + 1 > cap) {
      throw new DecidabilityLimitError(
        `enumeration of integer range size ${lang.max - lang.min + 1} exceeds cap ${cap}`,
        'ENUM_CAP_EXCEEDED',
      );
    }
    for (let n = lang.min; n <= lang.max; n++) yield String(n);
    return;
  }
  if (lang.kind === 'chars') {
    yield* enumerateCharset(lang, cap);
    return;
  }
  throw new Error(`cannot enumerate language of kind ${lang.kind}`);
}

function finiteAll(
  lang: Extract<SegmentLanguage, { kind: 'int' | 'chars' }>,
  pred: (s: string) => boolean,
): boolean {
  try {
    for (const s of enumerate(lang)) {
      if (!pred(s)) return false;
    }
    return true;
  } catch (e) {
    if (e instanceof DecidabilityLimitError) {
      throw new DecidabilityLimitError(
        'cross-kind containment needs enumeration beyond the decidability cap',
        'CONTAINMENT_CAP_EXCEEDED',
      );
    }
    throw e;
  }
}

/* ---------------- int x chars digit DP ---------------- */

function intCharsWitness(
  intLang: Extract<SegmentLanguage, { kind: 'int' }>,
  charsLang: Extract<SegmentLanguage, { kind: 'chars' }>,
): string | null {
  // Negative representations sort before non-negative ones; check them first.
  for (const sub of intSubRanges(intLang)) {
    const signLen = sub.sign === '-' ? 1 : 0;
    if (sub.sign === '-' && !charsLang.chars.includes('-')) continue;
    const minDigits = String(sub.min).length;
    const maxDigits = String(sub.max).length;
    for (let dlen = minDigits; dlen <= maxDigits; dlen++) {
      const total = dlen + signLen;
      if (total < charsLang.minLength || total > charsLang.maxLength) continue;
      const built = buildSmallestInt(sub.min, sub.max, charsLang, dlen);
      if (built !== null) return sub.sign + built;
    }
  }
  return null;
}

/** Exact int ⊆ chars test using range-aware digit DP at every length. */
function intContainedInChars(
  intLang: Extract<SegmentLanguage, { kind: 'int' }>,
  charsLang: Extract<SegmentLanguage, { kind: 'chars' }> | null,
): boolean {
  if (charsLang === null) return false;
  for (const sub of intSubRanges(intLang)) {
    const signLen = sub.sign === '-' ? 1 : 0;
    if (sub.sign === '-' && !charsLang.chars.includes('-')) return false;
    const minDigits = String(sub.min).length;
    const maxDigits = String(sub.max).length;
    for (let dlen = minDigits; dlen <= maxDigits; dlen++) {
      const total = dlen + signLen;
      if (total < charsLang.minLength || total > charsLang.maxLength) {
        if (lengthBounds(sub.min, sub.max, dlen) !== null) return false;
        continue;
      }
      if (!allNumbersCoveredAtLength(sub.min, sub.max, charsLang, dlen)) return false;
    }
  }
  return true;
}

/** Non-negative sub-ranges of [min, max] (the negative part is handled via -n). */
function intSubRanges(
  intLang: Extract<SegmentLanguage, { kind: 'int' }>,
): Array<{ sign: '' | '-'; min: number; max: number }> {
  const ranges: Array<{ sign: '' | '-'; min: number; max: number }> = [];
  if (intLang.min < 0) {
    // negative numbers -n with n in [max(1,-max), -min]
    ranges.push({ sign: '-', min: Math.max(1, -intLang.max), max: -intLang.min });
  }
  if (intLang.max >= 0) {
    ranges.push({ sign: '', min: Math.max(0, intLang.min), max: intLang.max });
  }
  return ranges;
}

interface LengthBounds {
  lower: string;
  upper: string;
}

function lengthBounds(
  min: number,
  max: number,
  len: number,
): LengthBounds | null {
  const lowForLen = len === 1 ? 0 : 10 ** (len - 1);
  const highForLen = 10 ** len - 1;
  const lo = Math.max(min, lowForLen);
  const hi = Math.min(max, highForLen);
  if (lo > hi) return null;
  return { lower: String(lo), upper: String(hi) };
}

function allNumbersCoveredAtLength(
  subMin: number,
  subMax: number,
  charsLang: Extract<SegmentLanguage, { kind: 'chars' }>,
  len: number,
): boolean {
  const bounds = lengthBounds(subMin, subMax, len);
  if (bounds === null) return true; // no number of this length in range
  const { lower, upper } = bounds;
  const allowed = new Set(charsLang.chars);

  // Explicit reachable tight-state set; every reachable digit must be allowed.
  let states: Array<[0 | 1, 0 | 1]> = [[1, 1]];
  for (let i = 0; i < len; i++) {
    const next = new Set<`${0 | 1},${0 | 1}`>();
    for (const [tl, th] of states) {
      const lo = tl ? Number(lower[i]) : 0;
      const hi = th ? Number(upper[i]) : 9;
      for (let d = lo; d <= hi; d++) {
        if (!allowed.has(String(d))) return false;
        next.add(`${(tl && d === lo ? 1 : 0) as 0 | 1},${(th && d === hi ? 1 : 0) as 0 | 1}`);
      }
    }
    states = [...next].map((s) => s.split(',').map(Number) as [0 | 1, 0 | 1]);
  }
  return true;
}

function buildSmallestInt(
  subMin: number,
  subMax: number,
  charsLang: Extract<SegmentLanguage, { kind: 'chars' }>,
  len: number,
): string | null {
  const bounds = lengthBounds(subMin, subMax, len);
  if (bounds === null) return null;
  const { lower, upper } = bounds;
  const allowed = new Set(charsLang.chars);

  // Feasibility DP over (tightLow, tightHigh) states. A state at position i
  // is feasible iff some digit allowed there leads to a feasible state i+1.
  const allStates: Array<`${0 | 1},${0 | 1}`> = ['0,0', '0,1', '1,0', '1,1'];
  const feasible: Array<Set<string>> = new Array(len + 1);
  feasible[len] = new Set(allStates);
  for (let i = len - 1; i >= 0; i--) {
    feasible[i] = new Set<string>();
    for (const state of allStates) {
      const [tl, th] = state.split(',').map(Number) as [0 | 1, 0 | 1];
      const lo = tl ? Number(lower[i]) : 0;
      const hi = th ? Number(upper[i]) : 9;
      for (let d = lo; d <= hi; d++) {
        if (!allowed.has(String(d))) continue;
        const ntl = (tl && d === lo ? 1 : 0) as 0 | 1;
        const nth = (th && d === hi ? 1 : 0) as 0 | 1;
        if (feasible[i + 1].has(`${ntl},${nth}`)) {
          feasible[i].add(state);
          break;
        }
      }
    }
  }
  if (!feasible[0].has('1,1')) return null;

  // Reconstruct the lexicographically smallest valid number.
  let tl: 0 | 1 = 1;
  let th: 0 | 1 = 1;
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const lo = tl ? Number(lower[i]) : 0;
    const hi = th ? Number(upper[i]) : 9;
    let picked = -1;
    for (let d = lo; d <= hi; d++) {
      if (!allowed.has(String(d))) continue;
      const ntl = (tl && d === lo ? 1 : 0) as 0 | 1;
      const nth = (th && d === hi ? 1 : 0) as 0 | 1;
      if (feasible[i + 1].has(`${ntl},${nth}`)) {
        picked = d;
        tl = ntl;
        th = nth;
        break;
      }
    }
    if (picked === -1) return null;
    out.push(String(picked));
  }
  return out.join('');
}

/* ---------------- charset enumeration ---------------- */

function* enumerateCharset(
  lang: Extract<SegmentLanguage, { kind: 'chars' }>,
  cap: number,
): Generator<string> {
  const alphabet = [...lang.chars].sort();
  let emitted = 0;
  for (let len = lang.minLength; len <= lang.maxLength; len++) {
    const total = alphabet.length ** len;
    if (emitted + total > cap) {
      throw new DecidabilityLimitError(
        `charset enumeration exceeds cap ${cap}`,
        'ENUM_CAP_EXCEEDED',
      );
    }
    yield* fixedLengthStrings(alphabet, len);
    emitted += total;
  }
}

function* fixedLengthStrings(alphabet: string[], len: number): Generator<string> {
  const idx = new Array<number>(len).fill(0);
  const total = alphabet.length ** len;
  for (let n = 0; n < total; n++) {
    yield idx.map((i) => alphabet[i]).join('');
    for (let p = len - 1; p >= 0; p--) {
      idx[p] += 1;
      if (idx[p] < alphabet.length) break;
      idx[p] = 0;
    }
  }
}

function firstCharsIntersection(
  a: Extract<SegmentLanguage, { kind: 'chars' }>,
  b: Extract<SegmentLanguage, { kind: 'chars' }>,
): string | null {
  const lo = Math.max(a.minLength, b.minLength);
  const hi = Math.min(a.maxLength, b.maxLength);
  if (lo > hi) return null;
  const alphabet = [...a.chars].filter((c) => b.chars.includes(c)).sort();
  if (alphabet.length === 0) return null;
  // smallest string at the shortest shared length
  return alphabet[0].repeat(lo);
}

/* ---------------- minus helpers ---------------- */

function minusIntersectWitness(
  m: Extract<SegmentLanguage, { kind: 'minus' }>,
  other: SegmentLanguage,
): string | null {
  if (m.base.kind === 'any') {
    for (const candidate of universeStrings()) {
      if (m.exclusions.some((e) => member(e, candidate))) continue;
      if (member(other, candidate)) return candidate;
    }
    return null;
  }
  for (const candidate of enumerate(m.base)) {
    if (m.exclusions.some((e) => member(e, candidate))) continue;
    if (member(other, candidate)) return candidate;
  }
  return null;
}

function minusCanonicalWitness(
  m: Extract<SegmentLanguage, { kind: 'minus' }>,
): string {
  const w = minusCanonicalWitnessOrNull(m);
  if (w === null) throw new Error('minus language has no canonical witness (empty set)');
  return w;
}

function minusCanonicalWitnessOrNull(
  m: Extract<SegmentLanguage, { kind: 'minus' }>,
): string | null {
  if (m.base.kind === 'any') {
    for (const candidate of universeStrings()) {
      if (!m.exclusions.some((e) => member(e, candidate))) return candidate;
    }
    return null;
  }
  for (const candidate of enumerate(m.base)) {
    if (!m.exclusions.some((e) => member(e, candidate))) return candidate;
  }
  return null;
}

/** Short strings over a fixed alphabet, used to witness minus(any, ...). */
function* universeStrings(): Generator<string> {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  yield* alphabet;
  for (const a of alphabet) {
    for (const b of alphabet) yield a + b;
  }
  // Exclusions are finite; longer strings are never all excluded.
  for (const a of alphabet) {
    for (const b of alphabet) {
      for (const c of alphabet) yield a + b + c;
    }
  }
}

/* ---------------- small utilities ---------------- */

export function canonicalIntString(s: string): boolean {
  if (!/^-?\d+$/.test(s)) return false;
  if (s.length > 1 && s[0] === '0') return false;
  // "-0" (and "-007") are not canonical decimal representations
  if (s[0] === '-' && s[1] === '0') return false;
  return true;
}

/** Compare a canonical decimal string against an inclusive safe-integer range. */
function intStringInRange(s: string, min: number, max: number): boolean {
  const n = Number(s);
  if (Number.isSafeInteger(n)) return n >= min && n <= max;
  // Fallback for magnitudes beyond safe integers: signed lexicographic order.
  const cmp = (a: string, b: string): number => {
    const negA = a[0] === '-';
    const negB = b[0] === '-';
    if (negA !== negB) return negA ? -1 : 1;
    const digitsA = negA ? a.slice(1) : a;
    const digitsB = negB ? b.slice(1) : b;
    if (digitsA.length !== digitsB.length) {
      const byLen = Math.sign(digitsA.length - digitsB.length);
      return negA ? -byLen : byLen;
    }
    const lex = digitsA.localeCompare(digitsB);
    return negA ? -lex : lex;
  };
  return cmp(s, String(min)) >= 0 && cmp(s, String(max)) <= 0;
}

function allCharsIn(s: string, charset: string): boolean {
  for (const ch of s) if (!charset.includes(ch)) return false;
  return true;
}

function isSubsetOfCharset(sub: string, sup: string): boolean {
  for (const ch of sub) if (!sup.includes(ch)) return false;
  return true;
}
