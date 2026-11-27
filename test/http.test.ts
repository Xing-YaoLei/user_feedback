/**
 * HTTP-level behaviour: status codes, Content-Type negotiation, and the
 * end-to-end convenience reader.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDecoderForResponse, decodeHttpResponseBody } from '../src/http.ts';
import { parseContentType, resolveMode } from '../src/content-type.ts';
import {
  HttpStatusError,
  UnsupportedContentTypeError,
  GrpcStatusError,
} from '../src/errors.ts';
import { frameBytes, messages, toText, trailer } from './support/fixtures.ts';

function okBody(): Buffer {
  return frameBytes(...messages('one', 'two'), trailer({ 'grpc-status': '0' }));
}

async function* chunks(buffer: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buffer.length; i += size) {
    yield buffer.subarray(i, Math.min(i + size, buffer.length));
  }
}

test('parseContentType recognises both grpc-web media types and parameters', () => {
  assert.equal(parseContentType('application/grpc-web').mode, 'binary');
  assert.equal(parseContentType('application/grpc-web+proto').mode, 'binary');
  assert.equal(parseContentType('application/grpc-web-text').mode, 'text');
  assert.equal(parseContentType('application/grpc-web-text+proto').mode, 'text');
  assert.equal(parseContentType('Application/GRPC-Web-Text; charset=utf-8').mode, 'text');
  assert.equal(parseContentType('  application/grpc-web  ').mode, 'binary');
});

test('parseContentType rejects unrelated media types', () => {
  assert.throws(
    () => parseContentType('application/json'),
    (e: any) => e instanceof UnsupportedContentTypeError,
  );
  assert.throws(() => parseContentType('text/plain'), UnsupportedContentTypeError);
});

test('resolveMode prefers the header and falls back to the default', () => {
  assert.equal(resolveMode('application/grpc-web-text', 'binary'), 'text');
  assert.equal(resolveMode(undefined, 'text'), 'text');
});

test('a non-200 HTTP response is rejected, not decoded', () => {
  assert.throws(
    () => createDecoderForResponse({ status: 404, contentType: 'application/grpc-web' }),
    (e: any) => e instanceof HttpStatusError && e.status === 404,
  );
  assert.throws(() => createDecoderForResponse({ status: 500 }), HttpStatusError);
});

test('a supported Content-Type yields the matching decoder mode', () => {
  const binary = createDecoderForResponse({ status: 200, contentType: 'application/grpc-web' });
  assert.equal(binary.mode, 'binary');
  binary.destroy();

  const text = createDecoderForResponse({ status: 200, contentType: 'application/grpc-web-text' });
  assert.equal(text.mode, 'text');
  text.destroy();

  const absent = createDecoderForResponse({ status: 200 });
  assert.equal(absent.mode, 'binary');
  absent.destroy();
});

test('an unsupported Content-Type is rejected', () => {
  assert.throws(
    () => createDecoderForResponse({ status: 200, contentType: 'application/json' }),
    UnsupportedContentTypeError,
  );
});

test('decodeHttpResponseBody decodes a binary response', async () => {
  const body = okBody();
  const result = await decodeHttpResponseBody(chunks(body, 3), {
    status: 200,
    contentType: 'application/grpc-web',
  });
  assert.deepEqual(result.messages.map((m) => m.toString()), ['one', 'two']);
  assert.equal(result.trailer.status, 0);
  assert.deepEqual(result.items.map((i) => i.type), ['message', 'message', 'trailer']);
});

test('decodeHttpResponseBody decodes a segmented text response', async () => {
  const text = Buffer.from(toText(okBody(), [1, 4, 9]), 'ascii');
  const result = await decodeHttpResponseBody(chunks(text, 5), {
    status: 200,
    contentType: 'application/grpc-web-text',
  });
  assert.deepEqual(result.messages.map((m) => m.toString()), ['one', 'two']);
});

test('decodeHttpResponseBody rejects a non-zero status with GrpcStatusError', async () => {
  const body = frameBytes(...messages('m'), trailer({ 'grpc-status': '3', 'grpc-message': 'bad' }));
  await assert.rejects(
    decodeHttpResponseBody(chunks(body, 4), { status: 200 }),
    (e: any) => e instanceof GrpcStatusError && e.status === 3 && e.grpcMessage === 'bad',
  );
});

test('decodeHttpResponseBody rejects an HTTP error before reading the body', async () => {
  let read = false;
  async function* source(): AsyncGenerator<Uint8Array> {
    read = true;
    yield new Uint8Array();
  }
  await assert.rejects(
    decodeHttpResponseBody(source(), { status: 503 }),
    (e: any) => e instanceof HttpStatusError,
  );
  assert.equal(read, false, 'the body must not be consumed for a non-200 response');
});
