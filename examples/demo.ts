/**
 * End-to-end demo, runnable with `npm start`.
 *
 * Builds a message with a hand-rolled encoder, rewrites selected fields, and
 * shows that every other byte is preserved. Files are written under
 * `examples/.out/` so nothing escapes the workspace.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodeMessage,
  inspectMessage,
  ProtobufRewriteError,
  rewriteAndStore,
  rewriteMessage,
  writeFileAtomic,
  type FieldSchemaInput,
  type MessageStore,
} from '../src/index.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function varint(value: bigint | number): Buffer {
  const bytes: number[] = [];
  let remaining = typeof value === 'bigint' ? value : BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

function tag(fieldNumber: number, wireType: number): Buffer {
  return varint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

function lengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, 2), varint(BigInt(payload.length)), payload]);
}

// Known fields the gateway understands. Everything else is opaque.
const schema: FieldSchemaInput = {
  1: 'uint64', // request id
  2: 'string', // user-visible label
  5: 'bytes', // opaque blob
  7: { type: 'uint64', repeated: true }, // counters, may arrive packed or not
};

const input = Buffer.concat([
  Buffer.concat([tag(1, 0), varint(1n)]),
  lengthDelimited(2, Buffer.from('original label', 'utf8')),
  lengthDelimited(99, Buffer.from([0xde, 0xad, 0xbe, 0xef])), // unknown: preserved
  Buffer.concat([tag(7, 2), varint(2), varint(1), varint(2)]), // packed counters
  Buffer.concat([tag(7, 0), varint(3n)]), // unpacked continuation
  Buffer.concat([tag(1, 0), varint(2n)]), // duplicate id: last wins
]);

console.log('input      ', hex(input));
console.log('fields     ', inspectMessage(input, schema).map((f) => `${f.fieldNumber}/${f.wireType}${f.known ? '' : '?'}@${f.start}`).join(' '));

const output = rewriteMessage(input, schema, {
  1: 42n,
  2: 'rewritten ✓',
  7: [10n, 20n, 30n],
});

console.log('output     ', hex(output));
console.log('fields     ', inspectMessage(output, schema).map((f) => `${f.fieldNumber}/${f.wireType}${f.known ? '' : '?'}@${f.start}`).join(' '));

const decoded = decodeMessage(output, schema);
for (const [fieldNumber, field] of decoded.fields) {
  const value = typeof field.value === 'bigint' ? `${field.value}n` : field.value;
  console.log(`  field ${fieldNumber} (${field.type}${field.repeated ? ', repeated' : ''}):`, value);
}
console.log('  unknown fields preserved:', decoded.unknownFields.map((f) => hex(f.bytes)));

// Demonstrate the crash-safe hand-off to storage.
const outDir = fileURLToPath(new URL('./.out', import.meta.url));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const target = join(outDir, 'message.bin');

const store: MessageStore = { write: (bytes) => writeFileAtomic(target, bytes) };
const result = rewriteAndStore({ input, schema, replacements: { 2: 'stored' }, store });
console.log('stored     ', hex(readFileSync(target)), `(${result.byteLength} bytes)`);

// A malformed input reports a byte position instead of returning partial bytes.
try {
  rewriteMessage(Buffer.from([0x08, 0x80]), schema, {});
} catch (error) {
  if (error instanceof ProtobufRewriteError) {
    console.log('error demo ', `${error.code} at byte ${error.offset}: ${error.message}`);
  } else {
    throw error;
  }
}
