import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Readable, compose, Transform } from 'node:stream';

import { encodeResponse, InvalidResponseError } from '../src/index.ts';
import { callGateway, syntheticBytes, withTimeout } from './support/gateway.ts';

function textPayload(): Buffer {
  return Buffer.from('The quick brown fox jumps over the lazy dog.\n'.repeat(200));
}

describe('successful compression', () => {
  for (const coding of ['gzip', 'br'] as const) {
    test(`${coding}: round-trips the original bytes`, async () => {
      const payload = Buffer.concat([textPayload(), syntheticBytes(4096, 9)]);
      const result = await callGateway(
        { method: 'GET', headers: { 'accept-encoding': coding } },
        {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.length), etag: '"abc123"' },
          body: payload,
        },
      );
      await withTimeout(result.response.completion, 2000, 'completion');
      assert.equal(result.response.status, 200);
      assert.equal(result.response.headers['content-encoding'], coding);
      assert.deepEqual(result.response.decode(), payload);
      assert.ok(result.response.body.length > 0);
      assert.ok(result.response.body.length < payload.length + 64, 'output is a real compressed stream');
      assert.equal(result.notAcceptable, false);
    });
  }

  test('compressed bodies are smaller than the original for compressible input', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x61);
    const result = await callGateway(
      { headers: { 'accept-encoding': 'gzip, identity;q=0' } },
      { status: 200, headers: {}, body: payload },
    );
    await result.response.completion;
    assert.ok(result.response.body.length < payload.length / 4);
    assert.deepEqual(result.response.decode(), payload);
  });

  test('empty upload still produces a valid empty compressed stream', async () => {
    for (const coding of ['gzip', 'br'] as const) {
      const result = await callGateway(
        { headers: { 'accept-encoding': `${coding}, identity;q=0` } },
        { status: 200, headers: {}, body: [] },
      );
      await result.response.completion;
      assert.equal(result.response.decode().length, 0);
      assert.ok(result.response.body.length > 0, `${coding} trailer must exist`);
    }
  });
});

describe('metadata follows the bytes', () => {
  test('compression drops Content-Length and weakens a strong ETag', async () => {
    const result = await callGateway(
      { headers: { 'accept-encoding': 'gzip, identity;q=0' } },
      {
        status: 200,
        headers: { 'content-length': '11', etag: '"strong-validator"', 'cache-control': 'max-age=60' },
        body: 'hello world',
      },
    );
    await result.response.completion;
    assert.equal(result.response.headers['content-encoding'], 'gzip');
    assert.equal(result.response.headers['content-length'], undefined);
    assert.equal(result.response.headers.etag, 'W/"strong-validator"');
    assert.equal(result.response.headers['cache-control'], 'max-age=60');
  });

  test('an already-weak ETag is left alone', async () => {
    const result = await callGateway(
      { headers: { 'accept-encoding': 'br, identity;q=0' } },
      { status: 200, headers: { etag: 'W/"already-weak"' }, body: 'hello' },
    );
    await result.response.completion;
    assert.equal(result.response.headers.etag, 'W/"already-weak"');
  });

  test('identity keeps the original length and validator untouched', async () => {
    const payload = textPayload();
    const result = await callGateway(
      { headers: { 'accept-encoding': 'identity' } },
      {
        status: 200,
        headers: { 'content-length': String(payload.length), etag: '"strong-validator"' },
        body: payload,
      },
    );
    await result.response.completion;
    assert.equal(result.response.headers['content-encoding'], undefined);
    assert.equal(result.response.headers['content-length'], String(payload.length));
    assert.equal(result.response.headers.etag, '"strong-validator"');
    assert.deepEqual(result.response.body, payload);
  });

  test('Vary is merged, and `*` is preserved verbatim', async () => {
    const appended = await callGateway(
      { headers: { 'accept-encoding': 'gzip, identity;q=0' } },
      { status: 200, headers: { vary: 'Accept-Language, User-Agent' }, body: 'abc' },
    );
    await appended.response.completion;
    assert.equal(appended.response.headers.vary, 'Accept-Language, User-Agent, Accept-Encoding');

    const starred = await callGateway(
      { headers: { 'accept-encoding': 'gzip, identity;q=0' } },
      { status: 200, headers: { vary: '*' }, body: 'abc' },
    );
    await starred.response.completion;
    assert.equal(starred.response.headers.vary, '*');

    const absent = await callGateway(
      { headers: { 'accept-encoding': 'gzip, identity;q=0' } },
      { status: 200, headers: {}, body: 'abc' },
    );
    await absent.response.completion;
    assert.equal(absent.response.headers.vary, 'Accept-Encoding');
  });

  test('the original header collection is not mutated', async () => {
    const original = { 'content-length': '5', etag: '"x"' };
    const encoded = encodeResponse({ preferences: 'gzip, identity;q=0', response: { status: 200, headers: original }, body: 'hello' });
    for await (const _chunk of encoded.body) void _chunk;
    await encoded.completion;
    assert.deepEqual(original, { 'content-length': '5', etag: '"x"' });
  });
});

