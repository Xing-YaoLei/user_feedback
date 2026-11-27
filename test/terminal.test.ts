/**
 * Terminal-state semantics: what may and may not be reported as success.
 *
 * The rule under test: success is announced only after the entire input has
 * been validated.  HTTP 200 (an empty body), the first message, or a trailer
 * whose bytes have not yet been followed by end-of-input are never enough.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeChunks, GrpcWebResponseDecoder } from '../src/decoder.ts';
import { GrpcStatusError, LimitError, ProtocolError } from '../src/errors.ts';
import {
  attempt,
  collect,
  errorOf,
  frameBytes,
  messages,
  rawTrailer,
  trailer,
} from './support/fixtures.ts';

const okBody = frameBytes(...messages('one', 'two'), trailer({ 'grpc-status': '0' }));

test('success requires a trailer: an empty body is not success', () => {
  const err = errorOf(attempt([Buffer.alloc(0)]));
  assert.equal(err.code, 'MISSING_TRAILER');
});

test('messages alone are not success', () => {
  const err = errorOf(attempt([frameBytes(...messages('one', 'two'))]));
  assert.equal(err.code, 'MISSING_TRAILER');
});

test('a complete OK exchange succeeds and exposes the trailer', () => {
  const { messages: decoded, trailer: t } = collect([okBody]);
  assert.equal(decoded.length, 2);
  assert.equal(t.status, 0);
  assert.equal(t.statusText, 'OK');
});

test('truncated payload is not success', () => {
  const cut = okBody.subarray(0, okBody.length - 3);
  assert.equal(errorOf(attempt([cut])).code, 'TRUNCATED_INPUT');
});

test('truncated frame header is not success', () => {
  // A body that begins with only 2 bytes of a 5-byte frame header.
  const head = Buffer.alloc(5);
  head[0] = 0x00;
  head.writeUInt32BE(10, 1);
  assert.equal(errorOf(attempt([head.subarray(0, 2)])).code, 'TRUNCATED_INPUT');
});

test('input that ends inside a trailer payload is not success', () => {
  const body = frameBytes(...messages('one'), trailer({ 'grpc-status': '0' }));
  const cut = body.subarray(0, body.length - 1);
  assert.equal(errorOf(attempt([cut])).code, 'TRUNCATED_INPUT');
});

test('a non-zero status is a completed response, not a protocol error', () => {
  const body = frameBytes(
    ...messages('partial'),
    trailer({ 'grpc-status': '14', 'grpc-message': 'unavailable' }),
  );
  const { messages: decoded, trailer: t } = collect([body]);
  assert.equal(decoded.length, 1);
  assert.equal(t.status, 14);
  assert.equal(t.statusText, 'UNAVAILABLE');
  assert.equal(t.message, 'unavailable');
});

test('throwOnNonZeroStatus produces GrpcStatusError with details', () => {
  const body = frameBytes(
    ...messages('partial'),
    trailer({ 'grpc-status': '5', 'grpc-message': 'missing%20thing' }),
  );
  let caught: unknown;
  try {
    decodeChunks([body], { throwOnNonZeroStatus: true });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GrpcStatusError);
  assert.equal(caught.status, 5);
  assert.equal(caught.grpcMessage, 'missing thing');
  assert.ok(!(caught instanceof ProtocolError));
});

test('protocol failures carry distinct error classes', () => {
  // Malformed trailer: missing grpc-status.
  const missing = errorOf(attempt([frameBytes(...messages('a'), rawTrailer('grpc-message: x'))]));
  assert.ok(missing instanceof ProtocolError);
  assert.equal(missing.code, 'MISSING_GRPC_STATUS');

  // Malformed frame flag.
  const badFlag = errorOf(
    attempt([Buffer.concat([Buffer.from([0x40, 0, 0, 0, 0]), Buffer.from('grpc-status: 0')])]),
  );
  assert.ok(badFlag instanceof ProtocolError);
  assert.equal(badFlag.code, 'MALFORMED_FRAME');
});

test('limit failures are LimitError, distinct from protocol errors', () => {
  const err = errorOf(attempt([okBody], { maxMessageSize: 1 }));
  assert.ok(err instanceof LimitError);
  assert.equal(err.code, 'MESSAGE_TOO_LARGE');
});

test('a non-zero status split across many chunks still decodes', () => {
  const body = frameBytes(
    ...messages('m'),
    trailer({ 'grpc-status': '7', 'grpc-message': 'no' }),
  );
  const chunks: Buffer[] = [];
  for (let i = 0; i < body.length; i++) chunks.push(body.subarray(i, i + 1));
  const { trailer: t } = collect(chunks);
  assert.equal(t.status, 7);
});

test('finish() cannot be called twice', () => {
  const decoder = new GrpcWebResponseDecoder();
  decoder.write(okBody);
  while (decoder.next() !== null) {
    /* drain */
  }
  decoder.finish();
  assert.throws(() => decoder.finish(), /more than once/);
});

test('trailerSeen becomes true before finish, finished only after', () => {
  const decoder = new GrpcWebResponseDecoder();
  decoder.write(okBody);
  while (decoder.next() !== null) {
    /* drain */
  }
  assert.equal(decoder.trailerSeen, true);
  assert.equal(decoder.finished, false, 'a trailer alone must not mark success');
  decoder.finish();
  assert.equal(decoder.finished, true);
});
