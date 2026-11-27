/**
 * Size limits: the per-message limit and the unparsed-buffer limit are
 * independent, configurable, and enforced at the right moment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GrpcWebResponseDecoder } from '../src/decoder.ts';
import { LimitError } from '../src/errors.ts';
import { attempt, errorOf, frameBytes, oneByteAtATime, trailer } from './support/fixtures.ts';

function drain(decoder: GrpcWebResponseDecoder): Buffer[] {
  const out: Buffer[] = [];
  for (let item = decoder.next(); item !== null; item = decoder.next()) out.push(item.data);
  return out;
}

test('default limits allow ordinary messages', () => {
  const body = frameBytes({ kind: 'message', payload: Buffer.alloc(1024, 1) }, trailer({ 'grpc-status': '0' }));
  const result = attempt([body]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.messages.length, 1);
});

test('maxMessageSize rejects an oversized frame declared in its header', () => {
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(500, 1);
  const err = errorOf(attempt([header], { maxMessageSize: 499 }));
  assert.equal(err.code, 'MESSAGE_TOO_LARGE');
  assert.ok(err instanceof LimitError);
});

test('maxMessageSize is inclusive of the boundary', () => {
  const body = frameBytes({ kind: 'message', payload: Buffer.alloc(10) }, trailer({ 'grpc-status': '0' }));
  assert.equal(attempt([body], { maxMessageSize: 10 }).ok, true);
  assert.equal(errorOf(attempt([body], { maxMessageSize: 9 })).code, 'MESSAGE_TOO_LARGE');
});

test('maxUnparsedBytes rejects bytes that never form a frame', () => {
  // Bytes that are pure junk: a valid header would need 5 bytes; give fewer.
  const junk = Buffer.from([0x00, 0x00, 0x00]);
  assert.equal(errorOf(attempt([junk], { maxUnparsedBytes: 2 })).code, 'BUFFER_LIMIT_EXCEEDED');
});

test('a large message delivered in one chunk does not count against the unparsed limit', () => {
  // The frame is complete on arrival, so it is parsed out of the buffer before
  // the unparsed limit is consulted: only truly unparsed bytes count.
  const payload = Buffer.alloc(4096, 0x41);
  const body = frameBytes({ kind: 'message', payload }, trailer({ 'grpc-status': '0' }));
  const { messages: decoded } = collectViaDecoder(body, { maxMessageSize: 4096, maxUnparsedBytes: 1024 });
  assert.equal(decoded[0]!.length, 4096);
});

test('the same large message dribbled in fails the unparsed limit', () => {
  // Nothing can be parsed until the payload completes, so bytes accumulate as
  // unparsed and the (smaller) buffer limit applies.
  const payload = Buffer.alloc(4096, 0x41);
  const body = frameBytes({ kind: 'message', payload }, trailer({ 'grpc-status': '0' }));
  const err = errorOf(
    attempt(oneByteAtATime(body), { maxMessageSize: 4096, maxUnparsedBytes: 1024 }),
  );
  assert.equal(err.code, 'BUFFER_LIMIT_EXCEEDED');
});

test('the same large message dribbled in succeeds when the buffer limit fits it', () => {
  const payload = Buffer.alloc(4096, 0x41);
  const body = frameBytes({ kind: 'message', payload }, trailer({ 'grpc-status': '0' }));
  const { messages: decoded } = collectViaDecoder(body, {
    maxMessageSize: 4096,
    maxUnparsedBytes: 4096 + 5,
  });
  assert.equal(decoded[0]!.length, 4096);
});

test('limits are enforced progressively, not only at the end', () => {
  const payload = Buffer.alloc(100, 0x42);
  const body = frameBytes({ kind: 'message', payload }, trailer({ 'grpc-status': '0' }));
  const decoder = new GrpcWebResponseDecoder({ maxUnparsedBytes: 50 });
  let thrown: any;
  try {
    for (const chunk of oneByteAtATime(body)) {
      decoder.write(chunk);
      drain(decoder);
    }
    decoder.finish();
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, 'BUFFER_LIMIT_EXCEEDED');
});

test('invalid constructor options are rejected', () => {
  assert.throws(() => new GrpcWebResponseDecoder({ maxMessageSize: 0 }), RangeError);
  assert.throws(() => new GrpcWebResponseDecoder({ maxUnparsedBytes: -1 }), RangeError);
  assert.throws(() => new GrpcWebResponseDecoder({ mode: 'json' as any }), TypeError);
});

function collectViaDecoder(
  body: Uint8Array,
  options: ConstructorParameters<typeof GrpcWebResponseDecoder>[0],
): { messages: Buffer[]; trailer: unknown } {
  const decoder = new GrpcWebResponseDecoder(options);
  decoder.write(body);
  const out = drain(decoder);
  const trailerItem = decoder.finish();
  return { messages: out, trailer: trailerItem };
}
