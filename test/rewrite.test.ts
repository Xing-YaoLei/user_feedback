import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeMessage,
  ProtobufRewriteError,
  rewriteMessage,
  type FieldSchemaInput,
  type ReplacementTableInput,
} from '../src/index.ts';
import {
  delimited,
  fixed32,
  fixed32Field,
  fixed64,
  fixed64Field,
  paddedVarint,
  scan,
  tag,
  utf8Field,
  varint,
  varintField,
} from './helpers.ts';

const HEX = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function expectError(fn: () => unknown): ProtobufRewriteError {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof ProtobufRewriteError,
      `expected ProtobufRewriteError, got ${String(error)}`,
    );
    return error;
  }
  assert.fail('expected a ProtobufRewriteError to be thrown');
}

// A representative schema covering every supported known type.
const SCHEMA: FieldSchemaInput = new Map<number, unknown>([
  [1, 'uint64'],
  [2, { type: 'sint64' }],
  [3, { type: 'fixed64' }],
  [4, { type: 'string' }],
  [5, { type: 'bytes' }],
  [6, { type: 'fixed32' }],
  [7, { type: 'uint64', repeated: true }],
  [8, { type: 'sint64', repeated: true }],
  [9, { type: 'fixed64', repeated: true }],
  [10, { type: 'fixed32', repeated: true }],
] as [number, string | { type: string; repeated?: boolean }][]) as FieldSchemaInput;

test('rewrites a single uint64 and leaves every other byte untouched', () => {
  const unknownField = delimited(99, Buffer.from('opaque-unknown', 'utf8'));
  const input = Buffer.concat([
    varintField(1, 1n),
    utf8Field(4, 'hello'),
    unknownField,
    varintField(1, 2n), // second occurrence is removed by the rewrite
    fixed64Field(3, 0x0102030405060708n),
  ]);

  const output = rewriteMessage(input, SCHEMA, { 1: 42n });
  const fields = scan(output);

  assert.deepEqual(
    fields.map((f) => [f.fieldNumber, f.wireType]),
    [
      [1, 0],
      [4, 2],
      [99, 2],
      [3, 1],
    ],
  );
  // Replacement lands at the first occurrence position with a canonical varint.
  assert.equal(fields[0]!.raw.toString('hex'), '082a');
  // Untouched fields are byte-identical to their input counterparts.
  assert.equal(fields[1]!.raw.toString('hex'), utf8Field(4, 'hello').toString('hex'));
  assert.equal(fields[2]!.raw.toString('hex'), unknownField.toString('hex'));
  assert.equal(fields[3]!.raw.toString('hex'), fixed64Field(3, 0x0102030405060708n).toString('hex'));
});

test('accepts plain-object and descriptor-array schemas', () => {
  const input = Buffer.concat([varintField(1, 5n), utf8Field(2, 'x')]);

  const asObject = rewriteMessage(input, { 1: 'uint64', 2: 'string' }, { 2: 'y' });
  const asArray = rewriteMessage(
    input,
    [
      { fieldNumber: 1, type: 'uint64' },
      { fieldNumber: 2, type: 'string' },
    ],
    { 2: 'y' },
  );
  const asWrapper = rewriteMessage(
    input,
    { fields: { 1: { type: 'uint64', label: 'optional' }, 2: { type: 'string', rule: 'singular' } } },
    { 2: 'y' },
  );

  assert.equal(HEX(asObject), HEX(asArray));
  assert.equal(HEX(asObject), HEX(asWrapper));
  assert.equal(HEX(asObject), Buffer.concat([varintField(1, 5n), utf8Field(2, 'y')]).toString('hex'));
});

test('preserves non-canonical tags and over-long varints on untouched fields', () => {
  // Same numeric tag as field 1/varint but two bytes wide, plus an over-long payload.
  const nonCanonicalTag = Buffer.from([0x88, 0x00]);
  const input = Buffer.concat([
    nonCanonicalTag,
    paddedVarint(5, 3),
    utf8Field(4, 'keep-me'),
  ]);

  const output = rewriteMessage(input, SCHEMA, { 4: 'changed' });
  const fields = scan(output);

  assert.equal(fields[0]!.raw.toString('hex'), Buffer.concat([nonCanonicalTag, paddedVarint(5, 3)]).toString('hex'));
  assert.equal(fields[1]!.raw.toString('hex'), utf8Field(4, 'changed').toString('hex'));
});

