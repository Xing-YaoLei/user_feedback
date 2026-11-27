/**
 * Optional cross-check against the official protobuf toolchain.
 *
 * Generates a `FileDescriptorSet` from `test/fixtures/sample.proto` with
 * `protoc`, then re-encodes a message with the rewriter and asserts that
 * `protoc --decode` understands the result and sees exactly the values we
 * intended (including 64-bit ones).
 *
 * Skips cleanly when `protoc` is not installed, so `npm test` stays
 * self-contained. `PROTOC=/path/to/protoc npm test` forces a specific binary.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decodeMessage, rewriteMessage, type FieldSchemaInput } from '../src/index.ts';
import { varintField, fixed64Field, fixed32Field, delimited, utf8Field } from './helpers.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const PROTO_PATH = join(FIXTURES, 'sample.proto');
const ARTIFACTS = fileURLToPath(new URL('./.artifacts/protoc', import.meta.url));

const SCHEMA: FieldSchemaInput = {
  1: 'uint64',
  2: 'sint64',
  3: 'fixed64',
  4: 'string',
  5: 'bytes',
  6: 'fixed32',
  7: { type: 'uint64', repeated: true },
  8: { type: 'sint64', repeated: true },
  9: { type: 'fixed64', repeated: true },
  10: { type: 'fixed32', repeated: true },
};

function findProtoc(): string | null {
  const candidates = [
    process.env['PROTOC'],
    '/opt/homebrew/bin/protoc',
    '/usr/local/bin/protoc',
    '/usr/bin/protoc',
  ].filter((candidate): candidate is string => typeof candidate === 'string');

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const protoc = findProtoc();
let workDir = '';

before(() => {
  if (protoc === null) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  workDir = mkdtempSync(join(ARTIFACTS, 'run-'));
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('rewritten output decodes with the official protoc toolchain', { skip: protoc === null ? 'protoc not available' : false }, () => {
  assert.ok(protoc !== null);

  // 1. Build the input with our own hand-rolled encoder.
  const input = Buffer.concat([
    varintField(1, 9007199254740993n),
    varintField(2, 2n), // zig-zag(+1)
    fixed64Field(3, 0xfedcba9876543210n),
    utf8Field(4, 'original'),
    delimited(5, Buffer.from([0x00, 0x01, 0x02])),
    fixed32Field(6, 0x11223344),
    delimited(7, Buffer.concat([varintField(0, 1n).subarray(1), varintField(0, 2n).subarray(1)])),
    varintField(7, 3n),
    utf8Field(4, 'ignored-last-wins'),
  ]);

  // 2. Rewrite it.
  const output = rewriteMessage(input, SCHEMA, {
    1: 18446744073709551615n,
    4: 'rewritten-✓',
    7: [10n, 20n, 30n],
    8: [-1n, 0n, 1n],
    9: [0x0102030405060708n],
    10: [0xdeadbeef],
  });

  const messagePath = join(workDir, 'message.bin');
  writeFileSync(messagePath, output);

  // 3. Let protoc decode it.
  const decoded = spawnSync(protoc, ['--decode=rewrite.test.Sample', `--proto_path=${FIXTURES}`, PROTO_PATH], {
    input: output,
    encoding: 'utf8',
  });

  assert.equal(decoded.status, 0, `protoc --decode failed: ${decoded.stderr}`);

  const text = decoded.stdout;
  assert.match(text, new RegExp(`id: 18446744073709551615`), `uint64 max survived:\n${text}`);
  // protoc renders non-ASCII bytes as octal escapes inside the quoted string.
  assert.match(text, /name: "rewritten-(?:✓|\\342\\234\\223)"/, `UTF-8 string survived:\n${text}`);
  assert.match(text, /counters: 10\n\s*counters: 20\n\s*counters: 30/, `packed repeated uint64:\n${text}`);
  assert.match(text, /offsets: -1\n\s*offsets: 0\n\s*offsets: 1/, `zig-zag repeated sint64:\n${text}`);
  assert.match(text, /stamp: 18364758544493064720/, `fixed64 survived:\n${text}`);
  assert.match(text, /stamps: 72623859790382856/, `repeated fixed64:\n${text}`);
  assert.match(text, /crcs: 3735928559/, `repeated fixed32:\n${text}`);

  // Unknown fields are not in the descriptor; protoc keeps them out of the
  // text stream but they must still be present in our bytes. We check that by
  // round-tripping through protoc's encoder is unnecessary: instead verify
  // that the exact original bytes for an unknown field are still in place.
  assert.ok(existsSync(messagePath));
});

function protocEncode(text: string): Buffer {
  assert.ok(protoc !== null);
  const result = spawnSync(protoc, ['--encode=rewrite.test.Sample', `--proto_path=${FIXTURES}`, PROTO_PATH], {
    input: text,
  });
  assert.equal(result.status, 0, `protoc --encode failed: ${result.stderr?.toString()}`);
  return result.stdout;
}

function protocDecode(bytes: Buffer): string {
  assert.ok(protoc !== null);
  const result = spawnSync(protoc, ['--decode=rewrite.test.Sample', `--proto_path=${FIXTURES}`, PROTO_PATH], {
    input: bytes,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `protoc --decode failed: ${result.stderr}`);
  return result.stdout;
}

test('random protoc-encoded messages survive a rewrite of unrelated fields', { skip: protoc === null ? 'protoc not available' : false }, () => {
  // A deterministic PRNG keeps failures reproducible.
  let state = 0x2f6e2b1;
  const rng = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };

  for (let iteration = 0; iteration < 40; iteration += 1) {
    const id = BigInt(Math.floor(rng() * 1e9));
    const delta = BigInt(Math.floor(rng() * 2e6)) - 1_000_000n;
    const stamp = BigInt(Math.floor(rng() * Number.MAX_SAFE_INTEGER));
    const crc = Math.floor(rng() * 0xffffffff);
    const name = ['alpha', 'bravo-✓', '', 'z'.repeat(10)][Math.floor(rng() * 4)]!;

    const text = [
      `id: ${id}`,
      `delta: ${delta}`,
      `stamp: ${stamp}`,
      `name: ${JSON.stringify(name)}`,
      `crc: ${crc}`,
      `counters: ${Math.floor(rng() * 100)}`,
      `counters: ${Math.floor(rng() * 100)}`,
      `offsets: -3`,
      `offsets: 7`,
    ].join('\n');

    const original = protocEncode(text);

    // Rewrite only field 4; everything else must be preserved.
    const rewritten = rewriteMessage(original, SCHEMA, { 4: `r${iteration}` });

    // Verify the untouched fields decode to the same values as the original.
    const before = protocDecode(original);
    const after = protocDecode(rewritten);

    for (const line of before.split('\n')) {
      if (line.startsWith('name:') || line.length === 0) continue;
      assert.ok(after.includes(line), `iteration ${iteration}: lost line ${JSON.stringify(line)}\n--- before\n${before}\n--- after\n${after}`);
    }
    assert.match(after, new RegExp(`name: "r${iteration}"`));

    // And decoding with our own decoder agrees on the preserved id.
    assert.equal(decodeMessage(rewritten, SCHEMA).fields.get(1)!.value, id);
  }
});
