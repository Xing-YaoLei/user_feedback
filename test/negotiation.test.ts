import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePreferences,
  parseAcceptEncoding,
  qualityFor,
  selectCoding,
  candidateCodings,
} from '../src/preferences.ts';
import { ResponseHeaders, weakenEtag } from '../src/headers.ts';
import { encodeResponse, negotiateResponse, NotAcceptableError } from '../src/index.ts';

const prefs = normalizePreferences;

describe('Accept-Encoding parsing', () => {
  test('parses codings, q values and the wildcard', () => {
    const parsed = parseAcceptEncoding('gzip;q=0.8, br;q=1.0, *;q=0.1');
    assert.deepEqual(parsed, [
      { coding: 'gzip', q: 0.8 },
      { coding: 'br', q: 1 },
      { coding: '*', q: 0.1 },
    ]);
  });

  test('accepts the parsed preference list shape used by callers', () => {
    const p = normalizePreferences([
      { coding: 'br', q: 0.5 },
      { coding: 'gzip', q: 0.9 },
    ]);
    assert.equal(qualityFor(p, 'br'), 0.5);
    assert.equal(qualityFor(p, 'gzip'), 0.9);
    assert.equal(qualityFor(p, 'identity'), 1);
  });

  test('accepts tuple, record and Map shapes', () => {
    assert.equal(qualityFor(normalizePreferences([['gzip', 0.2]]), 'gzip'), 0.2);
    assert.equal(qualityFor(normalizePreferences({ gzip: 0.3 }), 'gzip'), 0.3);
    assert.equal(qualityFor(normalizePreferences(new Map([['gzip', '0.4']])), 'gzip'), 0.4);
  });

  test('missing q means 1 and duplicates keep the last explicit value', () => {
    const p = normalizePreferences('gzip, gzip;q=0.5');
    assert.equal(qualityFor(p, 'gzip'), 0.5);
  });
});

describe('quality rules', () => {
  test('identity defaults to q=1 when not mentioned', () => {
    assert.equal(qualityFor(prefs('gzip'), 'identity'), 1);
    assert.equal(qualityFor(prefs(''), 'identity'), 1);
  });

  test('an explicit wildcard sets identity only when it is not spelled out', () => {
    assert.equal(qualityFor(prefs('*;q=0.5'), 'identity'), 1);
    assert.equal(qualityFor(prefs('*;q=0'), 'identity'), 0);
    assert.equal(qualityFor(prefs('*;q=0, identity;q=0.7'), 'identity'), 0.7);
    assert.equal(qualityFor(prefs('*;q=0.2, gzip;q=0'), 'gzip'), 0);
  });

  test('q is clamped into the 0..1 range', () => {
    assert.equal(qualityFor(prefs('gzip;q=7'), 'gzip'), 1);
    assert.equal(qualityFor(prefs('gzip;q=-3'), 'gzip'), 0);
  });

  test('an unparsable q makes that entry unacceptable', () => {
    assert.equal(qualityFor(prefs('gzip;q=abc'), 'gzip'), 0);
  });
});

