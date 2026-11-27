/**
 * Frame-level behaviour: header parsing, flag validation, size limits and
 * arbitrary chunk boundaries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeFrame, FLAG_COMPRESSED, FLAG_DATA, FLAG_TRAILER, FrameReader } from '../src/frame.ts';
import { UnsupportedCompressionError, ProtocolError, LimitError } from '../src/errors.ts';
import {
  attempt,
  collect,
  errorOf,
  fixedSize,
  frameBytes,
  messages,
  oneByteAtATime,
  rawFrame,
  randomSplits,
  everyTwoWaySplit,
  trailer,
} from './support/fixtures.ts';

const body = frameBytes(
  ...messages('first', 'second', 'third'),
  trailer({ 'grpc-status': '0', 'grpc-message': '' }),
);

test('data frames are emitted in arrival order', () => {
  const { messages: decoded } = collect([body]);
  assert.deepEqual(
    decoded.map((m) => m.toString()),
    ['first', 'second', 'third'],
  );
});

test('one-byte chunks produce the same result as one big chunk', () => {
  const whole = collect([body]);
  const dribbled = collect(oneByteAtATime(body));
  assert.deepEqual(dribbled.messages, whole.messages);
  assert.equal(dribbled.trailer.status, whole.trailer.status);
});

test('every two-way split produces the same result', () => {
  const expected = collect([body]).messages.map((m) => m.toString());
  for (const chunks of everyTwoWaySplit(body)) {
    const got = collect(chunks).messages.map((m) => m.toString());
    assert.deepEqual(got, expected, `split at ${chunks[0]!.length}`);
  }
});

test('random chunkings produce the same result', () => {
  const expected = collect([body]).messages.map((m) => m.toString());
  for (const chunks of randomSplits(body, 1234, 7)) {
    assert.deepEqual(collect(chunks).messages.map((m) => m.toString()), expected);
  }
});

test('zero-length frames are valid and yield empty messages', () => {
  const zero = frameBytes(
    { kind: 'message', payload: Buffer.alloc(0) },
    ...messages('x'),
    trailer({ 'grpc-status': '0' }),
  );
  const { messages: decoded } = collect([zero]);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0]!.length, 0);
  assert.equal(decoded[1]!.toString(), 'x');
});

test('compressed data frame (0x01) is rejected as unsupported', () => {
  const compressed = Buffer.concat([rawFrame(FLAG_COMPRESSED, 'abc'), rawFrame(FLAG_TRAILER, 'grpc-status: 0')]);
  const err = errorOf(attempt([compressed]));
  assert.ok(err instanceof UnsupportedCompressionError);
  assert.equal(err.code, 'UNSUPPORTED_COMPRESSION');
});

test('compressed trailer frame (0x81) is rejected as unsupported', () => {
  const compressed = Buffer.concat([rawFrame(FLAG_TRAILER | FLAG_COMPRESSED, 'grpc-status: 0')]);
  const err = errorOf(attempt([compressed]));
  assert.ok(err instanceof UnsupportedCompressionError);
});

test('any other compressed flag value is rejected as unsupported', () => {
  for (const flag of [0x01, 0x03, 0x09, 0x81, 0xff]) {
    const err = errorOf(attempt([rawFrame(flag, 'x')]));
    assert.equal(err.code, 'UNSUPPORTED_COMPRESSION', `flag 0x${flag.toString(16)}`);
  }
});

test('unknown uncompressed frame flags are malformed frames', () => {
  for (const flag of [0x02, 0x10, 0x40]) {
    const err = errorOf(attempt([rawFrame(flag, 'x')]));
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, 'MALFORMED_FRAME', `flag 0x${flag.toString(16)}`);
  }
});

test('declared length larger than maxMessageSize is rejected before the payload arrives', () => {
  // Header only: declares 100 bytes but no payload is ever supplied.
  const header = Buffer.alloc(5);
  header[0] = FLAG_DATA;
  header.writeUInt32BE(100, 1);
  const err = errorOf(attempt([header], { maxMessageSize: 99 }));
  assert.ok(err instanceof LimitError);
  assert.equal(err.code, 'MESSAGE_TOO_LARGE');
});

test('a message exactly at maxMessageSize is accepted', () => {
  const payload = Buffer.alloc(64, 0x41);
  const exact = frameBytes(
    { kind: 'message', payload },
    trailer({ 'grpc-status': '0' }),
  );
  const { messages: decoded } = collect([exact], { maxMessageSize: 64 });
  assert.equal(decoded[0]!.length, 64);
});

test('oversized trailer frame is rejected with its own code', () => {
  const ok = frameBytes(...messages('a'), trailer({ 'grpc-status': '0', pad: 'x'.repeat(200) }));
  const err = errorOf(attempt([ok], { maxTrailerSize: 100 }));
  assert.equal(err.code, 'TRAILER_TOO_LARGE');
});

test('buffer limit trips when junk accumulates without forming a frame', () => {
  // A header declaring a large payload followed by a trickle of bytes: the
  // per-message limit is high enough, but the unparsed-buffer limit is not.
  const header = Buffer.alloc(5);
  header[0] = FLAG_DATA;
  header.writeUInt32BE(1000, 1);
  const err = errorOf(
    attempt([header, Buffer.alloc(200, 0)], { maxMessageSize: 4096, maxUnparsedBytes: 128 }),
  );
  assert.equal(err.code, 'BUFFER_LIMIT_EXCEEDED');
});

test('frame header split one byte at a time is handled', () => {
  const frame = frameBytes(...messages('hello'), trailer({ 'grpc-status': '0' }));
  const { messages: decoded } = collect(fixedSize(1)(frame));
  assert.equal(decoded[0]!.toString(), 'hello');
});

test('FrameReader reports buffered bytes and header state', () => {
  const reader = new FrameReader({ maxMessageSize: 1024, maxTrailerSize: 1024 });
  assert.equal(reader.bufferedBytes, 0);
  assert.equal(reader.peekHeader(), null);
  reader.append(encodeFrame(FLAG_DATA, Buffer.from('abc')));
  assert.deepEqual(reader.peekHeader(), { flag: FLAG_DATA, length: 3 });
  assert.equal(reader.bufferedBytes, 8);
  const ev = reader.next();
  assert.equal(ev?.kind, 'message');
  assert.equal(reader.bufferedBytes, 0);
  assert.equal(reader.next(), null);
});

test('FrameReader copies appended input so caller mutation is harmless', () => {
  const reader = new FrameReader({ maxMessageSize: 1024, maxTrailerSize: 1024 });
  const mutable = encodeFrame(FLAG_DATA, Buffer.from('abc'));
  reader.append(mutable);
  mutable.fill(0);
  const ev = reader.next();
  assert.equal(ev?.payload.toString(), 'abc');
});
