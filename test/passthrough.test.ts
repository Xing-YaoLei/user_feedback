import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { encodeResponse, NotAcceptableError, ResponseHeaders } from '../src/index.ts';
import { callGateway, syntheticBytes, withTimeout } from './support/gateway.ts';

describe('206 responses are never re-compressed', () => {
  test('a 206 is forwarded byte-for-byte even when gzip is preferred', async () => {
    const partial = Buffer.from('partial-content-'.repeat(50));
    const result = await callGateway(
      { method: 'GET', headers: { 'accept-encoding': 'gzip, br, identity;q=0.1' } },
      {
        status: 206,
        headers: {
          'content-range': `bytes 0-${partial.length - 1}/1000`,
          'content-length': String(partial.length),
          etag: '"range-v1"',
        },
        body: partial,
      },
    );
    await withTimeout(result.response.completion, 2000, '206 completion');
    assert.equal(result.response.status, 206);
    assert.equal(result.response.headers['content-encoding'], undefined);
    assert.equal(result.response.headers['content-length'], String(partial.length));
    assert.equal(result.response.headers.etag, '"range-v1"');
    assert.equal(result.response.headers.vary, 'Accept-Encoding');
    assert.deepEqual(result.response.body, partial);
    assert.equal(result.response.compressed, false);
  });

  test('a 206 whose identity representation is rejected fails with 406 before output', async () => {
    assert.throws(
      () =>
        encodeResponse({
          preferences: 'gzip, identity;q=0',
          response: { status: 206, headers: { 'content-range': 'bytes 0-9/100', etag: '"r"' } },
          body: '0123456789',
        }),
      (error: unknown) => {
        assert.ok(error instanceof NotAcceptableError);
        assert.equal(error.status, 406);
        assert.equal(error.headers.get('vary'), 'Accept-Encoding');
        assert.match(error.message, /identity/);
        return true;
      },
    );
  });

  test('a 206 with an existing coding is accepted when that coding is acceptable', async () => {
    const encodedPayload = zlib.gzipSync(Buffer.from('already compressed bytes '.repeat(40)));
    const result = await callGateway(
      { headers: { 'accept-encoding': 'gzip, br' } },
      {
        status: 206,
        headers: {
          'content-encoding': 'gzip',
          'content-range': `bytes 0-${encodedPayload.length - 1}/99999`,
          'content-length': String(encodedPayload.length),
          etag: 'W/"range-gzip"',
        },
        body: encodedPayload,
      },
    );
    await result.response.completion;
    assert.equal(result.response.status, 206);
    assert.equal(result.response.headers['content-encoding'], 'gzip');
    assert.equal(result.response.headers['content-length'], String(encodedPayload.length), 'existing length preserved');
    assert.equal(result.response.headers.etag, 'W/"range-gzip"');
    assert.deepEqual(result.response.body, encodedPayload);
    assert.deepEqual(result.response.decode(), Buffer.from('already compressed bytes '.repeat(40)));
  });
});

describe('responses that already carry Content-Encoding', () => {
  test('a 200 with Content-Encoding: br is not re-compressed', async () => {
    const payload = Buffer.from('upstream already brotli-compressed '.repeat(80));
    const encodedPayload = zlib.brotliCompressSync(payload);
    const result = await callGateway(
      { headers: { 'accept-encoding': 'br, gzip, identity;q=0.1' } },
      {
        status: 200,
        headers: {
          'content-encoding': 'br',
          'content-length': String(encodedPayload.length),
          etag: '"upstream"',
          vary: 'Accept-Encoding',
        },
        body: encodedPayload,
      },
    );
    await result.response.completion;
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers['content-encoding'], 'br', 'the coding must not be doubled');
    assert.equal(result.response.headers['content-length'], String(encodedPayload.length));
    assert.equal(result.response.headers.etag, '"upstream"');
    assert.equal(result.response.headers.vary, 'Accept-Encoding', 'Vary is not duplicated');
    assert.deepEqual(result.response.body, encodedPayload);
    assert.deepEqual(result.response.decode(), payload);
  });

  test('a 200 with a coding the client rejects is a 406 before any bytes', async () => {
    let pulled = 0;
    const body = {
      [Symbol.asyncIterator]() {
        pulled += 1;
        return { next: async () => ({ value: Buffer.alloc(1), done: false }) };
      },
    };
    assert.throws(
      () =>
        encodeResponse({
          preferences: 'gzip',
          response: { status: 200, headers: { 'content-encoding': 'br' } },
          body: body as never,
        }),
      (error: unknown) => {
        assert.ok(error instanceof NotAcceptableError);
        assert.equal(error.status, 406);
        assert.match(error.message, /"br"/);
        return true;
      },
    );
    assert.equal(pulled, 0, 'the body must not be touched before a 406 decision');
  });

  test('respects a multi-coding Content-Encoding chain', async () => {
    const payload = Buffer.from('chained codings '.repeat(30));
    const once = zlib.gzipSync(payload);
    const twice = zlib.brotliCompressSync(once);

    const rejected = () =>
      encodeResponse({
        preferences: 'br, identity;q=0.5',
        response: { status: 200, headers: { 'content-encoding': 'gzip, br' } },
        body: twice,
      });
    // `gzip` is not explicitly listed (only `br` is), so the chain is not acceptable.
    assert.throws(rejected, NotAcceptableError);

    const accepted = await callGateway(
      { headers: { 'accept-encoding': 'gzip, br, identity;q=0' } },
      { status: 200, headers: { 'content-encoding': 'gzip, br', 'content-length': String(twice.length) }, body: twice },
    );
    await accepted.response.completion;
    assert.deepEqual(accepted.response.decode(), payload);
  });
});