test('known singular fields read the last occurrence and drop earlier ones on replace', () => {
  const input = Buffer.concat([
    utf8Field(4, 'first'),
    utf8Field(4, 'second'),
    utf8Field(4, 'third'),
  ]);

  // Without replacement, the original bytes survive as-is.
  assert.equal(HEX(rewriteMessage(input, SCHEMA, {})), input.toString('hex'));

  const decoded = decodeMessage(input, SCHEMA);
  assert.equal(decoded.fields.get(4)!.value, 'third');
  assert.equal(decoded.fields.get(4)!.occurrences, 3);

  const output = rewriteMessage(input, SCHEMA, { 4: 'replaced' });
  const fields = scan(output);
  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.raw.toString('hex'), utf8Field(4, 'replaced').toString('hex'));
});

test('repeated numeric fields merge packed and unpacked occurrences in wire order', () => {
  const packed = delimited(7, Buffer.concat([varint(1), varint(2)]));
  const input = Buffer.concat([
    packed,
    varintField(7, 3n),
    delimited(7, Buffer.concat([varint(4), paddedVarint(5, 2)])),
    varintField(7, 6n),
  ]);

  const decoded = decodeMessage(input, SCHEMA);
  assert.deepEqual(decoded.fields.get(7)!.value, [1n, 2n, 3n, 4n, 5n, 6n]);

  const output = rewriteMessage(input, SCHEMA, { 7: ['10', 11n, 12] });
  const fields = scan(output);

  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.wireType, 2);
  assert.equal(
    fields[0]!.raw.toString('hex'),
    delimited(7, Buffer.concat([varint(10), varint(11), varint(12)])).toString('hex'),
  );
});

test('repeated fixed64/fixed32/sint64 replacements are packed correctly', () => {
  const input = Buffer.concat([
    fixed64Field(9, 1n),
    delimited(9, Buffer.concat([fixed64Field(0, 2n).subarray(1), fixed64Field(0, 3n).subarray(1)])),
    fixed32Field(10, 7),
    fixed32Field(10, 8),
  ]);

  const output = rewriteMessage(input, SCHEMA, {
    9: [0x1111111111111111n, '81985529216486895'],
    10: [0xdeadbeef, 2],
  });

  const fields = scan(output);
  assert.deepEqual(fields.map((f) => [f.fieldNumber, f.wireType]), [[9, 2], [10, 2]]);
  assert.equal(
    fields[0]!.raw.toString('hex'),
    delimited(9, Buffer.concat([fixed64(0x1111111111111111n), fixed64(81985529216486895n)])).toString('hex'),
  );
  assert.equal(
    fields[1]!.raw.toString('hex'),
    delimited(10, Buffer.concat([fixed32(0xdeadbeef), fixed32(2)])).toString('hex'),
  );

  // sint64 repeated round-trips negative values through zig-zag.
  const sint = rewriteMessage(
    Buffer.concat([delimited(8, Buffer.concat([varint(1), varint(3)]))]),
    SCHEMA,
    { 8: [-1n, -2n, 0n, 9223372036854775807n, -9223372036854775808n] },
  );
  assert.deepEqual(decodeMessage(sint, SCHEMA).fields.get(8)!.value, [
    -1n,
    -2n,
    0n,
    9223372036854775807n,
    -9223372036854775808n,
  ]);
});

