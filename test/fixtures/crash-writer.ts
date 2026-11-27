/**
 * Child process used by the crash tests.
 *
 * It stages a rewritten message and then dies abruptly at a configurable point,
 * simulating a gateway worker being killed mid-publish.
 *
 * argv: <mode> <targetPath> <messageHex> <schemaJson>
 *   mode = "before-rename"  -> SIGKILL just before the atomic rename
 *          "mid-write"      -> SIGKILL after opening the temp file, before data
 */

import { closeSync, openSync, writeSync } from 'node:fs';
import process from 'node:process';

import { rewriteMessage } from '../../src/index.ts';
import { tempPathFor, writeFileAtomic } from '../../src/atomic.ts';
import type { FieldSchemaInput, ReplacementTableInput } from '../../src/types.ts';

const [mode, targetPath, messageHex, schemaJson, replacementsJson] =
  process.argv.slice(2);

if (!mode || !targetPath || !messageHex || !schemaJson) {
  console.error('usage: crash-writer.ts <mode> <targetPath> <messageHex> <schemaJson> [replacementsJson]');
  process.exit(64);
}

const schema = JSON.parse(schemaJson) as FieldSchemaInput;
const replacements = JSON.parse(replacementsJson ?? '{}') as ReplacementTableInput;
const bytes = rewriteMessage(Buffer.from(messageHex, 'hex'), schema, replacements);

if (mode === 'before-rename') {
  writeFileAtomic(targetPath, bytes, {
    hooks: {
      beforeRename: () => {
        // Simulate a crash at the exact moment between fsync and rename.
        process.kill(process.pid, 'SIGKILL');
      },
    },
  });
} else if (mode === 'mid-write') {
  // Write a partial temp file and die without renaming.
  const staged = tempPathFor(targetPath);
  const fd = openSync(staged, 'wx', 0o600);
  writeSync(fd, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)));
  closeSync(fd);
  process.kill(process.pid, 'SIGKILL');
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(64);
}

// Unreachable: both modes kill the process.
process.exit(70);