describe('406 decisions', () => {
  test('no acceptable coding at all produces 406 with Vary merged', async () => {
    const result = await callGateway(
      { headers: { 'accept-encoding': 'gzip;q=0, br;q=0, identity;q=0' } },
      { status: 200, headers: { vary: 'Accept-Language' }, body: 'hello' },
    );
    assert.equal(result.notAcceptable, true);
    assert.equal(result.rejection?.status, 406);
    assert.equal(result.rejection?.headers.vary, 'Accept-Language, Accept-Encoding');
    assert.deepEqual(result.chunks, []);
  });

  test('a wildcard with q=0 excludes identity too', async () => {
    const result = await callGateway(
      { headers: { 'accept-encoding': '*;q=0' } },
      { status: 200, headers: {}, body: 'hello' },
    );
    assert.equal(result.notAcceptable, true);
    assert.equal(result.rejection?.status, 406);
  });

  test('a compressed representation is still available when identity is excluded', async () => {
    const result = await callGateway(
      { headers: { 'accept-encoding': 'gzip, identity;q=0' } },
      { status: 200, headers: {}, body: 'take gzip please' },
    );
    assert.equal(result.notAcceptable, false);
    assert.equal(result.response.headers['content-encoding'], 'gzip');
    assert.equal(result.response.decode().toString(), 'take gzip please');
  });

  test('identity-only requests never get compressed', async () => {
    const payload = syntheticBytes(20_000, 4);
    const result = await callGateway(
      { headers: { 'accept-encoding': 'gzip;q=0, br;q=0' } },
      { status: 200, headers: { 'content-length': String(payload.length), etag: '"plain"' }, body: payload },
    );
    await result.response.completion;
    assert.equal(result.response.headers['content-encoding'], undefined);
    assert.equal(result.response.headers['content-length'], String(payload.length));
    assert.equal(result.response.headers.etag, '"plain"');
    assert.deepEqual(result.response.body, payload);
  });

  test('a missing Accept-Encoding header behaves like identity', async () => {
    const result = await callGateway(
      { headers: {} },
      { status: 200, headers: { 'content-length': '3', etag: '"e"' }, body: 'abc' },
    );
    await result.response.completion;
    assert.equal(result.response.headers['content-encoding'], undefined);
    assert.deepEqual(result.response.body, Buffer.from('abc'));
    assert.equal(result.response.headers.vary, 'Accept-Encoding');
  });

  test('identity wins a tie against configured codings when it is listed first conceptually', async () => {
    // `identity;q=1` and gzip/br are absent → gzip/br resolve to 0 via the
    // missing wildcard, so identity is the only acceptable coding.
    const encoded = encodeResponse({
      preferences: 'identity',
      response: { status: 200, headers: {} },
      body: 'plain text',
    });
    assert.equal(encoded.coding, 'identity');
    assert.equal(encoded.compressed, false);
    const chunks: Buffer[] = [];
    for await (const chunk of encoded.body) chunks.push(Buffer.from(chunk));
    await encoded.completion;
    assert.deepEqual(Buffer.concat(chunks), Buffer.from('plain text'));
  });
});

describe('header collection integration', () => {
  test('headers can be supplied as ResponseHeaders, tuples or a record', () => {
    const a = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: ResponseHeaders.from({ etag: '"one"', 'content-length': '3' }) },
      body: 'abc',
    });
    assert.equal(a.headers.get('etag'), 'W/"one"');

    const b = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: [['ETag', '"two"'], ['Content-Length', '3']] },
      body: 'abc',
    });
    assert.equal(b.headers.get('etag'), 'W/"two"');
    assert.equal(b.headers.get('content-length'), undefined);

    const c = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: { ETag: '"three"', 'X-Repeat': ['a', 'b'] } },
      body: 'abc',
    });
    assert.equal(c.headers.get('x-repeat'), 'a, b');
  });

  test('repeated ETag header lines are all weakened', () => {
    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: [['ETag', '"a"'], ['ETag', '"b"']] },
      body: 'abc',
    });
    assert.deepEqual(encoded.headers.values('etag'), ['W/"a"', 'W/"b"']);
  });
});
