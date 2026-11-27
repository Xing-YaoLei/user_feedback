/**
 * Crash-safe persistence adapter.
 *
 * The rewriter itself is pure: it either returns a complete Buffer or throws.
 * A gateway still has to hand the bytes to durable storage, and that write can
 * be interrupted by a crash. This adapter stages the bytes in a sibling
 * temporary file, fsyncs, and atomically renames over the target. If anything
 * throws before the rename, the target file is untouched and the temp file is
 * removed. If the process dies mid-write, the target file is still untouched;
 * only a stale temp file can remain, which `cleanupStaleTemps` can sweep.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

export interface AtomicWriteHooks {
  /**
   * Test/telemetry hook invoked once the staged temp file is fully written and
   * fsynced, immediately before the rename. Throwing here simulates a failure
   * at the last possible moment.
   */
  beforeRename?: (stagedPath: string) => void;
  /** Invoked after the rename completes. */
  afterRename?: (stagedPath: string) => void;
}

export interface AtomicWriteOptions {
  /** File mode for the temporary file, defaults to 0o600. */
  mode?: number;
  hooks?: AtomicWriteHooks;
  onStagedPath?: (stagedPath: string) => void;
}

export function tempPathFor(targetPath: string): string {
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return join(dirname(targetPath), `.${basename(targetPath)}.tmp-${unique}`);
}

/**
 * Atomically replace `targetPath` with `data`.
 *
 * @throws whatever the filesystem or a hook throws; the target file is
 *         unchanged in that case and the temp file is unlinked.
 */
export function writeFileAtomic(
  targetPath: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const stagedPath = tempPathFor(targetPath);
  const mode = options.mode ?? 0o600;

  options.onStagedPath?.(stagedPath);

  // `wx` fails rather than clobbering an existing temp file, so concurrent
  // writers cannot interleave their bytes into one staged file.
  const fd = openSync(stagedPath, 'wx', mode);

  try {
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    safeUnlink(stagedPath);
    throw error;
  }

  closeSync(fd);

  try {
    options.hooks?.beforeRename?.(stagedPath);
    renameSync(stagedPath, targetPath);
  } catch (error) {
    safeUnlink(stagedPath);
    throw error;
  }

  options.hooks?.afterRename?.(stagedPath);
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or a crash left it behind; nothing more to do here.
  }
}

/** Remove leftover `.NAME.tmp-*` files for a target, e.g. after a crash. */
export function cleanupStaleTemps(targetPath: string): string[] {
  const directory = dirname(targetPath);
  const prefix = `.${basename(targetPath)}.tmp-`;
  const removed: string[] = [];

  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const full = join(directory, entry);
    try {
      unlinkSync(full);
      removed.push(full);
    } catch {
      // Raced with another cleaner; ignore.
    }
  }

  return removed;
}
