import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Readable, Duplex, Transform } from 'node:stream';

import { encodeResponse, BodyAbortedError, NotAcceptableError } from '../src/index.ts';
import { callGateway, syntheticBytes, withTimeout } from './support/gateway.ts';

/** A source that yields `head` chunks, then rejects with `error`. */
function explodingSource(head: Buffer[], error: Error): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of head) {
        yield chunk;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw error;
    },
  };
}

/** Analyze a body: what a client would see if the connection closed here. */
function inspectCompressed(body: Buffer, coding: 'gzip' | 'br') {
  const decoder = coding === 'gzip' ? zlib.gunzipSync : zlib.brotliDecompressSync;
  let decoded: Buffer | undefined;
  let decodeError: NodeJS.ErrnoException | undefined;
  try {
    decoded = decoder(body);
  } catch (error) {
    decodeError = error as NodeJS.ErrnoException;
  }
  const emptyTrailer = coding === 'gzip' ? zlib.gzipSync(Buffer.alloc(0)) : zlib.brotliCompressSync(Buffer.alloc(0));
  return { decoded, decodeError, equalsEmptyRepresentation: body.equals(emptyTrailer) };
}

describe('upstream failure after output has started', () => {
  for (const coding of ['gzip', 'br'] as const) {
    test(`${coding}: aborts the response and never looks successful`, async () => {
      const failure = new Error('upstream connection reset');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reopens = 0;

      const source: AsyncIterable<Buffer> = {
        async *[Symbol.asyncIterator]() {
          reopens += 1;
          yield Buffer.from('the first half of the body '.repeat(20));
          yield Buffer.from('and some more bytes '.repeat(20));
          await gate;
          throw failure;
        },
      };

      const encoded = encodeResponse({
        preferences: `${coding}, identity;q=0`,
        response: { status: 200, headers: { 'content-length': '9999', etag: '"v1"' } },
        body: source,
      });

      const chunks: Buffer[] = [];
      let thrown: unknown;
      try {
        for await (const chunk of encoded.body) {
          chunks.push(Buffer.from(chunk));
          release();
        }
      } catch (error) {
        thrown = error;
      }

      assert.ok(chunks.length >= 1, 'some bytes were already delivered');
      assert.ok(thrown instanceof Error);
      assert.match((thrown as Error).message, /upstream connection reset/);

      // Completion must reject, so the caller cannot mistake the truncated
      // stream for a finished response.
      await assert.rejects(withTimeout(encoded.completion, 2000, 'completion'), /upstream connection reset/);

      // The bytes that went out must not decode as a complete body, and must
      // not be confused with a legitimate empty representation.
      const body = Buffer.concat(chunks);
      const analysis = inspectCompressed(body, coding);
      assert.equal(analysis.decoded, undefined, 'partial compressed body must not decode');
      assert.equal(analysis.equalsEmptyRepresentation, false);
      assert.ok(analysis.decodeError);

      // No transcoding / re-send: the upstream was opened exactly once.
      assert.equal(reopens, 1);
    });
  }

  test('the failure is not retried as identity or another coding', async () => {
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const source: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        attempts += 1;
        yield Buffer.from('prefix '.repeat(50));
        await gate;
        throw new Error('boom');
      },
    };
    const encoded = encodeResponse({
      preferences: 'gzip, br, identity;q=0',
      response: { status: 200, headers: { etag: '"v1"' } },
      body: source,
    });
    const received: Buffer[] = [];
    await assert.rejects(async () => {
      for await (const chunk of encoded.body) {
        received.push(Buffer.from(chunk));
        release();
      }
    }, /boom/);
    await assert.rejects(encoded.completion, /boom/);
    assert.equal(attempts, 1);
    // The bytes that did go out stay compressed under the declared coding.
    assert.equal(encoded.coding, 'gzip');
    assert.equal(encoded.headers.get('content-encoding'), 'gzip');
    assert.equal(encoded.headers.get('content-length'), undefined);
    assert.equal(encoded.headers.get('etag'), 'W/"v1"');
    assert.equal(encoded.compressed, true);
    assert.ok(received.length > 0);
    assert.throws(() => zlib.gunzipSync(Buffer.concat(received)));
  });
});

