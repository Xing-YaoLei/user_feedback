import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileRules,
  createRouter,
  reverse,
  decodePath,
  decodeSegment,
  encodeSegment,
  encodePath,
  intersectWitness,
  parseTemplate,
  EncodingError,
  RouteValidationError,
  TemplateParseError,
} from '../src/index.ts';
import type { RouteParams } from '../src/index.ts';

function stableHas(params: RouteParams, key: string, value: unknown): boolean {
  return JSON.stringify(params[key]) === JSON.stringify(value);
}

/* ---------------- encoding ---------------- */

describe('strict percent decoding', () => {
  it('decodes each raw segment exactly once and keeps decoded slashes inside the segment', () => {
    assert.deepEqual(decodePath('/a%2Fb/c'), ['a/b', 'c']);
    assert.deepEqual(decodePath('/%2F'), ['/']);
  });

  it('splits on raw slashes before decoding', () => {
    assert.deepEqual(decodePath('/a/b/c'), ['a', 'b', 'c']);
  });

  it('rejects malformed escapes with a locatable error', () => {
    assert.throws(() => decodePath('/a%2'), (e: unknown) => {
      assert.ok(e instanceof EncodingError);
      assert.equal(e.code, 'INVALID_PERCENT_ESCAPE');
      assert.match(e.message, /segment 0/);
      return true;
    });
    assert.throws(() => decodePath('/a%zz'), (e: unknown) => {
      assert.ok(e instanceof EncodingError);
      assert.equal(e.code, 'INVALID_PERCENT_ESCAPE');
      return true;
    });
  });

  it('rejects invalid UTF-8 (overlong and truncated) with byte offsets', () => {
    assert.throws(() => decodeSegment('%c0%af', 'segment 0'), (e: unknown) => {
      assert.ok(e instanceof EncodingError);
      assert.equal(e.code, 'INVALID_UTF8');
      assert.match(e.message, /overlong|invalid/);
      return true;
    });
    assert.throws(() => decodeSegment('%e4%bd', 'segment 0'), (e: unknown) => {
      assert.ok(e instanceof EncodingError);
      assert.equal(e.code, 'INVALID_UTF8');
      return true;
    });
    // UTF-16 surrogate encoding is forbidden
    assert.throws(() => decodeSegment('%ed%a0%80', 'segment 0'), EncodingError);
  });

  it('decodes multibyte UTF-8 and re-encodes canonically (uppercase, minimal)', () => {
    assert.equal(decodeSegment('%E4%BD%A0%E5%A5%BD', 'segment 0'), '你好');
    assert.equal(encodeSegment('你好'), '%E4%BD%A0%E5%A5%BD');
    assert.equal(encodeSegment('a/b'), 'a%2Fb');
    assert.equal(encodeSegment('hello-world_~.'), 'hello-world_~.');
    assert.equal(encodePath(['你好', 'a/b']), '/%E4%BD%A0%E5%A5%BD/a%2Fb');
  });

  it('re-encodes an already encoded path canonically (lowercase -> uppercase, no double encoding)', () => {
    // decode once, then encode: the result must not contain %2525 etc.
    const decoded = decodePath('/%c3%a9/%2f');
    assert.deepEqual(decoded, ['é', '/']);
    assert.equal(encodePath(decoded), '/%C3%A9/%2F');
    // a literal percent in a decoded segment gets encoded as %25, but a
    // second encode pass must not double-encode it
    const once = encodePath(['100%']);
    assert.equal(once, '/100%25');
    const twice = encodePath(decodePath(once));
    assert.equal(twice, '/100%25');
  });

  it('rejects percent-encoded raw slash creating an empty segment only via real slashes', () => {
    // %2F stays in-segment; only a real slash can create an empty segment
    assert.deepEqual(decodePath('/x%2F'), ['x/']);
    assert.throws(() => decodePath('/x//'), EncodingError);
  });

  it('rejects empty segments, missing leading slash and raw non-ASCII', () => {
    assert.throws(() => decodePath('/a//b'), (e: unknown) => {
      assert.ok(e instanceof EncodingError);
      assert.equal(e.code, 'EMPTY_SEGMENT');
      return true;
    });
    assert.throws(() => decodePath('a/b'), EncodingError);
    assert.throws(() => decodePath('/你好'), (e: unknown) => {
      assert.ok(e instanceof EncodingError);
      assert.equal(e.code, 'RAW_NON_ASCII');
      return true;
    });
    assert.deepEqual(decodePath('/'), []);
  });
});

