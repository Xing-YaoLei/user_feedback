import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

import { encodeResponse, NotAcceptableError } from '../src/index.ts';
import { syntheticBytes, withTimeout } from './support/gateway.ts';

interface UpstreamFixture {
  status: number;
  headers: Record<string, string | number>;
  /**
   * Yields body chunks. `afterFirstDelivery` resolves once the gateway has
   * flushed at least one chunk to the client; awaiting it lets a fixture fail
   * *after* output has started, which is the interesting case.
   */
  source: (afterFirstDelivery: Promise<void>) => AsyncIterable<Buffer>;
  /** When set, the gateway destroys the socket after forwarding this many chunks. */
  abortAfterChunks?: number;
}

const FIXTURES = new Map<string, UpstreamFixture>();

let server: http.Server;
let port = 0;

/**
 * A tiny gateway: it calls the encoder with the request's Accept-Encoding and
 * the upstream fixture, then writes the result to the client exactly as an
 * HTTP handler would.
 */
before(async () => {
  server = http.createServer(async (request, response) => {
    const key = new URL(request.url ?? '/', 'http://localhost').searchParams.get('fixture') ?? '';
    const fixture = FIXTURES.get(key);
    if (fixture === undefined) {
      response.writeHead(404).end('unknown fixture');
      return;
    }

    let encoded: ReturnType<typeof encodeResponse>;
    let markDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });
    try {
      encoded = encodeResponse({
        preferences: request.headers['accept-encoding'] ?? '',
        response: { status: fixture.status, headers: fixture.headers },
        body: fixture.source(delivered),
      });
    } catch (error) {
      if (error instanceof NotAcceptableError) {
        response.writeHead(error.status, error.headers.toObject()).end();
        return;
      }
      throw error;
    }

    response.writeHead(encoded.status, encoded.headers.toObject());
    let forwarded = 0;
    try {
      for await (const chunk of encoded.body) {
        if (!response.write(chunk)) {
          await new Promise<void>((resolve) => response.once('drain', () => resolve()));
        }
        forwarded += 1;
        if (forwarded === 1) markDelivered();
        if (fixture.abortAfterChunks !== undefined && forwarded >= fixture.abortAfterChunks) {
          // Let the bytes already written reach the client, then abort the
          // connection the way a gateway does after an upstream failure.
          // Ending the response cleanly here would be a lie.
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          response.destroy();
          await encoded.cancel();
          return;
        }
      }
      response.end();
      await encoded.completion;
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface ClientResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Set when the connection aborted before the message completed. */
  aborted: boolean;
  error?: Error;
}

function fetchOverHttp(fixture: string, acceptEncoding: string, timeoutMs = 5000): Promise<ClientResult> {
  return new Promise<ClientResult>((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: `/?fixture=${encodeURIComponent(fixture)}`, headers: { 'accept-encoding': acceptEncoding } },
      (response) => {
        const chunks: Buffer[] = [];
        let aborted = false;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            aborted,
            error,
          });
        };
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('aborted', () => {
          aborted = true;
        });
        response.on('error', (error) => {
          aborted = true;
          finish(error);
        });
        response.on('end', () => finish());
        response.on('close', () => finish());
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('client timeout')));
    request.on('error', (error) => {
      // Connection reset mid-body is an expected outcome for the failure case.
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), aborted: true, error });
        return;
      }
      reject(error);
    });
  });
}

