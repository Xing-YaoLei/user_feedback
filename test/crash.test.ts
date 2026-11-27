/**
 * Crash and durability tests.
 *
 * These use the real filesystem (inside a per-test temp directory under the
 * workspace) and a real child process that is SIGKILLed mid-publish. They
 * assert the two guarantees a gateway needs:
 *
 *   - a crash never leaves a partially rewritten target file;
 *   - a stale temp file can always be swept by `cleanupStaleTemps`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cleanupStaleTemps,
  ProtobufRewriteError,
  rewriteAndStore,
  rewriteMessage,
  tempPathFor,
  writeFileAtomic,
  type FieldSchemaInput,
  type MessageStore,
} from '../src/index.ts';
import { delimited, scan, utf8Field, varintField } from './helpers.ts';

const SCHEMA: FieldSchemaInput = { 1: 'uint64', 4: 'string', 7: { type: 'uint64', repeated: true } };
const CRASH_WRITER = fileURLToPath(new URL('./fixtures/crash-writer.ts', import.meta.url));

let workDir: string;

beforeEach(() => {
  // Keep every temporary artifact inside the workspace, never the system temp.
  const root = fileURLToPath(new URL('./.artifacts', import.meta.url));
  mkdirSync(root, { recursive: true });
  workDir = mkdtempSync(join(root, 'crash-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function sampleInput(): Buffer {
  return Buffer.concat([
    varintField(1, 1n),
    utf8Field(4, 'before'),
    delimited(99, Buffer.from([0xaa, 0xbb])),
    varintField(1, 2n),
  ]);
}

test('atomic write replaces the target and leaves no temp files behind', () => {
  const target = join(workDir, 'message.bin');
  writeFileSync(target, Buffer.from('old-bytes'));

  const staged: string[] = [];
  const payload = rewriteMessage(sampleInput(), SCHEMA, { 1: 5n, 4: 'after' });

  writeFileAtomic(target, payload, {
    onStagedPath: (path) => staged.push(path),
  });

  assert.deepEqual(readFileSync(target), payload);
  assert.equal(staged.length, 1);
  assert.equal(existsSync(staged[0]!), false, 'temp file is renamed away');
});

test('a throwing store adapter never publishes bytes', () => {
  const target = join(workDir, 'message.bin');
  writeFileSync(target, Buffer.from('original'));

  const writes: number[] = [];
  const flaky: MessageStore = {
    write(bytes) {
      writes.push(bytes.length);
      throw new Error('disk full');
    },
  };

  assert.throws(
    () =>
      rewriteAndStore({
        input: sampleInput(),
        schema: SCHEMA,
        replacements: { 1: 9n },
        store: flaky,
      }),
    /disk full/,
  );

  assert.deepEqual(writes, [
    rewriteMessage(sampleInput(), SCHEMA, { 1: 9n }).length,
  ], 'store received the complete buffer exactly once');
  assert.equal(readFileSync(target, 'utf8'), 'original', 'target is untouched');
});

test('a hook failure before rename keeps the old target and removes the temp file', () => {
  const target = join(workDir, 'message.bin');
  writeFileSync(target, Buffer.from('original'));

  const staged: string[] = [];
  assert.throws(
    () =>
      writeFileAtomic(target, Buffer.from('replacement'), {
        onStagedPath: (path) => staged.push(path),
        hooks: {
          beforeRename: () => {
            throw new Error('simulated failure');
          },
        },
      }),
    /simulated failure/,
  );

  assert.equal(readFileSync(target, 'utf8'), 'original');
  assert.equal(existsSync(staged[0]!), false, 'staged file was cleaned up');
  assert.deepEqual(cleanupStaleTemps(target), [], 'nothing left to sweep');
});

test('gateway success path writes exactly the rewritten bytes', () => {
  const target = join(workDir, 'message.bin');
  const store: MessageStore = {
    write(bytes) {
      writeFileAtomic(target, bytes);
    },
  };

  const result = rewriteAndStore({
    input: sampleInput(),
    schema: SCHEMA,
    replacements: { 4: 'after' },
    store,
    options: { maxMessageBytes: 1024 },
  });

  assert.equal(result.written, true);
  assert.equal(result.byteLength, result.bytes.length);
  assert.deepEqual(result.options, { maxMessageBytes: 1024 });
  assert.deepEqual(readFileSync(target), result.bytes);

  const fields = scan(result.bytes);
  assert.equal(fields.find((f) => f.fieldNumber === 4)!.payload.toString('utf8'), 'after');
});

test('gateway never calls the store when the rewrite rejects', () => {
  const calls: Uint8Array[] = [];
  const store: MessageStore = {
    write(bytes) {
      calls.push(bytes);
    },
  };

  const thrown = (() => {
    try {
      rewriteAndStore({
        input: Buffer.concat([varintField(1, 1n), delimited(4, Buffer.from([0x61, 0xc3, 0x28]))]),
        schema: { 4: 'string' },
        replacements: {},
        store,
      });
    } catch (error) {
      return error;
    }
    return null;
  })();

  assert.ok(thrown instanceof ProtobufRewriteError);
  assert.equal(thrown.code, 'INVALID_UTF8');
  assert.equal(thrown.offset, 5, 'offset points at the malformed lead byte');
  assert.equal(calls.length, 0, 'store must not be called on failure');
});

test('a rejected size limit also skips the store', () => {
  const calls: Uint8Array[] = [];
  const store: MessageStore = {
    write(bytes) {
      calls.push(bytes);
    },
  };

  const thrown = (() => {
    try {
      rewriteAndStore({
        input: sampleInput(),
        schema: SCHEMA,
        replacements: {},
        store,
        options: { maxMessageBytes: 2 },
      });
    } catch (error) {
      return error;
    }
    return null;
  })();

  assert.ok(thrown instanceof ProtobufRewriteError);
  assert.equal(thrown.code, 'SIZE_LIMIT');
  assert.equal(calls.length, 0);
});

test('a missing store is rejected before the rewrite runs', () => {
  assert.throws(
    () =>
      rewriteAndStore({
        input: sampleInput(),
        schema: SCHEMA,
        replacements: {},
        store: undefined as unknown as MessageStore,
      }),
    (thrown: unknown) =>
      thrown instanceof ProtobufRewriteError && thrown.code === 'INVALID_OPTIONS',
  );
});

test('a real SIGKILL before rename leaves the previous target intact', () => {
  const target = join(workDir, 'message.bin');
  writeFileSync(target, Buffer.from('previous-message'));

  const input = sampleInput();
  const result = spawnSync(
    process.execPath,
    [
      CRASH_WRITER,
      'before-rename',
      target,
      input.toString('hex'),
      JSON.stringify(SCHEMA),
      JSON.stringify({ 4: 'after' }),
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.signal, 'SIGKILL', `expected SIGKILL, got ${result.status}/${result.signal}: ${result.stderr}`);
  assert.equal(readFileSync(target, 'utf8'), 'previous-message', 'target is unchanged');
  const swept = cleanupStaleTemps(target);
  assert.equal(swept.length, 1, 'the staged temp file is discoverable and removable');
  assert.equal(existsSync(swept[0]!), false);
});

test('a real SIGKILL mid-write never leaves a partial target', () => {
  const target = join(workDir, 'message.bin');
  writeFileSync(target, Buffer.from('previous-message'));

  const input = sampleInput();
  const result = spawnSync(
    process.execPath,
    [
      CRASH_WRITER,
      'mid-write',
      target,
      input.toString('hex'),
      JSON.stringify(SCHEMA),
      JSON.stringify({ 4: 'a-much-longer-replacement-value' }),
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.signal, 'SIGKILL');
  assert.equal(readFileSync(target, 'utf8'), 'previous-message');
  const swept = cleanupStaleTemps(target);
  assert.equal(swept.length, 1);
});

test('concurrent writers cannot clobber each other\'s staged files', () => {
  const target = join(workDir, 'message.bin');
  const payload = Buffer.from('payload');

  const first = tempPathFor(target);
  const second = tempPathFor(target);
  assert.notEqual(first, second, 'staged names are unique per call');
  assert.notEqual(first, second);

  // A fresh atomic write still lands correctly after unrelated temps existed.
  writeFileAtomic(target, payload, {
    onStagedPath: () => {
      // Touch a file at a *different* staged name to simulate a peer writer.
      writeFileSync(second, 'peer');
    },
  });
  assert.deepEqual(readFileSync(target), payload);
  assert.equal(existsSync(second), true, 'peer temp is not ours to remove');
  assert.deepEqual(cleanupStaleTemps(target), [second]);
});

test('temp files are created inside the target directory, enabling rename', () => {
  const nested = join(workDir, 'nested');
  const target = join(nested, 'message.bin');
  mkdirSync(nested, { recursive: true });

  let observed: string | null = null;
  writeFileAtomic(target, Buffer.from('x'), {
    onStagedPath: (path) => {
      observed = path;
    },
  });

  assert.ok(observed !== null);
  assert.equal((observed as string).startsWith(nested + '/'), true, 'temp is a sibling of the target');
  assert.deepEqual(readFileSync(target), Buffer.from('x'));
  // Never leaks into the OS temp directory.
  assert.equal((observed as string).startsWith(tmpdir() + '/'), false);
});