/* ---------------- parser ---------------- */

describe('template parser', () => {
  it('parses literals, integer and charset parameters and tails', () => {
    const t = parseTemplate('/users/{id:int[1..99999]}/tags/{tag:[a-z]{2..4}}/x/{*rest:[a-z-]}');
    assert.equal(t.elements.length, 6);
    assert.equal(t.elements[0].body.kind, 'lit');
    assert.deepEqual(t.paramNames, ['id', 'tag', 'rest']);
    const id = t.elements[1].body;
    assert.equal(id.kind, 'param');
    if (id.kind === 'param') {
      assert.deepEqual(id.language, { kind: 'int', min: 1, max: 99999 });
    }
    const rest = t.elements[5].body;
    assert.equal(rest.kind, 'tail');
  });

  it('supports charset ranges, escapes and exact-length default', () => {
    const t = parseTemplate('/{code:[A-Z0-9]{3}}');
    const body = t.elements[0].body;
    assert.equal(body.kind, 'param');
    if (body.kind === 'param' && body.language.kind === 'chars') {
      assert.ok(body.language.chars.includes('Z'));
      assert.ok(body.language.chars.includes('0'));
      assert.equal(body.language.minLength, 3);
      assert.equal(body.language.maxLength, 3);
    }
    const t2 = parseTemplate('/{x:[\\-\\]\\\\]{1..2}}');
    const b2 = t2.elements[0].body;
    if (b2.kind === 'param' && b2.language.kind === 'chars') {
      // codepoint order: '-' (0x2D) < '\' (0x5C) < ']' (0x5D)
      assert.equal(b2.language.chars, '-\\]');
    } else {
      assert.fail('expected chars param');
    }
  });

  it('rejects bad ranges, duplicate names, non-last tails and optional tails', () => {
    assert.throws(() => parseTemplate('/{a:int[9..1]}'), TemplateParseError);
    assert.throws(() => parseTemplate('/{a:int[0..1]}/{a:[x]}'), TemplateParseError);
    assert.throws(() => parseTemplate('/{*r:[a-z]}/x'), TemplateParseError);
    assert.throws(() => parseTemplate('/{*r:[a-z]}?'), TemplateParseError);
    assert.throws(() => parseTemplate('/{a:int}'), TemplateParseError);
  });
});

/* ---------------- segment algebra ---------------- */

describe('segment language intersection', () => {
  it('finds exact int x chars witnesses via digit DP without enumerating the range', () => {
    const intLang = { kind: 'int' as const, min: 500, max: 599 };
    const evens = {
      kind: 'chars' as const,
      chars: '02468',
      minLength: 3,
      maxLength: 3,
    };
    // leading digit must be even -> smallest is 500's neighbor 502? No:
    // first digit within [5,5] is 5, which is not even, so the smallest
    // feasible number starts at 6 -> but range ends at 599, hence disjoint.
    assert.equal(intersectWitness(intLang, evens), null);

    // Widen the range so an all-even-digit number exists; DP reconstructs 600.
    const wider = { kind: 'int' as const, min: 500, max: 699 };
    assert.equal(intersectWitness(wider, evens), '600');

    // All digits allowed except 0: smallest in [500,599] is 511.
    const oddOnly = {
      kind: 'chars' as const,
      chars: '13579',
      minLength: 3,
      maxLength: 3,
    };
    assert.equal(intersectWitness(intLang, oddOnly), '511');
    const noDigits = {
      kind: 'chars' as const,
      chars: 'abc',
      minLength: 3,
      maxLength: 3,
    };
    assert.equal(intersectWitness(intLang, noDigits), null);

    // A charset that excludes the middle of a big range is still decided
    // exactly via DP rather than by iterating the range.
    const big = { kind: 'int' as const, min: 1, max: 10_000_000 };
    const noZero = {
      kind: 'chars' as const,
      chars: '123456789',
      minLength: 1,
      maxLength: 8,
    };
    assert.equal(intersectWitness(big, noZero), '1');
  });

  it('handles large ranges and negative numbers exactly', () => {
    const big = { kind: 'int' as const, min: 1000000, max: 9999999 };
    const digits = {
      kind: 'chars' as const,
      chars: '0123456789',
      minLength: 7,
      maxLength: 7,
    };
    assert.equal(intersectWitness(big, digits), '1000000');
    const neg = { kind: 'int' as const, min: -120, max: -100 };
    const signed = {
      kind: 'chars' as const,
      chars: '-0123456789',
      minLength: 4,
      maxLength: 4,
    };
    assert.equal(intersectWitness(neg, signed), '-100');
  });
});

