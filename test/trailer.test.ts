/**
 * Trailer frame semantics: field syntax, grpc-status cardinality and value
 * validation, grpc-message decoding, and the strict ordering rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeGrpcMessage, parseTrailer, validateTrailer } from '../src/trailer.ts';
import { GrpcStatusError, ProtocolError } from '../src/errors.ts';
import {
  attempt,
  collect,
  errorOf,
  frameBytes,
  messages,
  rawFrame,
  rawTrailer,
  trailer,
  trailerText,
} from './support/fixtures.ts';
import { FLAG_DATA, FLAG_TRAILER } from '../src/frame.ts';

function withTrailer(text: string): Buffer {
  return frameBytes(...messages('m'), rawTrailer(text));
}

test('lower-case CRLF-separated trailer fields parse', () => {
  const t = parseTrailer(Buffer.from('grpc-status: 0\r\ngrpc-message: hi\r\nx-trace: abc'));
  assert.equal(t.fields.get('grpc-status'), '0');
  assert.equal(t.fields.get('grpc-message'), 'hi');
  assert.equal(t.fields.get('x-trace'), 'abc');
  assert.deepEqual(
    t.entries.map((e) => e.name),
    ['grpc-status', 'grpc-message', 'x-trace'],
  );
});

test('trailer values may be empty and may contain internal spaces', () => {
  const t = parseTrailer(Buffer.from('grpc-status: 0\r\ngrpc-message: bad thing happened'));
  assert.equal(t.fields.get('grpc-message'), 'bad thing happened');
  const empty = parseTrailer(Buffer.from('grpc-status:0\r\ngrpc-message:'));
  assert.equal(empty.fields.get('grpc-message'), '');
});

test('duplicate grpc-status is rejected', () => {
  const err = errorOf(attempt([withTrailer('grpc-status: 0\r\ngrpc-status: 0')]));
  assert.equal(err.code, 'DUPLICATE_GRPC_STATUS');
});

test('missing grpc-status is rejected', () => {
  const err = errorOf(attempt([withTrailer('grpc-message: nope')]));
  assert.equal(err.code, 'MISSING_GRPC_STATUS');
});

test('non-integer grpc-status is rejected', () => {
  for (const value of ['abc', '0x1', '1.5', '-1', ' 0x', '+1', '']) {
    const err = errorOf(attempt([withTrailer(`grpc-status: ${value}`)]));
    assert.equal(err.code, 'INVALID_GRPC_STATUS', `grpc-status ${JSON.stringify(value)}`);
  }
});

test('grpc-status outside the defined code range is rejected', () => {
  for (const value of ['17', '99', '99999999999999999999']) {
    const err = errorOf(attempt([withTrailer(`grpc-status: ${value}`)]));
    assert.equal(err.code, 'INVALID_GRPC_STATUS', `grpc-status ${value}`);
  }
});

test('every defined status 0..16 is accepted', () => {
  for (let status = 0; status <= 16; status++) {
    const { trailer: t } = collect([withTrailer(`grpc-status: ${status}`)]);
    assert.equal(t.status, status);
  }
});

test('upper-case header names are rejected', () => {
  const err = errorOf(attempt([withTrailer('Grpc-Status: 0')]));
  assert.equal(err.code, 'MALFORMED_TRAILER');
});

test('a field without a colon is rejected', () => {
  const err = errorOf(attempt([withTrailer('grpc-status: 0\r\nnot-a-field')]));
  assert.equal(err.code, 'MALFORMED_TRAILER');
});

test('bare LF separators are rejected', () => {
  const err = errorOf(attempt([withTrailer('grpc-status: 0\ngrpc-message: x')]));
  assert.equal(err.code, 'MALFORMED_TRAILER');
});

test('bytes of a partial frame after the trailer are still a frame after the trailer', () => {
  const trailerBytes = frameBytes(rawTrailer('grpc-status: 0'));
  const withPartial = Buffer.concat([trailerBytes, Buffer.from([0x00, 0x00, 0x00])]);
  const err = errorOf(attempt([withPartial]));
  assert.equal(err.code, 'FRAME_AFTER_TRAILER');
});

test('a trailing blank line is rejected', () => {
  const err = errorOf(attempt([withTrailer('grpc-status: 0\r\n')]));
  assert.equal(err.code, 'MALFORMED_TRAILER');
});

test('an empty trailer payload is rejected', () => {
  const err = errorOf(attempt([withTrailer('')]));
  assert.equal(err.code, 'MALFORMED_TRAILER');
});

test('control bytes in a trailer value are rejected', () => {
  const err = errorOf(attempt([withTrailer('grpc-status: 0\r\ngrpc-message: a\x00b')]));
  assert.equal(err.code, 'MALFORMED_TRAILER');
});

test('non-zero status carries the decoded grpc-message', () => {
  const { trailer: t } = collect([withTrailer('grpc-status: 5\r\ngrpc-message: not%20found%3A%20x')]);
  assert.equal(t.status, 5);
  assert.equal(t.statusText, 'NOT_FOUND');
  assert.equal(t.message, 'not found: x');
  assert.equal(t.rawMessage, 'not%20found%3A%20x');
});

test('grpc-message percent-decoding handles UTF-8', () => {
  assert.equal(decodeGrpcMessage('%E4%BD%A0%E5%A5%BD'), '你好');
  assert.equal(decodeGrpcMessage('plain'), 'plain');
  // Invalid escapes survive literally rather than corrupting the string.
  assert.equal(decodeGrpcMessage('100%'), '100%');
  assert.equal(decodeGrpcMessage('%zz'), '%zz');
});

test('grpc-status 0 has no error message requirement', () => {
  const { trailer: t } = collect([withTrailer('grpc-status: 0')]);
  assert.equal(t.message, undefined);
});

test('a frame after the trailer is rejected', () => {
  const body = Buffer.concat([
    frameBytes(...messages('m'), trailer({ 'grpc-status': '0' })),
    rawFrame(FLAG_DATA, 'late'),
  ]);
  const err = errorOf(attempt([body]));
  assert.equal(err.code, 'FRAME_AFTER_TRAILER');
});

test('a second trailer frame is rejected as a frame after the trailer', () => {
  const body = Buffer.concat([
    frameBytes(...messages('m'), trailer({ 'grpc-status': '0' })),
    rawFrame(FLAG_TRAILER, 'grpc-status: 0'),
  ]);
  const err = errorOf(attempt([body]));
  assert.equal(err.code, 'FRAME_AFTER_TRAILER');
});

test('frames arriving after the trailer in a later chunk are rejected', () => {
  const body = Buffer.concat([
    frameBytes(...messages('m'), trailer({ 'grpc-status': '0' })),
    rawFrame(FLAG_DATA, 'late'),
  ]);
  const split = Buffer.from(body);
  const chunks = [split.subarray(0, split.length - 6), split.subarray(split.length - 6)];
  const err = errorOf(attempt(chunks));
  assert.equal(err.code, 'FRAME_AFTER_TRAILER');
});

test('a trailer that is complete but not followed by end-of-input never succeeds', () => {
  const body = Buffer.concat([frameBytes(...messages('m')), frameBytes(rawTrailer('grpc-status: 0'))]);
  const chunks = [body.subarray(0, body.length - 1)];
  // The final byte is missing, so the exchange is truncated, not successful.
  assert.equal(errorOf(attempt(chunks)).code, 'TRUNCATED_INPUT');
});

test('validateTrailer exposes the parsed trailer', () => {
  const parsed = parseTrailer(Buffer.from('grpc-status: 3\r\ngrpc-message: x'));
  const validated = validateTrailer(parsed);
  assert.equal(validated.status, 3);
  assert.equal(validated.statusText, 'INVALID_ARGUMENT');
  assert.equal(validated.trailer, parsed);
});

test('trailerText helper round-trips through parseTrailer', () => {
  const text = trailerText({ 'grpc-status': '7', 'grpc-message': 'denied' });
  const t = parseTrailer(Buffer.from(text));
  assert.equal(t.fields.get('grpc-message'), 'denied');
});

test('GrpcStatusError is not a ProtocolError', () => {
  const err = new GrpcStatusError(2, 'UNKNOWN', 'x', 'x', parseTrailer(Buffer.from('grpc-status: 2')));
  assert.ok(!(err instanceof ProtocolError));
  assert.equal(err.code, 'GRPC_STATUS');
});