describe('upstream failure before any output', () => {
  for (const coding of ['gzip', 'br'] as const) {
    test(`${coding}: rejects completion with no body bytes`, async () => {
      const encoded = encodeResponse({
        preferences: `${coding}, identity;q=0`,
        response: { status: 200, headers: { etag: '"v1"' } },
        body: explodingSource([], new Error('immediate failure')),
      });
      const chunks: Buffer[] = [];
      await assert.rejects(async () => {
        for await (const chunk of encoded.body) chunks.push(Buffer.from(chunk));
      }, /immediate failure/);
      await assert.rejects(encoded.completion, /immediate failure/);
      assert.equal(chunks.length, 0);
    });
  }

  test('a zero-byte failure is not a valid empty compressed body', async () => {
    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: explodingSource([], new Error('no data')),
    });
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of encoded.body) chunks.push(Buffer.from(chunk));
    } catch {
      /* expected */
    }
    const failureBody = Buffer.concat(chunks);
    const validEmpty = zlib.gzipSync(Buffer.alloc(0));
    await assert.rejects(encoded.completion);
    assert.equal(failureBody.length, 0);
    assert.notEqual(failureBody.length, validEmpty.length);
    assert.throws(() => zlib.gunzipSync(failureBody));
  });
});

describe('compressor failure after output', () => {
  test('a compressor that fails mid-stream aborts rather than falling back', async () => {
    let compressorCount = 0;
    const factory = (): Duplex => {
      compressorCount += 1;
      let emitted = false;
      const failing = new Transform({
        transform(chunk, _encoding, callback) {
          if (emitted) {
            callback(new Error('compressor exploded'));
            return;
          }
          emitted = true;
          callback(null, chunk);
        },
      });
      return failing as unknown as Duplex;
    };

    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: { etag: '"original"' } },
      body: [Buffer.from('first piece'), Buffer.from('second piece')],
      options: { compressorFactory: factory },
    });

    const chunks: Buffer[] = [];
    let error: unknown;
    try {
      for await (const chunk of encoded.body) chunks.push(Buffer.from(chunk));
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match((error as Error).message, /compressor exploded/);
    await assert.rejects(encoded.completion, /compressor exploded/);
    assert.equal(compressorCount, 1, 'the compressor must not be recreated');
    assert.equal(encoded.compressed, true);
    assert.equal(encoded.headers.get('content-encoding'), 'gzip');
  });
});

describe('cancellation', () => {
  test('cancel mid-stream stops the upstream and closes the compressor', async () => {
    let pulled = 0;
    let destroyedCustom = false;
    let cleared = false;
    const source = new Readable({
      highWaterMark: 1024,
      read() {
        pulled += 1;
        this.push(syntheticBytes(1024, pulled));
      },
      destroy(error, callback) {
        destroyedCustom = true;
        cleared = true;
        callback(error);
      },
    });

    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: source,
    });

    const iterator = encoded.body[Symbol.asyncIterator]();
    await withTimeout(iterator.next(), 1000, 'first chunk');
    assert.ok(pulled > 0);

    const pulledAtCancel = pulled;
    await withTimeout(encoded.cancel(), 1000, 'cancel');

    assert.equal(source.destroyed, true);
    assert.equal(destroyedCustom, true);

    // Nothing further is read after cancellation.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(pulled, pulledAtCancel);
    assert.equal(cleared, true);

    // The response is aborted, not "successfully empty".
    await assert.rejects(encoded.completion, (error: unknown) => {
      assert.ok(error instanceof BodyAbortedError);
      assert.equal((error as BodyAbortedError).code, 'ABORT_ERR');
      return true;
    });
  });

  test('cancel before any read never starts the upstream', async () => {
    let pulled = 0;
    const source = new Readable({
      read() {
        pulled += 1;
        this.push(Buffer.alloc(64));
      },
    });
    const encoded = encodeResponse({
      preferences: 'br, identity;q=0',
      response: { status: 200, headers: {} },
      body: source,
    });
    await encoded.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pulled, 0, 'upstream must not be read after an immediate cancel');
    assert.equal(source.destroyed, true);
    await assert.rejects(encoded.completion, BodyAbortedError);
    await assert.rejects(async () => {
      for await (const _chunk of encoded.body) void _chunk;
    }, BodyAbortedError);
  });

  test('abandoning the iterator tears the response down', async () => {
    let destroyedCustom = false;
    const source = new Readable({
      read() {
        this.push(syntheticBytes(2048, 5));
      },
      destroy(error, callback) {
        destroyedCustom = true;
        callback(error);
      },
    });
    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: source,
    });
    for await (const _chunk of encoded.body) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(source.destroyed, true);
    assert.equal(destroyedCustom, true);
    await assert.rejects(encoded.completion, BodyAbortedError);
  });

  test('cancelling an identity response stops the upstream too', async () => {
    let pulled = 0;
    let destroyedCustom = false;
    const source = new Readable({
      highWaterMark: 256,
      read() {
        pulled += 1;
        this.push(Buffer.alloc(256, pulled & 0xff));
      },
      destroy(error, callback) {
        destroyedCustom = true;
        callback(error);
      },
    });
    const encoded = encodeResponse({
      preferences: 'identity;q=1, gzip;q=0, br;q=0',
      response: { status: 200, headers: {} },
      body: source,
    });
    const iterator = encoded.body[Symbol.asyncIterator]();
    await iterator.next();
    await encoded.cancel();
    assert.equal(source.destroyed, true);
    assert.equal(destroyedCustom, true);
    await assert.rejects(encoded.completion, BodyAbortedError);
  });

  test('a dropped client connection through the adapter leaves no dangling reads', async () => {
    let pulled = 0;
    const source = new Readable({
      highWaterMark: 512,
      read() {
        pulled += 1;
        this.push(syntheticBytes(512, pulled));
      },
    });
    const result = await callGateway(
      { headers: { 'accept-encoding': 'br, identity;q=0' } },
      { status: 200, headers: {}, body: source },
      { stopAfterChunks: 1 },
    );
    const pulledAfterDrop = pulled;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(pulled, pulledAfterDrop, 'upstream continued to be read after the client left');
    assert.equal(source.destroyed, true);
    await assert.rejects(result.response.completion, BodyAbortedError);
    assert.ok(result.response.body.length > 0);
  });
});

