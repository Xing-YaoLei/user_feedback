/**
 * Preservation tests for unknown fields across every supported wire type.
 *
 * "Unknown" bytes must be carried through untouched: original tag encoding
 * (even non-canonical), original length varint (even over-long), and original
 * payload (even bytes that are not valid UTF-8).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeMessage, rewriteMessage, type FieldSchemaInput } from '../src/index.ts';
import { paddedVarint, scan, tag, utf8Field, varint, varintField } from './helpers.ts';

const SCHEMA: FieldSchemaInput = { 1: 'uint64', 4: 'string' };

const CASES: Array<{ name: string; bytes: Buffer }> = [
  {
    name: 'unknown varint (wire type 0)',
    bytes: Buffer.concat([tag(90, 0), varint(300)]),
  },
  {
    name: 'unknown fixed64 (wire type 1)',
    bytes: Buffer.concat([tag(91, 1), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]),
  },
  {
    name: 'unknown length-delimited (wire type 2) with invalid UTF-8',
    bytes: Buffer.concat([tag(92, 2), varint(4), Buffer.from([0xff, 0xfe, 0xfd, 0xfc])]),
  },
  {
    name: 'unknown fixed32 (wire type 5)',
    bytes: Buffer.concat([tag(93, 5), Buffer.from([0xde, 0xad, 0xbe, 0xef])]),
  },
  {
    name: 'unknown with a non-canonical (two-byte) tag',
    bytes: Buffer.concat([Buffer.from([0x9a, 0x06]), varint(3), Buffer.from([9, 9, 9])]),
  },
  {
    name: 'unknown with an over-long length varint',
    bytes: Buffer.concat([tag(94, 2), paddedVarint(2, 5), Buffer.from([7, 7])]),
  },
  {
    name: 'unknown with an over-long value varint',
    bytes: Buffer.concat([tag(95, 0), paddedVarint(1, 9)]),
  },
  {
    name: 'unknown with an empty payload',
    bytes: Buffer.concat([tag(96, 2), varint(0)]),
  },
];

for (const { name, bytes } of CASES) {
  test(`preserves ${name} byte-for-byte`, () => {
    const input = Buffer.concat([varintField(1, 1n), bytes, utf8Field(4, 'keep')]);
    const output = rewriteMessage(input, SCHEMA, { 1: 2n });

    // The unknown field's exact byte run survives at its original relative place.
    const index = output.indexOf(bytes);
    assert.notEqual(index, -1, `${name}: byte run not found in output`);
    assert.equal(output.subarray(index, index + bytes.length).toString('hex'), bytes.toString('hex'));

    const fields = scan(output);
    const unknown = fields.find((field) => field.raw.toString('hex') === bytes.toString('hex'));
    assert.ok(unknown, `${name}: not present as one field`);

    const decoded = decodeMessage(input, SCHEMA);
    assert.equal(decoded.unknownFields.length, 1);
    assert.equal(decoded.unknownFields[0]!.bytes.toString('hex'), bytes.toString('hex'));

    // And with no replacements at all, the whole message is the identity.
    assert.equal(rewriteMessage(input, SCHEMA, {}).toString('hex'), input.toString('hex'));
  });
}

test('several unknown fields of different wire types all survive a rewrite', () => {
  const unknownBytes = Buffer.concat(CASES.map((entry) => entry.bytes));
  const input = Buffer.concat([varintField(1, 1n), unknownBytes, utf8Field(4, 'x')]);

  const output = rewriteMessage(input, SCHEMA, { 4: 'y' });

  let cursor = 0;
  for (const { name, bytes } of CASES) {
    const found = output.indexOf(bytes, cursor);
    assert.ok(found >= cursor, `${name} out of order or missing`);
    cursor = found + bytes.length;
  }
});

test('a field number absent from the schema is unknown even if its wire form is valid', () => {
  // Field 5 is not declared, so its varint payload is never interpreted and is
  // copied verbatim; the newly supplied field 1 is appended after it.
  const unknownVarint = varintField(5, 123456789012345n);
  const output = rewriteMessage(unknownVarint, SCHEMA, { 1: 1n });
  assert.equal(
    output.toString('hex'),
    Buffer.concat([unknownVarint, varintField(1, 1n)]).toString('hex'),
  );
});