test('missing replacement fields are appended in ascending field-number order', () => {
  const input = utf8Field(4, 'only-string');
  const output = rewriteMessage(input, SCHEMA, {
    9: [1n],
    1: 7n,
    5: Buffer.from([0x00, 0xff]),
    2: -3n,
  });
  const fields = scan(output);

  assert.deepEqual(
    fields.map((f) => f.fieldNumber),
    [4, 1, 2, 5, 9],
  );
  assert.equal(fields[0]!.raw.toString('hex'), input.toString('hex'));
  assert.equal(fields[1]!.raw.toString('hex'), varintField(1, 7n).toString('hex'));
  assert.equal(fields[2]!.raw.toString('hex'), Buffer.concat([tag(2, 0), varint(5)]).toString('hex'));
  assert.equal(fields[3]!.raw.toString('hex'), delimited(5, Buffer.from([0x00, 0xff])).toString('hex'));
  assert.equal(fields[4]!.wireType, 2);
});

test('an empty repeated replacement removes the field entirely', () => {
  const input = Buffer.concat([varintField(7, 1n), utf8Field(4, 'x')]);
  const output = rewriteMessage(input, SCHEMA, { 7: [] });
  assert.equal(output.toString('hex'), utf8Field(4, 'x').toString('hex'));

  const absent = rewriteMessage(utf8Field(4, 'x'), SCHEMA, { 7: [] });
  assert.equal(absent.toString('hex'), utf8Field(4, 'x').toString('hex'));
});

test('64-bit precision is preserved end to end', () => {
  const max = 18446744073709551615n;
  const input = Buffer.concat([varintField(1, max), fixed64Field(3, max)]);
  const decoded = decodeMessage(input, SCHEMA);

  assert.equal(decoded.fields.get(1)!.value, max);
  assert.equal(decoded.fields.get(3)!.value, max);

  const output = rewriteMessage(input, SCHEMA, { 1: '18446744073709551615', 3: max });
  const fields = scan(output);
  assert.equal(fields[0]!.raw.toString('hex'), varintField(1, max).toString('hex'));
  assert.equal(fields[1]!.raw.toString('hex'), fixed64Field(3, max).toString('hex'));
});

test('strings are validated as strict UTF-8, unknown payloads stay opaque', () => {
  const invalid = Buffer.from([0x61, 0xc3, 0x28]); // "a" + invalid 2-byte sequence
  const input = Buffer.concat([delimited(4, invalid)]);

  const error = expectError(() => rewriteMessage(input, SCHEMA, {}));
  assert.equal(error.code, 'INVALID_UTF8');
  assert.equal(error.offset, 3, 'offset points at the malformed lead byte');
  assert.equal(error.fieldNumber, 4);

  // The exact same bytes on an unknown field are copied verbatim.
  const opaqueInput = Buffer.concat([delimited(50, invalid)]);
  const output = rewriteMessage(opaqueInput, SCHEMA, { 4: 'ok' });
  const fields = scan(output);
  assert.equal(fields[0]!.raw.toString('hex'), opaqueInput.toString('hex'));

  // Lone surrogates in replacements are rejected instead of silently mangled.
  const surrogate = expectError(() => rewriteMessage(utf8Field(4, 'ok'), SCHEMA, { 4: '\ud800' }));
  assert.equal(surrogate.code, 'INVALID_REPLACEMENT');
});