describe('a failed response must not be mistaken for a valid empty one', () => {
  test('bytesEmitted distinguishes "clean wire" from "already committed"', async () => {
    // Failure before any output: the caller can still send a fresh 502.
    const early = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: explodingSource([], new Error('no bytes yet')),
    });
    assert.equal(early.bytesEmitted, 0);
    assert.equal(early.started, false);
    await assert.rejects(async () => {
      for await (const _chunk of early.body) void _chunk;
    }, /no bytes yet/);
    assert.equal(early.bytesEmitted, 0, 'nothing reached the wire');

    // Failure after output: the response is committed and must be aborted.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const late = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: { status: 200, headers: {} },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('committed bytes '.repeat(30));
          await gate;
          throw new Error('late failure');
        },
      },
    });
    await assert.rejects(async () => {
      for await (const _chunk of late.body) release();
    }, /late failure/);
    assert.ok(late.bytesEmitted > 0, 'the wire is already dirty');
    assert.equal(late.started, true);
  });

  test('200 + strong ETag + known length, compressed, then upstream failure', async () => {
    const payload = Buffer.from('Lorem ipsum dolor sit amet. '.repeat(400));
    const failure = new Error('upstream died after headers');
    let release!: () => void;
    const afterFirstByte = new Promise<void>((resolve) => { release = resolve; });

    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(payload.length),
          etag: '"payload-v1"',
        },
      },
      // Emit half the payload, then fail only once the client has actually
      // received a compressed chunk.
      body: (async function* () {
        yield payload.subarray(0, Math.floor(payload.length / 2));
        await afterFirstByte;
        throw failure;
      })(),
    });

    assert.equal(encoded.status, 200);
    assert.equal(encoded.headers.get('content-encoding'), 'gzip');
    assert.equal(encoded.headers.get('content-length'), undefined);
    assert.equal(encoded.headers.get('etag'), 'W/"payload-v1"');

    const received: Buffer[] = [];
    let seenError: unknown;
    try {
      for await (const chunk of encoded.body) {
        received.push(Buffer.from(chunk));
        release();
      }
    } catch (error) {
      seenError = error;
    }

    assert.ok(seenError instanceof Error);
    await assert.rejects(encoded.completion, /upstream died after headers/);

    const wire = Buffer.concat(received);
    assert.ok(wire.length > 0, 'the client did receive a prefix');
    assert.equal(encoded.started, true);
    assert.ok(encoded.bytesEmitted > 0);
    // It cannot be inflated, and in particular is not a valid empty gzip member.
    assert.throws(() => zlib.gunzipSync(wire));
    assert.notEqual(wire.length, zlib.gzipSync(Buffer.alloc(0)).length);
    assert.notEqual(wire.toString('hex'), zlib.gzipSync(Buffer.alloc(0)).toString('hex'));
  });

  test('a successful response of the same shape does decode back to the payload', async () => {
    const payload = Buffer.from('Lorem ipsum dolor sit amet. '.repeat(400));
    const encoded = encodeResponse({
      preferences: 'gzip, identity;q=0',
      response: {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': String(payload.length), etag: '"payload-v1"' },
      },
      body: payload,
    });
    const received: Buffer[] = [];
    for await (const chunk of encoded.body) received.push(Buffer.from(chunk));
    await encoded.completion;
    const wire = Buffer.concat(received);
    assert.deepEqual(zlib.gunzipSync(wire), payload);
    assert.notEqual(wire.length, zlib.gzipSync(Buffer.alloc(0)).length);
  });
});
