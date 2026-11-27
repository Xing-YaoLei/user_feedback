import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

import { encodeResponse, BodyAbortedError, createResponseEncoder, NotAcceptableError } from '../src/index.ts';
import { createDemoServer } from '../src/cli.ts';
import { syntheticBytes, withTimeout } from './support/gateway.ts';

describe('AbortSignal integration', () => {
  test('an already-aborted signal refuses to start a response', () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () =>
        encodeResponse({
          preferences: 'gzip, identity;q=0',
          response: { status: 200, headers: {} },
          body: 'hello',
          options: { signal: controller.signal },
        }),
      BodyAbortedError,
    );
  });

  test('aborting mid-stream stops the upstream and rejects completion', async () => {
    const controller = new AbortController();
    let pulled = 0;
    let destroyedCustom = false;
    const source = new Readable({
      highWaterMark: 512,
      read() {
        pulled += 1;
        this.push(syntheticBytes(512, pulled));
      },
      destroy(error, callback) {
        destroyedCustom = true;
        callback(error);
      },
    });
    const encoded = encodeResponse({
      preferences: 'br, identity;q=0',
      response: { status: 200, headers: {} },
      body: source,
      options: { signal: controller.signal },
    });
    const iterator = encoded.body[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await assert.rejects(withTimeout(encoded.completion, 1000, 'completion'), BodyAbortedError);
    assert.equal(source.destroyed, true);
    assert.equal(destroyedCustom, true);
    const pulledAfter = pulled;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pulled, pulledAfter);
  });

  test('an abort after a successful completion is a no-op', async () => {
    const controller = new AbortController();
    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: Buffer.from('finished before abort'),
      options: { signal: controller.signal },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of encoded.body) chunks.push(Buffer.from(chunk));
    await encoded.completion;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(zlib.gunzipSync(Buffer.concat(chunks)).toString(), 'finished before abort');
  });
});

describe('createResponseEncoder', () => {
  test('shares defaults and allows per-call overrides', async () => {
    const encoder = createResponseEncoder({ codings: ['br', 'gzip'], highWaterMark: 4096 });
    const encoded = encoder({
      preferences: 'br, gzip;q=0.5, identity;q=0',
      response: { status: 200, headers: {} },
      body: 'hello world',
    });
    assert.equal(encoded.coding, 'br');

    const negotiated = encoder.negotiate({ preferences: 'br, gzip;q=0.5, identity;q=0', response: { status: 200 } });
    assert.equal(negotiated.coding, 'br');

    const overridden = encoder({
      preferences: 'br, gzip;q=0.5, identity;q=0',
      response: { status: 200, headers: {} },
      body: 'hello world',
      options: { codings: ['gzip', 'br'] },
    });
    assert.equal(overridden.coding, 'br', 'br still has the higher q');

    assert.throws(
      () => {
        encoder({ preferences: 'identity;q=0, br;q=0', response: { status: 200 }, body: 'x' });
      },
      NotAcceptableError,
    );
  });
});

describe('demo server', () => {
  let server: http.Server;
  let port = 0;

  test('serves the documented behaviours over HTTP', async (t) => {
    server = createDemoServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const request = (path: string, acceptEncoding: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path, headers: { 'accept-encoding': acceptEncoding } }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
          })
          .on('error', reject);
      });

    const gzip = await request('/text', 'gzip, br');
    assert.equal(gzip.status, 200);
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(gzip.headers.etag, 'W/"text-v1"');
    assert.match(String(gzip.headers.vary), /Accept-Language, Accept-Encoding/);
    assert.match(zlib.gunzipSync(gzip.body).toString(), /hello from the coding demo/);

    const brotli = await request('/text', 'gzip;q=0.5, br;q=1');
    assert.equal(brotli.headers['content-encoding'], 'br');
    assert.match(zlib.brotliDecompressSync(brotli.body).toString(), /hello from the coding demo/);

    const plain = await request('/text', 'identity');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
    assert.equal(plain.headers.etag, '"text-v1"');

    const rejected = await request('/text', 'gzip;q=0, br;q=0, identity;q=0');
    assert.equal(rejected.status, 406);
    assert.equal(rejected.body.length, 0);

    const range = await request('/range', 'gzip, br');
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-encoding'], undefined);
    assert.equal(range.headers['content-length'], '1024');
  });
});