test('rejects all invalid UTF-8 shapes', () => {
  const cases: Array<[string, number[]]> = [
    ['stray continuation', [0x80]],
    ['overlong 2-byte', [0xc0, 0xaf]],
    ['overlong 3-byte', [0xe0, 0x80, 0xaf]],
    ['overlong 4-byte', [0xf0, 0x80, 0x80, 0xaf]],
    ['surrogate', [0xed, 0xa0, 0x80]],
    ['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['truncated sequence', [0xe2, 0x82]],
    ['bad continuation', [0xe2, 0x28, 0xa1]],
    ['0xfe lead', [0xfe]],
  ];

  for (const [name, bytes] of cases) {
    const input = delimited(4, Buffer.from(bytes));
    const error = expectError(() => rewriteMessage(input, SCHEMA, {}));
    assert.equal(error.code, 'INVALID_UTF8', name);
  }
});

test('groups are rejected as unsupported', () => {
  const startGroup = Buffer.concat([tag(11, 3), varintField(1, 1n), tag(11, 4)]);
  const error = expectError(() => rewriteMessage(startGroup, SCHEMA, {}));
  assert.equal(error.code, 'UNSUPPORTED_GROUP');
  assert.equal(error.offset, 0);
  assert.equal(error.fieldNumber, 11);
  assert.equal(error.wireType, 3);

  const strayEndGroup = tag(12, 4);
  const endError = expectError(() => rewriteMessage(strayEndGroup, SCHEMA, {}));
  assert.equal(endError.code, 'UNSUPPORTED_GROUP');
  assert.equal(endError.wireType, 4);
});

test('wrong wire type for a known field is reported with its byte position', () => {
  const input = Buffer.concat([utf8Field(4, 'a'), fixed64Field(4, 1n)]);
  const error = expectError(() => rewriteMessage(input, SCHEMA, {}));
  assert.equal(error.code, 'WRONG_WIRE_TYPE');
  assert.equal(error.fieldNumber, 4);
  assert.equal(error.wireType, 1);
  assert.equal(error.offset, utf8Field(4, 'a').length);

  // A repeated fixed32 field must accept wire type 2 (packed)...
  assert.doesNotThrow(() => rewriteMessage(Buffer.concat([delimited(10, Buffer.alloc(8))]), SCHEMA, {}));

  // ...but not wire type 1.
  const packedError = expectError(() => rewriteMessage(fixed64Field(10, 1n), SCHEMA, {}));
  assert.equal(packedError.code, 'WRONG_WIRE_TYPE');
  assert.equal(packedError.wireType, 1);

  // Known varint field encoded as length-delimited.
  const wrongKind = expectError(() => rewriteMessage(delimited(1, Buffer.from([1])), SCHEMA, {}));
  assert.equal(wrongKind.code, 'WRONG_WIRE_TYPE');
});

test('truncated input reports the byte position of the missing data', () => {
  const full = delimited(4, Buffer.from('abcdefgh'));
  const truncated = full.subarray(0, full.length - 3);
  const error = expectError(() => rewriteMessage(truncated, SCHEMA, {}));
  assert.equal(error.code, 'TRUNCATED');
  assert.equal(error.offset, truncated.length);

  const fixed64Truncated = fixed64Field(3, 1n).subarray(0, 5);
  const fixedError = expectError(() => rewriteMessage(fixed64Truncated, SCHEMA, {}));
  assert.equal(fixedError.code, 'TRUNCATED');
  assert.equal(fixedError.offset, 5);

  const fixed32Truncated = fixed32Field(6, 1).subarray(0, 3);
  const fixed32Error = expectError(() => rewriteMessage(fixed32Truncated, SCHEMA, {}));
  assert.equal(fixed32Error.code, 'TRUNCATED');
  assert.equal(fixed32Error.offset, 3);

  // Varint with the continuation bit set but no following byte.
  const varintTruncated = Buffer.from([0x08, 0x80]);
  const varintError = expectError(() => rewriteMessage(varintTruncated, SCHEMA, {}));
  assert.equal(varintError.code, 'TRUNCATED');
  assert.equal(varintError.offset, 2);
});

test('varint overflow and invalid field numbers report byte positions', () => {
  const overflow = Buffer.from([0x08, ...Array<number>(10).fill(0xff), 0x02]);
  const error = expectError(() => rewriteMessage(overflow, SCHEMA, {}));
  assert.equal(error.code, 'VARINT_OVERFLOW');
  assert.equal(error.offset, 10, 'offending tenth payload byte');
  assert.equal(error.fieldNumber, 1);

  const canonicalMax = Buffer.from([0x08, ...Array<number>(9).fill(0xff), 0x01]);
  assert.doesNotThrow(() => rewriteMessage(canonicalMax, SCHEMA, {}));

  const zeroTag = Buffer.from([0x00]);
  const zeroError = expectError(() => rewriteMessage(zeroTag, SCHEMA, {}));
  assert.equal(zeroError.code, 'INVALID_FIELD_NUMBER');
  assert.equal(zeroError.offset, 0);

  const outOfRangeTag = varint(BigInt(536870912) * 8n); // 2^29
  const rangeError = expectError(() => rewriteMessage(outOfRangeTag, SCHEMA, {}));
  assert.equal(rangeError.code, 'INVALID_FIELD_NUMBER');
});

test('size limits fail before any output is produced', () => {
  const input = Buffer.concat([varintField(1, 1n), utf8Field(4, 'hello')]);

  const inputTooBig = expectError(() => rewriteMessage(input, SCHEMA, {}, { maxMessageBytes: input.length - 1 }));
  assert.equal(inputTooBig.code, 'SIZE_LIMIT');
  assert.equal(inputTooBig.limit, input.length - 1);

  // Growing a replacement past the ceiling is caught during assembly.
  const grown = expectError(() =>
    rewriteMessage(input, SCHEMA, { 4: 'x'.repeat(100) }, { maxMessageBytes: input.length }),
  );
  assert.equal(grown.code, 'SIZE_LIMIT');

  // Exactly at the boundary is allowed.
  const exact = rewriteMessage(input, SCHEMA, { 4: 'hello' }, { maxMessageBytes: input.length });
  assert.equal(HEX(exact), input.toString('hex'));

  // The bare-number options form is accepted too.
  assert.throws(
    () => rewriteMessage(input, SCHEMA, {}, 0),
    (thrown: unknown) => thrown instanceof ProtobufRewriteError && thrown.code === 'SIZE_LIMIT',
  );

  // Invalid options are rejected up front.
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const badOptions = expectError(() => rewriteMessage(input, SCHEMA, {}, { maxMessageBytes: bad }));
    assert.equal(badOptions.code, 'INVALID_OPTIONS');
  }
});