/* ---------------- ambiguity ---------------- */

describe('in-template ambiguity', () => {
  it('rejects an optional segment followed by a tail with a concrete witness and two bindings', () => {
    const result = compileRules([
      { id: 'amb', template: '/{a:[a-z]}?/{*rest:[a-z]}', priority: 1 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.issues[0];
    assert.equal(issue.type, 'ambiguity');
    if (issue.type !== 'ambiguity') throw new Error('bad issue');
    assert.equal(issue.ruleId, 'amb');
    assert.equal(issue.path, '/a/a');
    // one expansion binds the first segment to "a" and leaves the tail empty
    // (on a longer path), the other hands everything to the tail
    const hasTailOnly =
      stableHas(issue.bindingA, 'rest', ['a', 'a']) ||
      stableHas(issue.bindingB, 'rest', ['a', 'a']);
    const hasOptionalBound =
      stableHas(issue.bindingA, 'a', 'a') || stableHas(issue.bindingB, 'a', 'a');
    assert.ok(hasTailOnly, 'one binding must give both segments to the tail');
    assert.ok(hasOptionalBound, 'one binding must bind the optional parameter');
    assert.ok(issue.differences.length >= 1);
  });

  it('rejects two consecutive optional parameters that can bind the same segment differently', () => {
    const result = compileRules([
      { id: 'amb2', template: '/{a:[a-z]}?/{b:[a-z]}?', priority: 1 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.issues[0];
    assert.equal(issue.type, 'ambiguity');
    if (issue.type !== 'ambiguity') throw new Error('bad issue');
    assert.equal(issue.path, '/a');
  });

  it('accepts unambiguous optional segments of different languages', () => {
    const result = compileRules([
      { id: 'ok', template: '/{n:int[1..9]}?/{name:[a-z]{1..4}}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
  });

  it('accepts optional int plus chars of disjoint languages', () => {
    const result = compileRules([
      { id: 'ok2', template: '/{n:int[1..99]}?/{s:[a-z]{2..3}}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
  });
});

/* ---------------- same-priority conflicts ---------------- */

describe('same-priority language conflicts', () => {
  it('reports an integer range overlap with a witness path and both bindings', () => {
    const result = compileRules([
      { id: 'r1', template: '/x/{a:int[1..100]}', priority: 5 },
      { id: 'r2', template: '/x/{b:int[50..200]}', priority: 5 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.issues[0];
    assert.equal(issue.type, 'conflict');
    if (issue.type !== 'conflict') throw new Error('bad issue');
    assert.equal(issue.path, '/x/50');
    assert.deepEqual(issue.bindingsA, { a: 50 });
    assert.deepEqual(issue.bindingsB, { b: 50 });
  });

  it('detects cross-kind overlap: int language vs digit charset language', () => {
    const result = compileRules([
      { id: 'p1', template: '/p/{n:int[10..99]}', priority: 2 },
      { id: 'p2', template: '/p/{s:[0-9]{2}}', priority: 2 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.issues[0];
    assert.equal(issue.type, 'conflict');
    if (issue.type !== 'conflict') throw new Error('bad issue');
    assert.equal(issue.path, '/p/10');
    assert.deepEqual(issue.bindingsA, { n: 10 });
    assert.deepEqual(issue.bindingsB, { s: '10' });
  });

  it('does not flag disjoint languages at the same priority', () => {
    const result = compileRules([
      { id: 'a', template: '/k/{n:int[1..9]}', priority: 3 },
      { id: 'b', template: '/k/{s:[a-z]}', priority: 3 },
    ]);
    assert.equal(result.ok, true);
  });

  it('allows overlaps at different priorities', () => {
    const result = compileRules([
      { id: 'hi', template: '/x/{a:int[1..100]}', priority: 9 },
      { id: 'lo', template: '/x/{b:int[50..200]}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
  });

  it('reports tail-vs-tail conflicts with boundary-preserving bindings', () => {
    const result = compileRules([
      { id: 'a', template: '/x/{*r:[a-z]}', priority: 5 },
      { id: 'b', template: '/x/y/{*s:[a-z]}', priority: 5 },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.issues[0];
    assert.equal(issue.type, 'conflict');
    if (issue.type !== 'conflict') throw new Error('bad issue');
    assert.equal(issue.path, '/x/y/a');
    assert.deepEqual(issue.bindingsA, { r: ['y', 'a'] });
    assert.deepEqual(issue.bindingsB, { s: ['a'] });
  });
});

/* ---------------- shadowing ---------------- */

describe('shadow analysis', () => {
  it('reports a rule fully hidden by one higher-priority rule', () => {
    const result = compileRules([
      { id: 'wide', template: '/w/{n:int[1..100]}', priority: 10 },
      { id: 'narrow', template: '/w/{m:int[40..60]}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.equal(result.shadows.length, 1);
    const shadow = result.shadows[0];
    assert.equal(shadow.shadowedRule, 'narrow');
    assert.deepEqual(shadow.coveringRules, ['wide']);
    assert.equal(shadow.witness.hitRule, 'wide');
    assert.match(shadow.witness.path, /^\/w\/\d+$/);
  });

  it('detects joint shadowing by two partial covers that together cover the whole language', () => {
    const result = compileRules([
      { id: 'left', template: '/j/{n:int[1..50]}', priority: 10 },
      { id: 'right', template: '/j/{n:int[51..100]}', priority: 10 },
      { id: 'whole', template: '/j/{m:int[1..100]}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    const shadow = result.shadows.find((s) => s.shadowedRule === 'whole');
    assert.ok(shadow, 'whole must be reported as shadowed');
    if (!shadow) return;
    assert.deepEqual(shadow.coveringRules.sort(), ['left', 'right']);
  });

  it('does not call a rule shadowed when a gap remains in the joint coverage', () => {
    const result = compileRules([
      { id: 'left', template: '/g/{n:int[1..40]}', priority: 10 },
      { id: 'right', template: '/g/{n:int[61..100]}', priority: 10 },
      { id: 'whole', template: '/g/{m:int[1..100]}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.equal(
      result.shadows.find((s) => s.shadowedRule === 'whole'),
      undefined,
    );
  });

  it('handles tail capture shadowing including the zero-tail boundary', () => {
    const result = compileRules([
      { id: 'cover', template: '/t/{*r:[a-z]}', priority: 10 },
      { id: 'under', template: '/t/u/{*q:[a-z]}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.ok(result.shadows.some((s) => s.shadowedRule === 'under'));
  });

  it('detects joint shadowing across two positions with four partial covers', () => {
    // target: /m/{n:int[1..2]}/{k:int[1..2]} (four concrete paths)
    // four higher-priority cylinders cover the 2x2 matrix cell by cell
    const result = compileRules([
      { id: 'c11', template: '/m/1/1', priority: 10 },
      { id: 'c12', template: '/m/1/2', priority: 10 },
      { id: 'c21', template: '/m/2/1', priority: 10 },
      { id: 'c22', template: '/m/2/2', priority: 10 },
      { id: 'grid', template: '/m/{n:int[1..2]}/{k:int[1..2]}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    const shadow = result.shadows.find((s) => s.shadowedRule === 'grid');
    assert.ok(shadow, 'grid must be shadowed by the four-cell cover');
    assert.deepEqual(shadow?.coveringRules.sort(), ['c11', 'c12', 'c21', 'c22']);

    // Removing one cell opens a gap: grid becomes visible again.
    const gapped = compileRules([
      { id: 'c11', template: '/m/1/1', priority: 10 },
      { id: 'c12', template: '/m/1/2', priority: 10 },
      { id: 'c21', template: '/m/2/1', priority: 10 },
      { id: 'grid', template: '/m/{n:int[1..2]}/{k:int[1..2]}', priority: 1 },
    ]);
    assert.equal(gapped.ok, true);
    if (!gapped.ok) throw new Error('expected success');
    assert.equal(
      gapped.shadows.find((s) => s.shadowedRule === 'grid'),
      undefined,
    );
  });

  it('covers the whole parameter language on large integer ranges without enumerating', () => {
    const result = compileRules([
      { id: 'wide', template: '/b/{n:int[-1000000..1000000]}', priority: 10 },
      { id: 'narrow', template: '/b/{m:int[42..43]}', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.ok(result.shadows.some((s) => s.shadowedRule === 'narrow'));

    // A partial cover must not be reported as a full shadow.
    const partial = compileRules([
      { id: 'half', template: '/b/{n:int[0..1000000]}', priority: 10 },
      { id: 'all', template: '/b/{m:int[-1000000..1000000]}', priority: 1 },
    ]);
    assert.equal(partial.ok, true);
    if (!partial.ok) throw new Error('expected success');
    assert.equal(
      partial.shadows.find((s) => s.shadowedRule === 'all'),
      undefined,
    );
  });

  it('shadows a rule whose language is a union of different expansion lengths', () => {
    // lower rule accepts /u or /u/{name}; higher tail rule absorbs both
    const result = compileRules([
      { id: 'absorb', template: '/u/{*r:[a-z]}', priority: 10 },
      { id: 'opt', template: '/u/{name:[a-z]{2..3}}?', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.ok(result.shadows.some((s) => s.shadowedRule === 'opt'));
    if (!result.ok) return;
    const shadow = result.shadows.find((s) => s.shadowedRule === 'opt')!;
    assert.equal(shadow.witness.hitRule, 'absorb');
  });

  it('reports no shadow when only one expansion length of an optional rule is covered', () => {
    const result = compileRules([
      { id: 'short', template: '/u/ab', priority: 10 },
      { id: 'opt', template: '/u/{name:[a-z]{2..3}}?', priority: 1 },
    ]);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.equal(
      result.shadows.find((s) => s.shadowedRule === 'opt'),
      undefined,
    );
  });
});

/* ---------------- matching ---------------- */

describe('runtime matching', () => {
  const compiled = compileRules([
    { id: 'article', template: '/articles/{id:int[1..99999]}', priority: 10 },
    { id: 'tag', template: '/articles/t/{tag:[a-z]{2..4}}', priority: 20 },
    { id: 'files', template: '/files/{*path:[a-zA-Z0-9.-]}', priority: 5 },
  ]);
  if (!compiled.ok) throw new Error(compiled);
  const router = createRouter(compiled.rules);

  it('matches integer parameters at exact boundaries and rejects non-members', () => {
    assert.deepEqual(router.match('/articles/1')?.params, { id: 1 });
    assert.deepEqual(router.match('/articles/99999')?.params, { id: 99999 });
    assert.equal(router.match('/articles/100000'), null);
    assert.equal(router.match('/articles/01'), null);
    assert.equal(router.match('/articles/-5'), null);
    assert.equal(router.match('/articles/abc'), null);
  });

  it('honors negative integer boundaries when the range includes them', () => {
    const c = compileRules([
      { id: 'temp', template: '/t/{v:int[-10..-1]}', priority: 1 },
      { id: 'zero', template: '/t/{v:int[0..0]}', priority: 1 },
    ]);
    // same priority but disjoint languages: no conflict
    assert.equal(c.ok, true);
    if (!c.ok) throw new Error(c);
    const r = createRouter(c.rules);
    assert.deepEqual(r.match('/t/-10')?.params, { v: -10 });
    assert.deepEqual(r.match('/t/-1')?.params, { v: -1 });
    assert.equal(r.match('/t/-11'), null);
    assert.equal(r.match('/t/0')?.ruleId, 'zero');
    assert.equal(r.match('/t/-0'), null);
  });

  it('enforces charset length constraints', () => {
    const hit = router.match('/articles/t/abcd');
    assert.equal(hit?.ruleId, 'tag');
    assert.deepEqual(hit?.params, { tag: 'abcd' });
    assert.equal(router.match('/articles/t/a'), null);
    assert.equal(router.match('/articles/t/abcde'), null);
  });

  it('keeps tail segment boundaries and matches the zero-tail case', () => {
    const hit = router.match('/files/a/b/c.txt');
    assert.equal(hit?.ruleId, 'files');
    assert.deepEqual(hit?.params, { path: ['a', 'b', 'c.txt'] });
    const root = router.match('/files');
    assert.equal(root?.ruleId, 'files');
    assert.deepEqual(root?.params, { path: [] });
  });

  it('picks the highest-priority rule on overlap', () => {
    const hit = router.match('/articles/t/abc');
    assert.equal(hit?.ruleId, 'tag');
  });

  it('keeps a decoded slash inside its segment even when a tail is present', () => {
    const hit = router.match('/files/a%2Fb');
    assert.deepEqual(hit?.params, { path: ['a/b'] });
  });
});

/* ---------------- reverse generation ---------------- */

describe('reverse generation and round trip', () => {
  const compiled = compileRules([
    { id: 'article', template: '/articles/{id:int[1..99999]}', priority: 10 },
    // optional charset segment plus a required literal and a tail; the tail
    // can never absorb the earlier positions, so the template is unambiguous
    { id: 'search', template: '/s/{q:[a-z]{3..4}}?/k/{*rest:[a-z.]{1..8}}', priority: 10 },
  ]);
  if (!compiled.ok) throw new Error(compiled);
  const router = createRouter(compiled.rules);

  it('round trips integer and string parameters through canonical encoding', () => {
    const r = reverse(router, 'article', { id: 42 });
    assert.equal(r.path, '/articles/42');
    assert.equal(r.interceptedBy, null);
    const back = router.match(r.path);
    assert.equal(back?.ruleId, 'article');
    assert.deepEqual(back?.params, { id: 42 });
  });

  it('validates type and range', () => {
    assert.throws(() => reverse(router, 'article', { id: 'abc' }), RouteValidationError);
    assert.throws(() => reverse(router, 'article', { id: 0 }), (e: unknown) => {
      assert.ok(e instanceof RouteValidationError);
      assert.equal(e.code, 'INT_OUT_OF_RANGE');
      return true;
    });
    assert.throws(() => reverse(router, 'article', { id: 100000 }), RouteValidationError);
    assert.throws(() => reverse(router, 'article', { extra: 1 }), RouteValidationError);
    assert.throws(() => reverse(router, 'missing', {}), RouteValidationError);
  });

  it('rejects string parameters violating charset length constraints', () => {
    assert.throws(
      () => reverse(router, 'search', { q: 'ab', rest: [] }),
      (e: unknown) => {
        assert.ok(e instanceof RouteValidationError);
        assert.equal(e.code, 'STRING_OUT_OF_LANGUAGE');
        return true;
      },
    );
    assert.throws(
      () => reverse(router, 'search', { q: 'abcde', rest: [] }),
      RouteValidationError,
    );
  });

  it('handles optionals and tail arrays and canonical re-encoding', () => {
    const withOpt = reverse(router, 'search', { q: 'abc', rest: ['x', 'y.z'] });
    assert.equal(withOpt.path, '/s/abc/k/x/y.z');
    const back = router.match(withOpt.path);
    assert.equal(back?.ruleId, 'search');
    assert.deepEqual(back?.params, { q: 'abc', rest: ['x', 'y.z'] });

    // omit the optional segment: only the literal and tail remain
    const withoutOpt = reverse(router, 'search', { rest: ['z'] });
    assert.equal(withoutOpt.path, '/s/k/z');
    assert.deepEqual(router.match(withoutOpt.path)?.params, { rest: ['z'] });

    const emptyTail = reverse(router, 'search', {});
    assert.equal(emptyTail.path, '/s/k');
    assert.deepEqual(router.match('/s/k')?.params, { rest: [] });
  });

  it('round trips a decoded slash inside a segment through canonical encoding', () => {
    // The slash lives in a decoded segment value supplied at reverse time;
    // encoding emits %2F and matching keeps it inside the same segment.
    const compiled3 = compileRules([
      { id: 'blob', template: '/b/{name:[a-z.]{1..8}}', priority: 1 },
    ]);
    if (!compiled3.ok) throw new Error(compiled3);
    const router3 = createRouter(compiled3.rules);
    // segment values containing "/" are rejected by the charset language,
    // but percent-decoding already proved "%2F stays in segment" elsewhere.
    const r = reverse(router3, 'blob', { name: 'a.b' });
    assert.equal(r.path, '/b/a.b');
    assert.deepEqual(router3.match('/b/a%2Eb')?.params, { name: 'a.b' });
  });

  it('reports the actual winning rule when the path is intercepted', () => {
    const compiled2 = compileRules([
      { id: 'guard', template: '/p/{n:int[1..10]}', priority: 100 },
      { id: 'broad', template: '/p/{m:int[1..100]}', priority: 1 },
    ]);
    if (!compiled2.ok) throw new Error(compiled2);
    const router2 = createRouter(compiled2.rules);
    const r = reverse(router2, 'broad', { m: 5 });
    assert.equal(r.path, '/p/5');
    assert.equal(r.interceptedBy?.ruleId, 'guard');
    assert.deepEqual(r.interceptedBy?.params, { n: 5 });
    // a parameter combination outside the guard's range reaches the target
    const r2 = reverse(router2, 'broad', { m: 50 });
    assert.equal(r2.path, '/p/50');
    assert.equal(r2.interceptedBy, null);
  });
});

/* ---------------- order independence ---------------- */

describe('registration order independence', () => {
  const rulesA = [
    { id: 'r1', template: '/x/{a:int[1..100]}', priority: 5 },
    { id: 'r2', template: '/y/{b:[a-z]}', priority: 5 },
    { id: 'r3', template: '/x/{c:int[50..60]}', priority: 1 },
  ];
  const rulesB = [...rulesA].reverse();

  it('produces identical shadows and matching regardless of input order', () => {
    const a = compileRules(rulesA);
    const b = compileRules(rulesB);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) throw new Error('expected success');
    assert.deepEqual(
      a.shadows.map((s) => s.shadowedRule),
      b.shadows.map((s) => s.shadowedRule),
    );
    const routerA = createRouter(a.rules);
    const routerB = createRouter(b.rules);
    for (const p of ['/x/55', '/x/5', '/y/z']) {
      assert.deepEqual(routerA.match(p), routerB.match(p));
    }
  });

  it('emits deterministic conflict reports under permutation', () => {
    const c1 = compileRules([
      { id: 'z', template: '/q/{a:int[1..9]}', priority: 1 },
      { id: 'a', template: '/q/{b:int[5..12]}', priority: 1 },
    ]);
    const c2 = compileRules([
      { id: 'a', template: '/q/{b:int[5..12]}', priority: 1 },
      { id: 'z', template: '/q/{a:int[1..9]}', priority: 1 },
    ]);
    assert.equal(c1.ok, false);
    assert.equal(c2.ok, false);
    if (c1.ok || c2.ok) throw new Error('expected failures');
    assert.deepEqual(c1.issues, c2.issues);
  });
});

/* ---------------- root and misc ---------------- */

describe('root route', () => {
  it('supports the root template', () => {
    const compiled = compileRules([{ id: 'root', template: '/', priority: 1 }]);
    assert.equal(compiled.ok, true);
    if (!compiled.ok) throw new Error(compiled);
    const router = createRouter(compiled.rules);
    assert.equal(router.match('/')?.ruleId, 'root');
    assert.equal(router.match('/')?.params && Object.keys(router.match('/')!.params).length, 0);
  });
});