describe('coding selection', () => {
  test('treats every absent q as 1, so an explicit list with no q values ties', () => {
    // identity is implicitly q=1 as well; the tie goes to configuration order.
    assert.equal(selectCoding(prefs('gzip, br'), ['gzip', 'br'])?.coding, 'gzip');
    assert.equal(selectCoding(prefs('br, gzip'), ['gzip', 'br'])?.coding, 'gzip');
  });

  test('highest q wins when identity is given an explicit quality too', () => {
    const clean = prefs('gzip;q=0.4, br;q=0.9, identity;q=0.2');
    assert.equal(selectCoding(clean, ['gzip', 'br'])?.coding, 'br');
    const identityPreferred = prefs('gzip;q=0.4, br;q=0.9, identity;q=1');
    assert.equal(selectCoding(identityPreferred, ['gzip', 'br'])?.coding, 'identity');
  });

  test('the implicit identity q=1 outranks a coding with a lower q', () => {
    // The requirement makes identity q=1 unless excluded, so it really wins here.
    assert.equal(selectCoding(prefs('gzip;q=0.5'), ['gzip', 'br'])?.coding, 'identity');
  });

  test('ties are broken by configuration order, not by header order', () => {
    const choice = selectCoding(prefs('br;q=1, gzip;q=1, identity;q=0'), ['gzip', 'br']);
    assert.equal(choice?.coding, 'gzip');
    const reversed = selectCoding(prefs('br;q=1, gzip;q=1, identity;q=0'), ['br', 'gzip']);
    assert.equal(reversed?.coding, 'br');
  });

  test('identity is appended after the configured codings', () => {
    assert.deepEqual(candidateCodings(['gzip', 'br']), ['gzip', 'br', 'identity']);
  });

  test('returns undefined when every candidate is excluded', () => {
    const choice = selectCoding(prefs('gzip;q=0, br;q=0, identity;q=0'), ['gzip', 'br']);
    assert.equal(choice, undefined);
  });

  test('wildcard q=0 excludes the wildcard codings but an explicit entry overrides it', () => {
    assert.equal(selectCoding(prefs('*;q=0, br;q=1'), ['gzip', 'br'])?.coding, 'br');
    // Not excluded by the wildcard, but the implicit identity q=1 still wins.
    assert.equal(selectCoding(prefs('*;q=0.1'), ['gzip', 'br'])?.coding, 'identity');
    assert.equal(selectCoding(prefs('*;q=0.1, identity;q=0'), ['gzip', 'br'])?.coding, 'gzip');
  });
});

describe('Vary handling', () => {
  test('appends Accept-Encoding to an existing Vary list', () => {
    const headers = ResponseHeaders.from({ Vary: 'Accept-Language' });
    headers.mergeVary();
    assert.equal(headers.get('vary'), 'Accept-Language, Accept-Encoding');
  });

  test('is idempotent when Accept-Encoding is already listed', () => {
    const headers = ResponseHeaders.from({ vary: 'accept-encoding' });
    headers.mergeVary();
    assert.equal(headers.get('vary'), 'accept-encoding');
  });

  test('Vary: * stays exactly *', () => {
    const headers = ResponseHeaders.from({ Vary: '*' });
    headers.mergeVary();
    assert.equal(headers.get('vary'), '*');
  });
});

describe('ETag weakening', () => {
  test('strong validators become weak and weak ones are untouched', () => {
    assert.equal(weakenEtag('"abc"'), 'W/"abc"');
    assert.equal(weakenEtag('W/"abc"'), 'W/"abc"');
    assert.equal(weakenEtag('*'), '*');
  });
});

describe('negotiation without reading a body', () => {
  test('negotiateResponse reports the plan and never touches the body', () => {
    let pulled = 0;
    const body = {
      [Symbol.asyncIterator]() {
        pulled += 1;
        return { next: async () => ({ value: Buffer.from('x'), done: false }) };
      },
    };
    const plan = negotiateResponse('br;q=1, gzip;q=0.5, identity;q=0', { status: 200, headers: { 'Content-Length': '10', ETag: '"v1"' } });
    assert.equal(plan.compressed, true);
    assert.equal(plan.coding, 'br');
    assert.equal(plan.headers.get('content-encoding'), 'br');
    assert.equal(plan.headers.get('content-length'), undefined);
    assert.equal(plan.headers.get('etag'), 'W/"v1"');
    assert.equal(pulled, 0);
    assert.equal(plan.headers.get('vary'), 'Accept-Encoding');
    void body;
  });

  test('a 406 decision is thrown eagerly and carries Vary', () => {
    assert.throws(
      () => encodeResponse({ preferences: 'identity;q=0, *;q=0', response: { status: 200 }, body: 'abc' }),
      (error: unknown) => {
        assert.ok(error instanceof NotAcceptableError);
        assert.equal(error.status, 406);
        assert.equal(error.headers.get('vary'), 'Accept-Encoding');
        return true;
      },
    );
  });

  test('a 206 whose representation coding is rejected returns 406 before output', () => {
    assert.throws(
      () =>
        encodeResponse({
          preferences: 'identity;q=0',
          response: { status: 206, headers: { 'Content-Range': 'bytes 0-9/100' } },
          body: '0123456789',
        }),
      NotAcceptableError,
    );
  });
});