test('replacement validation happens before any parsing side effects', () => {
  const input = varintField(1, 1n);

  const unknownField = expectError(() => rewriteMessage(input, SCHEMA, { 123: 1n }));
  assert.equal(unknownField.code, 'INVALID_REPLACEMENT');

  const negative = expectError(() => rewriteMessage(input, SCHEMA, { 1: -1n }));
  assert.equal(negative.code, 'INVALID_REPLACEMENT');

  const tooBig = expectError(() => rewriteMessage(input, SCHEMA, { 1: 18446744073709551616n }));
  assert.equal(tooBig.code, 'INVALID_REPLACEMENT');

  const unsafeNumber = expectError(() => rewriteMessage(input, SCHEMA, { 1: Number.MAX_SAFE_INTEGER + 2 }));
  assert.equal(unsafeNumber.code, 'INVALID_REPLACEMENT');

  const nonInteger = expectError(() => rewriteMessage(input, SCHEMA, { 1: 1.5 }));
  assert.equal(nonInteger.code, 'INVALID_REPLACEMENT');

  const wrongShape = expectError(() => rewriteMessage(input, SCHEMA, { 1: [1] }));
  assert.equal(wrongShape.code, 'INVALID_REPLACEMENT');

  const repeatedScalar = expectError(() => rewriteMessage(input, SCHEMA, { 7: 1 }));
  assert.equal(repeatedScalar.code, 'INVALID_REPLACEMENT');

  const sintOutOfRange = expectError(() => rewriteMessage(input, SCHEMA, { 2: 9223372036854775808n }));
  assert.equal(sintOutOfRange.code, 'INVALID_REPLACEMENT');

  const bytesWrong = expectError(() => rewriteMessage(input, SCHEMA, { 5: 'nope' }));
  assert.equal(bytesWrong.code, 'INVALID_REPLACEMENT');

  const stringWrong = expectError(() => rewriteMessage(input, SCHEMA, { 4: 5 }));
  assert.equal(stringWrong.code, 'INVALID_REPLACEMENT');
});

