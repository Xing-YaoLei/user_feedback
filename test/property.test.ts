/**
 * Property-style / randomized tests.
 *
 * The oracle here is simple and independent of the implementation:
 *
 *   - rewriting with an empty replacement table is the identity;
 *   - every field not named in the table keeps its exact original bytes, in
 *     the same relative order;
 *   - a replaced field appears exactly once, at the position where it first
 *     appeared (or is appended when it was absent);
 *   - decoding the rewritten bytes yields the replacement values.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeMessage,
  inspectMessage,
  rewriteMessage,
  type FieldSchemaInput,
} from '../src/index.ts';
import { scan, varint, tag } from './helpers.ts';

const SCHEMA: FieldSchemaInput = {
  1: 'uint64',
  2: 'sint64',
  3: 'fixed64',
  4: 'string',
  5: 'bytes',
  7: { type: 'uint64', repeated: true },
  8: { type: 'sint64', repeated: true },
};

// Deterministic PRNG so failures reproduce.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVarint(rng: () => number, maxBits: number): Buffer {
  const bits = Math.max(1, Math.floor(rng() * maxBits));
  let value = 0n;
  for (let index = 0; index < bits; index += 1) {
    value = (value << 1n) | BigInt(rng() < 0.5 ? 0 : 1);
  }
  return varint(value);
}

function randomPayload(rng: () => number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(rng() * 256);
  return bytes;
}

function randomMessage(rng: () => number): Buffer {
  const pieces: Buffer[] = [];
  const count = 1 + Math.floor(rng() * 12);

  for (let index = 0; index < count; index += 1) {
    const choice = Math.floor(rng() * 9);
    switch (choice) {
      case 0:
        pieces.push(Buffer.concat([tag(1, 0), randomVarint(rng, 64)]));
        break;
      case 1:
        pieces.push(Buffer.concat([tag(2, 0), randomVarint(rng, 64)]));
        break;
      case 2:
        pieces.push(Buffer.concat([tag(3, 1), randomPayload(rng, 8)]));
        break;
      case 3: {
        const text = ['hi', 'héllo', '😀', '', 'x'.repeat(20)][Math.floor(rng() * 5)]!;
        const payload = Buffer.from(text, 'utf8');
        pieces.push(Buffer.concat([tag(4, 2), varint(payload.length), payload]));
        break;
      }
      case 4: {
        const payload = randomPayload(rng, Math.floor(rng() * 6));
        pieces.push(Buffer.concat([tag(5, 2), varint(payload.length), payload]));
        break;
      }
      case 5: {
        // Packed repeated uint64.
        const items = Array.from({ length: Math.floor(rng() * 4) }, () => randomVarint(rng, 64));
        const payload = Buffer.concat(items);
        pieces.push(Buffer.concat([tag(7, 2), varint(payload.length), payload]));
        break;
      }
      case 6:
        pieces.push(Buffer.concat([tag(7, 0), randomVarint(rng, 64)]));
        break;
      case 7:
        pieces.push(Buffer.concat([tag(8, 0), randomVarint(rng, 64)]));
        break;
      default: {
        // A genuinely unknown field, on an arbitrary high field number.
        const unknownNumber = 100 + Math.floor(rng() * 50);
        const payload = randomPayload(rng, Math.floor(rng() * 5));
        pieces.push(
          rng() < 0.5
            ? Buffer.concat([tag(unknownNumber, 2), varint(payload.length), payload])
            : Buffer.concat([tag(unknownNumber, 0), randomVarint(rng, 32)]),
        );
        break;
      }
    }
  }

  return Buffer.concat(pieces);
}

test('empty replacement table is the identity over random messages', () => {
  const rng = mulberry32(0xc0ffee);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const input = randomMessage(rng);
    const output = rewriteMessage(input, SCHEMA, {});
    assert.equal(
      output.toString('hex'),
      input.toString('hex'),
      `iteration ${iteration} was not the identity`,
    );
  }
});

test('untouched fields keep exact bytes and relative order under random rewrites', () => {
  const rng = mulberry32(0x5eed);
  const replacements = {
    1: 123n,
    3: 0xdeadbeefcafef00dn,
    4: 'replaced',
    5: Buffer.from([0xff, 0x00]),
    7: [1n, 2n, 3n],
  };

  for (let iteration = 0; iteration < 300; iteration += 1) {
    const input = randomMessage(rng);
    const before = scan(input).filter((field) => !(field.fieldNumber in replacements));
    const output = rewriteMessage(input, SCHEMA, replacements);
    const after = scan(output);

    // Every untouched field occurrence, in order, matched an original byte run.
    const afterUntouched = after.filter((field) => !(field.fieldNumber in replacements));
    assert.deepEqual(
      afterUntouched.map((field) => field.raw.toString('hex')),
      before.map((field) => field.raw.toString('hex')),
      `iteration ${iteration}: untouched fields drifted`,
    );

    // Each replaced field appears exactly once.
    for (const fieldNumber of Object.keys(replacements).map(Number)) {
      const occurrences = after.filter((field) => field.fieldNumber === fieldNumber);
      assert.equal(
        occurrences.length,
        1,
        `iteration ${iteration}: field ${fieldNumber} appears ${occurrences.length} times`,
      );
    }

    const decoded = decodeMessage(output, SCHEMA);
    assert.equal(decoded.fields.get(1)!.value, 123n);
    assert.equal(decoded.fields.get(3)!.value, 0xdeadbeefcafef00dn);
    assert.equal(decoded.fields.get(4)!.value, 'replaced');
    assert.deepEqual(decoded.fields.get(5)!.value, Buffer.from([0xff, 0x00]));
    assert.deepEqual(decoded.fields.get(7)!.value, [1n, 2n, 3n]);
  }
});

test('inspectMessage agrees with scan and covers every byte exactly once', () => {
  const rng = mulberry32(0xabc);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const input = randomMessage(rng);
    const spans = inspectMessage(input, SCHEMA);
    const scanned = scan(input);

    assert.equal(spans.length, scanned.length);
    let cursor = 0;
    spans.forEach((span, index) => {
      assert.equal(span.start, cursor, 'spans are contiguous');
      assert.equal(span.bytes.toString('hex'), scanned[index]!.raw.toString('hex'));
      cursor = span.end;
    });
    assert.equal(cursor, input.length, 'spans cover the whole message');
  }
});
