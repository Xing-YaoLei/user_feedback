/**
 * grpc-web-text (base64) behaviour.
 *
 * The interesting cases are segmentation: several independently padded base64
 * blocks concatenated, and input chunks that split a quartet, a padding run, a
 * frame header or a trailer line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Base64StreamDecoder } from '../src/base64.ts';
import { ProtocolError } from '../src/errors.ts';
import {
  attempt,
  collect,
  errorOf,
  fixedSize,
  frameBytes,
  messages,
  oneByteAtATime,
  randomSplits,
  toText,
  trailer,
} from './support/fixtures.ts';

const binary = frameBytes(
  ...messages('alpha', 'bravo', 'charlie'),
  trailer({ 'grpc-status': '0', 'grpc-message': 'ok' }),
);

function texts(binaryBody: Buffer): Map<string, string> {
  const cuts: Array<[string, number[]]> = [
    ['one block', []],
    ['after 1 byte', [1]],
    ['after 2 bytes', [2]],
    ['after 3 bytes', [3]],
    ['every byte boundary', [...Array(binaryBody.length - 1).keys()].map((i) => i + 1)],
    ['mid frame payload', [7, 15, 23]],
  ];
  const map = new Map<string, string>();
  for (const [label, points] of cuts) map.set(label, toText(binaryBody, points));
  return map;
}

test('one contiguous base64 body decodes', () => {
  const text = binary.toString('base64');
  const { messages: decoded, trailer: t } = collect([Buffer.from(text, 'ascii')], { mode: 'text' });
  assert.deepEqual(
    decoded.map((m) => m.toString()),
    ['alpha', 'bravo', 'charlie'],
  );
  assert.equal(t.status, 0);
});

test('multiple independently padded base64 segments concatenate correctly', () => {
  for (const [label, text] of texts(binary)) {
    const { messages: decoded, trailer: t } = collect([Buffer.from(text, 'ascii')], { mode: 'text' });
    assert.deepEqual(
      decoded.map((m) => m.toString()),
      ['alpha', 'bravo', 'charlie'],
      `segmentation: ${label}`,
    );
    assert.equal(t.status, 0, `segmentation: ${label}`);
  }
});

test('base64 segment boundaries are independent of message boundaries', () => {
  // Cut inside a single frame's payload: three messages remain intact.
  const text = toText(binary, [6]);
  const { messages: decoded } = collect([Buffer.from(text, 'ascii')], { mode: 'text' });
  assert.deepEqual(
    decoded.map((m) => m.toString()),
    ['alpha', 'bravo', 'charlie'],
  );
});

test('one-byte chunks over a segmented text body decode', () => {
  const text = toText(binary, [1, 2, 3, 5, 8]);
  const bytes = Buffer.from(text, 'ascii');
  const { messages: decoded } = collect(oneByteAtATime(bytes), { mode: 'text' });
  assert.deepEqual(
    decoded.map((m) => m.toString()),
    ['alpha', 'bravo', 'charlie'],
  );
});

test('chunking may split base64 quartets anywhere', () => {
  const text = Buffer.from(toText(binary, [4, 9]), 'ascii');
  const expected = ['alpha', 'bravo', 'charlie'];
  for (const size of [1, 2, 3, 5, 7, 11]) {
    const { messages: decoded } = collect(fixedSize(size)(text), { mode: 'text' });
    assert.deepEqual(decoded.map((m) => m.toString()), expected, `chunk size ${size}`);
  }
});

test('random text chunkings decode identically', () => {
  const text = Buffer.from(toText(binary, [2, 7, 13, 21]), 'ascii');
  for (const chunks of randomSplits(text, 99, 9)) {
    const { messages: decoded } = collect(chunks, { mode: 'text' });
    assert.deepEqual(decoded.map((m) => m.toString()), ['alpha', 'bravo', 'charlie']);
  }
});

test('whitespace between base64 characters is ignored', () => {
  const text = binary.toString('base64');
  const wrapped = text.match(/.{1,8}/g)!.join('\r\n');
  const { messages: decoded } = collect([Buffer.from(wrapped, 'ascii')], { mode: 'text' });
  assert.deepEqual(decoded.map((m) => m.toString()), ['alpha', 'bravo', 'charlie']);
});

test('invalid base64 characters are rejected', () => {
  const err = errorOf(attempt([Buffer.from('!!!!')], { mode: 'text' }));
  assert.ok(err instanceof ProtocolError);
  assert.equal(err.code, 'MALFORMED_BASE64');
});

test('truncated base64 (dangling quartet) is rejected', () => {
  // 4 chars encode 3 bytes; drop one -> a dangling 3-char quartet.
  const text = binary.subarray(0, 3).toString('base64');
  const bytes = Buffer.from(text, 'ascii');
  const err = errorOf(attempt([bytes.subarray(0, bytes.length - 1)], { mode: 'text' }));
  assert.equal(err.code, 'TRUNCATED_INPUT');
});

test('base64 with a missing padding character is rejected', () => {
  // "QQ==" pads a single byte; drop the final '='.
  const bytes = Buffer.from('QQ=', 'ascii');
  const err = errorOf(attempt([bytes], { mode: 'text' }));
  assert.equal(err.code, 'TRUNCATED_INPUT');
});

test('base64 padding after one character is rejected', () => {
  const err = errorOf(attempt([Buffer.from('Q===', 'ascii')], { mode: 'text' }));
  assert.equal(err.code, 'MALFORMED_BASE64');
});

test('Base64StreamDecoder can decode across arbitrary feed sizes', () => {
  const source = frameBytes(...messages('xyz'), trailer({ 'grpc-status': '0' }));
  const encoded = Buffer.from(source.toString('base64'), 'ascii');
  for (const size of [1, 2, 3, 4, 5, 8]) {
    const decoder = new Base64StreamDecoder();
    const parts: Buffer[] = [];
    for (let i = 0; i < encoded.length; i += size) {
      parts.push(decoder.feed(encoded.subarray(i, Math.min(i + size, encoded.length))));
    }
    decoder.end();
    assert.deepEqual(Buffer.concat(parts), source, `feed size ${size}`);
  }
});

const trailerHeavy = frameBytes(
  ...messages('m'),
  trailer({
    'grpc-status': '3',
    'grpc-message': 'a%20message%20with%20spaces',
    'x-very-long-header': 'y'.repeat(40),
    'x-another': 'z'.repeat(30),
  }),
);

test('a text body can be cut anywhere, including inside trailer lines', () => {
  const text = Buffer.from(trailerHeavy.toString('base64'), 'ascii');
  const expected = collect([Buffer.from(text)], { mode: 'text' });
  for (const { length, bytes } of prefixes(text)) {
    const result = attempt([bytes], { mode: 'text' });
    if (length === text.length) continue;
    assert.equal(result.ok, false, `text prefix of ${length} bytes must not succeed`);
  }
  // Every prefix that ends on a base64 boundary but before the trailer decodes
  // to a *prefix* of the messages, never to a terminal success.
  assert.deepEqual(expected.messages.map((m) => m.toString()), ['m']);
  assert.equal(expected.trailer.status, 3);
});

test('trailer payload split one byte at a time in text mode still validates', () => {
  const text = Buffer.from(trailerHeavy.toString('base64'), 'ascii');
  // Segment boundaries fall at arbitrary points: feed every fixed size.
  for (let size = 1; size <= Math.min(12, text.length); size++) {
    const body = fixedSize(size)(text);
    const { trailer: t } = collect(body, { mode: 'text' });
    assert.equal(t.status, 3);
    assert.equal(t.message, 'a message with spaces');
    assert.equal(t.trailer.fields.get('x-very-long-header'), 'y'.repeat(40));
  }
});

function prefixes(bytes: Buffer): Array<{ length: number; bytes: Buffer }> {
  const out: Array<{ length: number; bytes: Buffer }> = [];
  for (let length = 0; length <= bytes.length; length++) out.push({ length, bytes: bytes.subarray(0, length) });
  return out;
}