test('invalid schemas are rejected with a clear code', () => {
  const invalidSchemas: unknown[] = [
    { 0: 'uint64' },
    { 536870912: 'uint64' },
    { abc: 'uint64' },
    { 1: 'int32' },
    { 1: 'group' },
    { 1: { type: 'uint64', repeated: 'yes' } },
    { 1: { type: 'string', repeated: true } },
    { 1: { type: 'uint64', label: 'packed' } },
    { fields: { 1: 'uint64' }, 2: 'string' },
  ];

  for (const schema of invalidSchemas) {
    const error = expectError(() => rewriteMessage(Buffer.alloc(0), schema as FieldSchemaInput, {}));
    assert.equal(error.code, 'INVALID_SCHEMA', JSON.stringify(schema));
  }

  // Conflicting duplicate field declarations.
  const conflict = expectError(() =>
    rewriteMessage(
      Buffer.alloc(0),
      [
        { fieldNumber: 1, type: 'uint64' },
        { fieldNumber: 1, type: 'string' },
      ],
      {},
    ),
  );
  assert.equal(conflict.code, 'INVALID_SCHEMA');

  // Identical duplicates are fine.
  assert.doesNotThrow(() =>
    rewriteMessage(
      varintField(1, 1n),
      [
        { fieldNumber: 1, type: 'uint64' },
        { fieldNumber: 1, type: 'uint64' },
      ],
      {},
    ),
  );
});

test('input must be a Buffer or Uint8Array', () => {
  const error = expectError(() =>
    rewriteMessage([1, 2, 3] as unknown as Uint8Array, SCHEMA, {}),
  );
  assert.equal(error.code, 'INVALID_INPUT');
});

test('empty message with replacements appends them; empty message without stays empty', () => {
  assert.equal(rewriteMessage(Buffer.alloc(0), SCHEMA, {}).length, 0);
  const output = rewriteMessage(Buffer.alloc(0), SCHEMA, { 1: 1n, 4: 'hi' });
  const fields = scan(output);
  assert.deepEqual(fields.map((f) => f.fieldNumber), [1, 4]);
});

test('mixed interleaved fields keep relative order of untouched bytes', () => {
  const input = Buffer.concat([
    varintField(1, 1n),
    utf8Field(40, 'a'),
    varintField(2, zigzag(-5n)),
    delimited(41, Buffer.from([0xde, 0xad])),
    varintField(1, 2n),
    utf8Field(42, 'b'),
    varintField(2, zigzag(6n)),
  ]);

  const output = rewriteMessage(input, SCHEMA, { 1: 100n });
  const fields = scan(output);

  assert.deepEqual(
    fields.map((f) => f.fieldNumber),
    [1, 40, 2, 41, 42, 2],
  );
  assert.equal(fields[0]!.raw.toString('hex'), varintField(1, 100n).toString('hex'));
  assert.equal(fields[1]!.raw.toString('hex'), utf8Field(40, 'a').toString('hex'));
  assert.equal(fields[3]!.raw.toString('hex'), delimited(41, Buffer.from([0xde, 0xad])).toString('hex'));
  assert.equal(fields[4]!.raw.toString('hex'), utf8Field(42, 'b').toString('hex'));

  // Replacing a repeated field collapses every occurrence into one packed
  // field at the first occurrence position.
  const interleaved = Buffer.concat([
    varintField(1, 1n),
    utf8Field(40, 'a'),
    varintField(8, zigzag(-5n)),
    delimited(41, Buffer.from([0xde, 0xad])),
    varintField(8, zigzag(6n)),
  ]);
  const repeated = rewriteMessage(interleaved, SCHEMA, { 8: [7n, -8n] });
  const repeatedFields = scan(repeated);
  assert.deepEqual(
    repeatedFields.map((f) => f.fieldNumber),
    [1, 40, 8, 41],
  );
  assert.equal(
    repeatedFields[2]!.raw.toString('hex'),
    delimited(8, Buffer.concat([varint(zigzag(7n)), varint(zigzag(-8n))])).toString('hex'),
  );
  // Fields after the collapsed occurrences keep their order and bytes.
  assert.equal(repeatedFields[3]!.raw.toString('hex'), delimited(41, Buffer.from([0xde, 0xad])).toString('hex'));

  // Singular field 2 keeps its last value when decoded.
  assert.equal(decodeMessage(input, SCHEMA).fields.get(2)!.value, 6n);
});

function zigzag(value: bigint): bigint {
  return BigInt.asUintN(64, (value << 1n) ^ (value >> 63n));
}