describe('streaming behaviour', () => {
  test('output starts before the upstream has finished', async () => {
    let produced = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* upstream(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 4; i += 1) {
        produced += 1;
        yield Buffer.from(`chunk-${i}-` + 'x'.repeat(128));
        if (i === 0) await gate;
      }
    }

    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: upstream(),
    });
    const iterator = encoded.body[Symbol.asyncIterator]();
    const first = await withTimeout(iterator.next(), 1000, 'first chunk');
    assert.equal(first.done, false);
    assert.equal(produced, 1, 'upstream was not drained before the first byte');
    release();
    const rest: Buffer[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      rest.push(Buffer.from(step.value));
    }
    await encoded.completion;
    assert.deepEqual(zlib.gunzipSync(Buffer.concat([Buffer.from(first.value!), ...rest])).toString(), 'chunk-0-' + 'x'.repeat(128) + 'chunk-1-' + 'x'.repeat(128) + 'chunk-2-' + 'x'.repeat(128) + 'chunk-3-' + 'x'.repeat(128));
    assert.equal(produced, 4);
  });

  test('body is delivered in multiple chunks when the consumer reads incrementally', async () => {
    const payload = syntheticBytes(256 * 1024, 21);
    async function* source(): AsyncGenerator<Buffer> {
      for (let offset = 0; offset < payload.length; offset += 4096) {
        yield payload.subarray(offset, offset + 4096);
      }
    }
    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: source(),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of encoded.body) chunks.push(Buffer.from(chunk));
    await encoded.completion;
    assert.ok(chunks.length > 1, `expected incremental output, got ${chunks.length} chunk(s)`);
    assert.deepEqual(zlib.gunzipSync(Buffer.concat(chunks)), payload);
  });

  test('upstream reads are paced by the downstream consumer', async () => {
    const hwm = 8 * 1024;
    let producedBytes = 0;
    const total = 4 * 1024 * 1024;
    const source = new Readable({
      highWaterMark: hwm,
      read() {
        if (producedBytes >= total) {
          this.push(null);
          return;
        }
        const size = Math.min(hwm, total - producedBytes);
        producedBytes += size;
        this.push(syntheticBytes(size, producedBytes));
      },
    });

    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: source,
      options: { highWaterMark: hwm },
    });
    const iterator = encoded.body[Symbol.asyncIterator]();
    await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Only the bounded pipeline buffers may have been read ahead. A few
    // high-water marks is fine; draining megabytes is not.
    assert.ok(
      producedBytes < 64 * hwm,
      `upstream produced ${producedBytes} bytes while the consumer was paused (budget ${64 * hwm})`,
    );

    let totalOut = 0;
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      totalOut += step.value.length;
    }
    await encoded.completion;
    assert.equal(producedBytes, total);
    assert.ok(totalOut > 0);
  });

  test('completion waits for the compressor trailer, not just the source EOF', async () => {
    // A compressor factory that holds the final output back until released.
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
    let compressorCreated = 0;

    const encoderOptions = {
      highWaterMark: 1024,
      compressorFactory: (_coding: string) => {
        compressorCreated += 1;
        const gz = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
        let firstOutput = true;
        const delayed = new Transform({
          transform(chunk, _enc, callback) {
            if (firstOutput) {
              firstOutput = false;
              callback(null, chunk);
              return;
            }
            // Hold every later chunk until the test releases it. This models a
            // compressor that has not yet produced its trailer.
            tailGate.then(() => callback(null, chunk));
          },
        });
        // Compose so both stages share one lifecycle: the returned Duplex is
        // what the encoder drives, and destroying it tears down both.
        return compose(gz, delayed);
      },
    };

    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: [Buffer.from('first'), Buffer.from('second')],
      options: encoderOptions,
    });

    let settled = false;
    encoded.completion.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    const iterator = encoded.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false, 'completion resolved before the tail chunk was emitted');
    assert.equal(compressorCreated, 1);

    releaseTail();
    const rest: Buffer[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      rest.push(Buffer.from(step.value));
    }
    await withTimeout(encoded.completion, 2000, 'completion');
    assert.deepEqual(zlib.gunzipSync(Buffer.concat([Buffer.from(first.value!), ...rest])).toString(), 'firstsecond');
  });

  test('a body can be split across arbitrary chunk boundaries', async () => {
    const payload = Buffer.from('abcdefghij'.repeat(1000));
    async function* dribble(): AsyncGenerator<Buffer> {
      for (let i = 0; i < payload.length; i += 7) yield payload.subarray(i, i + 7);
    }
    const encoded = encodeResponse({ preferences: 'br, identity;q=0', response: { status: 200, headers: {} }, body: dribble() });
    const chunks: Buffer[] = [];
    for await (const chunk of encoded.body) chunks.push(Buffer.from(chunk));
    await encoded.completion;
    assert.deepEqual(zlib.brotliDecompressSync(Buffer.concat(chunks)), payload);
  });
});

describe('unsupported input', () => {
  test('statuses other than 200 and 206 are rejected up front', () => {
    assert.throws(
      () => encodeResponse({ preferences: 'gzip', response: { status: 404 }, body: 'nope' }),
      (error: unknown) => error instanceof InvalidResponseError,
    );
  });

  test('unknown configured codings are rejected', () => {
    assert.throws(
      () => encodeResponse({ preferences: 'gzip', response: { status: 200 }, body: 'x', options: { codings: ['zstd'] } }),
      TypeError,
    );
  });

  test('a non-positive high-water mark is rejected', () => {
    assert.throws(
      () => encodeResponse({ preferences: 'gzip', response: { status: 200 }, body: 'x', options: { highWaterMark: 0 } }),
      TypeError,
    );
  });
});