describe('end-to-end over a real HTTP socket', () => {
  const payload = Buffer.concat([
    Buffer.from('<!doctype html><html><body>'.repeat(200)),
    syntheticBytes(20_000, 77),
    Buffer.from('</body></html>'),
  ]);

  test('200 + strong ETag + Content-Length: gzip round-trip restores the original', async () => {
    FIXTURES.set('healthy', {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-length': payload.length,
        etag: '"doc-1"',
        vary: 'Accept-Language',
      },
      source: async function* () {
        // Deliver in several chunks with real event-loop turns in between.
        for (let offset = 0; offset < payload.length; offset += 8192) {
          yield payload.subarray(offset, offset + 8192);
          await new Promise((resolve) => setImmediate(resolve));
        }
      },
    });

    const result = await fetchOverHttp('healthy', 'gzip, br;q=0.9');
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], 'gzip');
    assert.equal(result.headers['content-length'], undefined);
    assert.equal(result.headers.etag, 'W/"doc-1"');
    assert.equal(result.headers.vary, 'Accept-Language, Accept-Encoding');
    assert.equal(result.headers['transfer-encoding'], 'chunked');
    assert.deepEqual(zlib.gunzipSync(result.body), payload);
  });

  test('200 + strong ETag + Content-Length: failure after output is never a valid empty body', async () => {
    let forwardedBeforeFailure = false;
    FIXTURES.set('dies-midstream', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'content-length': String(payload.length),
        etag: '"doc-1"',
      },
      abortAfterChunks: 1,
      source: async function* (delivered: Promise<void>) {
        yield payload.subarray(0, 4096);
        // Wait until the gateway has actually flushed a compressed chunk to
        // the client, so the failure happens *after* output has begun.
        await delivered;
        forwardedBeforeFailure = true;
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error('upstream failed after first flush');
      },
    });

    const result = await fetchOverHttp('dies-midstream', 'gzip, br;q=0.9');
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], 'gzip');
    assert.equal(result.headers['content-length'], undefined);
    assert.equal(result.headers.etag, 'W/"doc-1"');
    assert.equal(forwardedBeforeFailure, true);

    // Whatever bytes arrived, they are a truncated gzip member. They must not
    // decode, and must not be mistakable for a valid empty gzip response.
    const validEmpty = zlib.gzipSync(Buffer.alloc(0));
    assert.equal(result.aborted, true, 'the connection must not look like a clean end');
    assert.ok(result.body.length > 0, 'some bytes reached the client before the failure');
    assert.throws(() => zlib.gunzipSync(result.body));
    assert.notEqual(result.body.length, validEmpty.length);
    assert.notEqual(result.body.toString('hex'), validEmpty.toString('hex'));
  });

  test('a clean but empty compressed response is still distinguishable', async () => {
    FIXTURES.set('empty-ok', {
      status: 200,
      headers: { 'content-length': 0, etag: '"empty"' },
      source: async function* () {},
    });
    const result = await fetchOverHttp('empty-ok', 'gzip, identity;q=0');
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], 'gzip');
    assert.equal(result.aborted, false);
    assert.equal(zlib.gunzipSync(result.body).length, 0);
  });

  test('a 206 passes through untouched', async () => {
    FIXTURES.set('range', {
      status: 206,
      headers: { 'content-range': 'bytes 0-99/5000', 'content-length': 100, etag: '"r1"' },
      source: async function* () {
        yield syntheticBytes(100, 3);
      },
    });
    const result = await fetchOverHttp('range', 'gzip, br');
    assert.equal(result.status, 206);
    assert.equal(result.headers['content-encoding'], undefined);
    assert.equal(result.headers['content-length'], '100');
    assert.equal(result.headers.etag, '"r1"');
    assert.equal(result.body.length, 100);
    assert.equal(result.aborted, false);
  });

  test('an unacceptable request gets a 406 with no body', async () => {
    FIXTURES.set('healthy', FIXTURES.get('healthy')!);
    const result = await fetchOverHttp('healthy', 'gzip;q=0, br;q=0, identity;q=0');
    assert.equal(result.status, 406);
    assert.equal(result.body.length, 0);
    assert.match(String(result.headers.vary ?? ''), /Accept-Encoding/i);
  });

  test('br over the wire round-trips too', async () => {
    const result = await fetchOverHttp('healthy', 'br, identity;q=0');
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], 'br');
    assert.equal(result.headers['content-length'], undefined);
    assert.deepEqual(zlib.brotliDecompressSync(result.body), payload);
  });
});
