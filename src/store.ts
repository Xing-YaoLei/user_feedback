/**
 * Crashing-safe local persistence for topology snapshots.
 *
 * A snapshot is written through a caller-supplied adapter (defaulting to
 * `node:fs/promises`) in three steps: write a temp file, fsync-ish flush, then
 * atomically rename it over the target. A crash at *any* point therefore
 * leaves either the previous file untouched or the new file fully present —
 * never a half-written topology.
 *
 * The envelope carries a SHA-256 checksum of the canonical payload so a
 * truncated or hand-edited file is rejected loudly instead of being routed
 * against.
 *
 * This module is optional: the router itself is pure and synchronous. Use it
 * when a host process needs to survive restarts.
 */

import { createHash } from 'node:crypto';

import { compileTopology } from './topology.ts';
import { snapshotOf } from './router.ts';
import type { RouterSnapshotInfo } from './router.ts';
import { RouterError } from './types.ts';
import type { BindingDefinition, Topology, TopologyInput } from './types.ts';

/** The minimal filesystem surface needed; inject a fake to test crashes. */
export interface SnapshotFileAdapter {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface SnapshotEnvelope {
  readonly format: 'message-router-topology';
  readonly formatVersion: 1;
  readonly version: number;
  readonly checksum: string;
  /** Canonical JSON string of the topology input. */
  readonly payload: string;
}

export interface LoadedSnapshot {
  readonly version: number;
  readonly topology: Topology;
  readonly info: RouterSnapshotInfo;
}

export interface TopologyStoreOptions {
  readonly path: string;
  readonly adapter?: SnapshotFileAdapter;
}

const FORMAT = 'message-router-topology';

/** Canonicalise a topology so equal topologies hash equally. */
export function canonicalTopology(input: TopologyInput): string {
  const exchanges = [...(input.exchanges ?? [])]
    .map((exchange) => ({
      name: exchange.name,
      kind: exchange.kind,
      ...(exchange.alternateExchange === undefined
        ? {}
        : { alternateExchange: exchange.alternateExchange }),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const queues = [...(input.queues ?? [])]
    .map((queue) => ({ name: queue.name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const bindings = [...(input.bindings ?? [])]
    .map((binding) => canonicalBinding(binding))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ exchanges, queues, bindings });
}

function canonicalBinding(binding: BindingDefinition): Record<string, unknown> {
  return {
    id: binding.id,
    source: binding.source,
    destination: binding.destination,
    ...(binding.destinationKind === undefined ? {} : { destinationKind: binding.destinationKind }),
    ...(binding.routingKey === undefined ? {} : { routingKey: binding.routingKey }),
  };
}

function checksum(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function corrupt(message: string): never {
  throw new RouterError('CORRUPT_SNAPSHOT', message);
}

/**
 * Atomically persist a topology snapshot.
 *
 * Throws `RouterError` (`INVALID_TOPOLOGY`) before touching the filesystem if
 * the description does not compile. Returns the compiled snapshot info, so the
 * caller can adopt the same version in memory.
 */
export async function saveSnapshot(
  options: TopologyStoreOptions,
  input: TopologyInput,
  version: number,
): Promise<RouterSnapshotInfo> {
  if (!Number.isInteger(version) || version < 0) {
    throw new RouterError('INVALID_VERSION', `version must be a non-negative integer, got ${version}`);
  }
  // Compile first: an invalid topology must never reach the filesystem.
  const topology = compileTopology(input);
  const info = snapshotOf(topology, version);
  const payload = canonicalTopology(input);
  const envelope: SnapshotEnvelope = {
    format: FORMAT,
    formatVersion: 1,
    version,
    checksum: checksum(payload),
    payload,
  };

  const adapter = options.adapter ?? nodeAdapter;
  const tempPath = `${options.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const serialised = JSON.stringify(envelope);
  try {
    await adapter.writeFile(tempPath, serialised);
    await adapter.rename(tempPath, options.path);
  } catch (error) {
    // Best-effort cleanup; a failure here must not mask the original error.
    try {
      await adapter.remove(tempPath);
    } catch {
      /* ignore */
    }
    throw new RouterError(
      'SNAPSHOT_WRITE_FAILED',
      `could not write topology snapshot to ${options.path}: ${(error as Error).message}`,
    );
  }
  return info;
}

/**
 * Load a previously saved snapshot. Returns `null` when the file is absent.
 * Throws `RouterError` (`CORRUPT_SNAPSHOT`) for malformed, truncated or
 * checksum-mismatched contents — never silently falls back to an older
 * topology, because routing against an unexpected graph is worse than failing.
 */
export async function loadSnapshot(options: TopologyStoreOptions): Promise<LoadedSnapshot | null> {
  const adapter = options.adapter ?? nodeAdapter;
  let raw: string;
  try {
    raw = await adapter.readFile(options.path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return null;
    throw new RouterError(
      'SNAPSHOT_READ_FAILED',
      `could not read topology snapshot from ${options.path}: ${(error as Error).message}`,
    );
  }

  let envelope: SnapshotEnvelope;
  try {
    envelope = JSON.parse(raw) as SnapshotEnvelope;
  } catch {
    corrupt(`snapshot at ${options.path} is not valid JSON`);
  }
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    envelope.format !== FORMAT ||
    envelope.formatVersion !== 1
  ) {
    corrupt(`snapshot at ${options.path} has an unknown format`);
  }
  if (typeof envelope.payload !== 'string' || typeof envelope.checksum !== 'string') {
    corrupt(`snapshot at ${options.path} is missing its payload or checksum`);
  }
  if (checksum(envelope.payload) !== envelope.checksum) {
    corrupt(`snapshot at ${options.path} failed its checksum (truncated or edited?)`);
  }
  if (!Number.isInteger(envelope.version) || envelope.version < 0) {
    corrupt(`snapshot at ${options.path} has an invalid version`);
  }

  let input: TopologyInput;
  try {
    input = JSON.parse(envelope.payload) as TopologyInput;
  } catch {
    corrupt(`snapshot at ${options.path} has a malformed payload`);
  }

  let topology: Topology;
  try {
    topology = compileTopology(input);
  } catch (error) {
    corrupt(
      `snapshot at ${options.path} contains an invalid topology: ${(error as Error).message}`,
    );
  }
  return Object.freeze({
    version: envelope.version,
    topology,
    info: snapshotOf(topology, envelope.version),
  });
}

/** Default adapter backed by `node:fs/promises` with a durability hint. */
const nodeAdapter: SnapshotFileAdapter = {
  async readFile(path) {
    const { readFile } = await import('node:fs/promises');
    return readFile(path, 'utf8');
  },
  async writeFile(path, data) {
    const { open } = await import('node:fs/promises');
    const handle = await open(path, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      // Flush file contents before the rename makes them visible.
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    const { rename } = await import('node:fs/promises');
    await rename(from, to);
  },
  async remove(path) {
    const { unlink } = await import('node:fs/promises');
    await unlink(path);
  },
};
