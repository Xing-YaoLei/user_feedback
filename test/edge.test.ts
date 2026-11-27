/**
 * Edge cases around buffer views, large field numbers, limits, and mutation
 * safety.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeMessage,
  inspectMessage,
  ProtobufRewriteError,
  rewriteMessage,
  type FieldSchemaInput,
} from '../src/index.ts';
import { delimited, scan, tag, utf8Field, varint, varintField } from './helpers.ts';

const SCHEMA: FieldSchemaInput = {
  1: 'uint64',
  4: 'string',
  7: { type: 'uint64', repeated: true },
};

function expectError(fn: () => unknown): ProtobufRewriteError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProtobufRewriteError, `got ${String(error)}`);
    return error;
  }
  assert.fail('expected ProtobufRewriteError');
}

test('input may be a subarray view into a larger buffer', () => {
  const prefix = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const suffix = Buffer.from([0xca, 0xfe]);
  const message = Buffer.concat([varintField(1, 1n), utf8Field(4, 'inside')]);
  const whole = Buffer.concat([prefix, message, suffix]);
  const view = whole.subarray(prefix.length, prefix.length + message.length);

  const output = rewriteMessage(view, SCHEMA, { 1: 2n });
  assert.equal(
    output.toString('hex'),
    Buffer.concat([varintField(1, 2n), utf8Field(4, 'inside')]).toString('hex'),
  );
  // The input's neighbours are untouched.
  assert.equal(whole.subarray(0, prefix.length).toString('hex'), prefix.toString('hex'));
  assert.equal(whole.subarray(prefix.length + message.length).toString('hex'), suffix.toString('hex'));
});

test('the input buffer is never mutated and the output is independent', () => {
  const input = Buffer.concat([varintField(1, 1n), utf8Field(4, 'abc')]);
  const snapshot = Buffer.from(input);

  const output = rewriteMessage(input, SCHEMA, { 4: 'xyz' });
  assert.deepEqual(input, snapshot, 'input bytes unchanged');

  // Mutating the output must not reach back into the input.
  output.fill(0x00);
  assert.deepEqual(input, snapshot);
});

test('maximum field number 2^29-1 round-trips', () => {
  const maxField = 536870911;
  const input = Buffer.concat([tag(maxField, 0), varint(7)]);
  const schema: FieldSchemaInput = new Map([[maxField, 'uint64']]);

  const output = rewriteMessage(input, schema, { [maxField]: 8n });
  assert.equal(output.toString('hex'), Buffer.concat([tag(maxField, 0), varint(8)]).toString('hex'));

  // One above the maximum is rejected on the wire.
  const tooBig = Buffer.concat([tag(536870912, 0), varint(7)]);
  const error = expectError(() => rewriteMessage(tooBig, SCHEMA, {}));
  assert.equal(error.code, 'INVALID_FIELD_NUMBER');
});

test('a field number above 2^29-1 encoded in a long varint is still rejected', () => {
  // Tag encoding for field 2^29 uses a 5-byte varint; a 6-byte over-long one too.
  const tagValue = BigInt(536870912) * 8n;
  for (const bytes of [varint(tagValue), Buffer.from([...varint(tagValue & 0x7fn), 0x80, 0x00])]) {
    void bytes;
  }
  const longTag = varint(tagValue);
  const error = expectError(() => rewriteMessage(Buffer.concat([longTag, varint(1)]), SCHEMA, {}));
  assert.equal(error.code, 'INVALID_FIELD_NUMBER');
  assert.equal(error.offset, 0);
});

test('an empty length-delimited payload is legal for string and bytes', () => {
  const input = Buffer.concat([delimited(4, Buffer.alloc(0))]);
  assert.equal(rewriteMessage(input, SCHEMA, {}).toString('hex'), input.toString('hex'));
  assert.equal(decodeMessage(input, SCHEMA).fields.get(4)!.value, '');

  const output = rewriteMessage(input, SCHEMA, { 4: '' });
  assert.equal(output.toString('hex'), '2200');
});

test('packed repeated field with an empty payload decodes to no values', () => {
  const input = delimited(7, Buffer.alloc(0));
  const decoded = decodeMessage(input, SCHEMA);
  assert.deepEqual(decoded.fields.get(7)!.value, []);

  // An empty packed field is preserved as-is when untouched.
  assert.equal(rewriteMessage(input, SCHEMA, {}).toString('hex'), input.toString('hex'));
});

test('packed fixed-width payload that ends mid-element is reported as truncated', () => {
  const schema: FieldSchemaInput = { 9: { type: 'fixed64', repeated: true } };
  const input = delimited(9, Buffer.alloc(12)); // 1.5 elements
  const error = expectError(() => rewriteMessage(input, schema, {}));
  assert.equal(error.code, 'TRUNCATED');
  assert.equal(error.fieldStart, 0);
});

test('length prefix claiming more bytes than remain is truncated at end of buffer', () => {
  // tag(field 4, wire 2), length 10, only 3 payload bytes.
  const input = Buffer.from([0x22, 0x0a, 0x61, 0x62, 0x63]);
  const error = expectError(() => rewriteMessage(input, SCHEMA, {}));
  assert.equal(error.code, 'TRUNCATED');
  assert.equal(error.offset, input.length);
  assert.equal(error.fieldNumber, 4);
});

test('huge declared length does not allocate or wrap', () => {
  // Field 4 with a 10-byte varint declaring 2^64-1 bytes.
  const input = Buffer.concat([
    Buffer.from([0x22]),
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
  ]);
  const error = expectError(() => rewriteMessage(input, SCHEMA, {}));
  assert.equal(error.code, 'TRUNCATED');
});

test('zero-length input with no replacements produces an empty buffer', () => {
  const output = rewriteMessage(Buffer.alloc(0), SCHEMA, {});
  assert.equal(output.length, 0);
  assert.ok(Buffer.isBuffer(output));
});

test('inspectMessage marks known and unknown fields and reports raw bytes', () => {
  const input = Buffer.concat([
    varintField(1, 1n),
    delimited(55, Buffer.from([1, 2])),
    utf8Field(4, 'x'),
  ]);
  const spans = inspectMessage(input, SCHEMA);

  assert.deepEqual(
    spans.map((span) => [span.fieldNumber, span.known, span.wireType]),
    [
      [1, true, 0],
      [55, false, 2],
      [4, true, 2],
    ],
  );
  assert.equal(spans[1]!.bytes.toString('hex'), delimited(55, Buffer.from([1, 2])).toString('hex'));
  assert.equal(spans.reduce((sum, span) => sum + (span.end - span.start), 0), input.length);
});

test('repeated replacements accept decimal strings and mixed forms', () => {
  const input = delimited(7, Buffer.concat([varint(1), varint(2)]));
  const output = rewriteMessage(input, SCHEMA, { 7: [0n, '9223372036854775807', 42] });
  assert.deepEqual(
    decodeMessage(output, SCHEMA).fields.get(7)!.value,
    [0n, 9223372036854775807n, 42n],
  );
});

test('decimal strings with signs or garbage are rejected', () => {
  for (const bad of ['', '-', '+1', '1.0', '0x10', ' 1', '1 ', '\n1']) {
    const error = expectError(() => rewriteMessage(Buffer.alloc(0), SCHEMA, { 1: bad }));
    assert.equal(error.code, 'INVALID_REPLACEMENT', `input ${JSON.stringify(bad)}`);
  }
  // Negative values are fine for signed sint64, but not for uint64.
  const negativeUint = expectError(() =>
    rewriteMessage(Buffer.alloc(0), { 2: 'sint64', 1: 'uint64' }, { 1: '-1' }),
  );
  assert.equal(negativeUint.code, 'INVALID_REPLACEMENT');
});

test('replacement keys as decimal object keys and Map numeric keys both work', () => {
  const input = varintField(1, 1n);
  const fromObject = rewriteMessage(input, SCHEMA, { 1: 5n });
  const fromMap = rewriteMessage(input, SCHEMA, new Map([[1, 5n]]));
  assert.equal(fromObject.toString('hex'), fromMap.toString('hex'));
});

test('bad replacement keys are reported as INVALID_FIELD_NUMBER', () => {
  const error = expectError(() =>
    rewriteMessage(Buffer.alloc(0), SCHEMA, { abc: 1 } as unknown as Record<string, number>),
  );
  assert.equal(error.code, 'INVALID_FIELD_NUMBER');

  const zero = expectError(() =>
    rewriteMessage(Buffer.alloc(0), SCHEMA, new Map([[0, 1n]])),
  );
  assert.equal(zero.code, 'INVALID_FIELD_NUMBER');
});

test('sint64 extrema round-trip through zig-zag', () => {
  const schema: FieldSchemaInput = { 2: 'sint64' };
  for (const value of [-9223372036854775808n, -1n, 0n, 1n, 9223372036854775807n]) {
    const output = rewriteMessage(Buffer.alloc(0), schema, { 2: value });
    assert.equal(decodeMessage(output, schema).fields.get(2)!.value, value);
  }
});

test('rewritten output is a Buffer whose length matches the message exactly', () => {
  const input = Buffer.concat([varintField(1, 1n), utf8Field(4, 'hello')]);
  const output = rewriteMessage(input, SCHEMA, { 4: 'bye' });

  assert.ok(Buffer.isBuffer(output));
  assert.equal(output.length, 7); // tag+1, tag+len+"bye"
  assert.equal(output.toString('hex'), Buffer.concat([varintField(1, 1n), utf8Field(4, 'bye')]).toString('hex'));
});

test('scan helper and rewriter agree on wire types it emits', () => {
  const input = Buffer.alloc(0);
  const output = rewriteMessage(input, SCHEMA, {
    1: 1n,
    4: 's',
    7: [1n, 2n],
  });
  const fields = scan(output);
  assert.deepEqual(fields.map((f) => f.wireType), [0, 2, 2]);
  assert.deepEqual(fields.map((f) => f.fieldNumber), [1, 4, 7]);
});
