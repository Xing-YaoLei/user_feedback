import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tempDir(prefix = 'catalog-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const silentLogger = {
  log() {},
  info() {},
  warn() {},
  error() {},
};
