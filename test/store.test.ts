import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  Router,
  RouterError,
  canonicalTopology,
  loadSnapshot,
  saveSnapshot,
} from '../src/index.ts';
import type { SnapshotFileAdapter, TopologyInput } from '../src/index.ts';
import { shopTopology } from './fixtures.ts';

/** In-memory adapter that can be told to fail at any step. */
class MemoryAdapter implements SnapshotFileAdapter {
  files = new Map<string, string>();
  failAt: 'writeFile' | 'rename' | 'readFile' | null = null;

  async readFile(path: string): Promise<string> {
    if (this.failAt === 'readFile') throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  }

  async writeFile(path: string, data: string): Promise<void> {
    if (this.failAt === 'writeFile') throw new Error('simulated crash during write');
    this.files.set(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failAt === 'rename') throw new Error('simulated crash during rename');
    const value = this.files.get(from);
    if (value === undefined) throw Object.assign(new Error('missing temp'), { code: 'ENOENT' });
    this.files.set(to, value);
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

const PATH = '/virtual/topology.json';

test('save then load round-trips a topology and its version', async () => {
  const adapter = new MemoryAdapter();
  const info = await saveSnapshot({ path: PATH, adapter }, shopTopology(), 7);
  assert.equal(info.version, 7);
  assert.equal(info.bindingCount, 13);

  const loaded = await loadSnapshot({ path: PATH, adapter });
  assert.ok(loaded);
  assert.equal(loaded.version, 7);
  assert.equal(loaded.topology.bindings.length, 13);

  // The restored router continues from version 7 and routes correctly.
  const router = Router.fromSnapshot(loaded);
  assert.equal(router.version, 7);
  const result = router.route({ exchange: 'ingress', routingKey: 'order.created' });
  assert.deepEqual(result.targets.map((target) => target.queue), ['q-left', 'q-right']);
  assert.equal(result.topologyVersion, 7);
});

test('load returns null when nothing has been saved', async () => {
  const adapter = new MemoryAdapter();
  assert.equal(await loadSnapshot({ path: '/virtual/absent.json', adapter }), null);
});

test('invalid topology never reaches the store', async () => {
  const adapter = new MemoryAdapter();
  await assert.rejects(
    () =>
      saveSnapshot({ path: PATH, adapter }, {
        exchanges: [{ name: 'e', kind: 'topic' }],
        queues: [{ name: 'q' }],
        bindings: [
          { id: 'b', source: 'e', destination: 'q', destinationKind: 'queue', routingKey: 'a..b' },
        ],
      }, 1),
    (error: unknown) => error instanceof RouterError && error.code === 'INVALID_TOPOLOGY',
  );
  assert.equal(adapter.files.size, 0);
});

test('crash during write leaves the previous snapshot intact', async () => {
  const adapter = new MemoryAdapter();
  await saveSnapshot({ path: PATH, adapter }, shopTopology(), 1);
  const previous = adapter.files.get(PATH);
  assert.ok(previous);

  adapter.failAt = 'writeFile';
  await assert.rejects(
    () => saveSnapshot({ path: PATH, adapter }, shopTopology(), 2),
    (error: unknown) => error instanceof RouterError && error.code === 'SNAPSHOT_WRITE_FAILED',
  );
  assert.equal(adapter.files.get(PATH), previous);
  assert.equal((await loadSnapshot({ path: PATH, adapter }))?.version, 1);
});

test('crash between write and rename leaves the previous snapshot intact and no temp', async () => {
  const adapter = new MemoryAdapter();
  await saveSnapshot({ path: PATH, adapter }, shopTopology(), 1);
  const previous = adapter.files.get(PATH);

  adapter.failAt = 'rename';
  await assert.rejects(
    () => saveSnapshot({ path: PATH, adapter }, shopTopology(), 2),
    (error: unknown) => error instanceof RouterError && error.code === 'SNAPSHOT_WRITE_FAILED',
  );

  assert.equal(adapter.files.get(PATH), previous);
  // The half-written temp file must have been cleaned up.
  assert.deepEqual([...adapter.files.keys()], [PATH]);
  adapter.failAt = null;
  assert.equal((await loadSnapshot({ path: PATH, adapter }))?.version, 1);
});

test('truncated or edited snapshots are rejected, not silently used', async () => {
  const adapter = new MemoryAdapter();
  await saveSnapshot({ path: PATH, adapter }, shopTopology(), 3);
  const raw = adapter.files.get(PATH);
  assert.ok(raw);

  // Truncate.
  adapter.files.set(PATH, raw.slice(0, raw.length / 2));
  await assert.rejects(
    () => loadSnapshot({ path: PATH, adapter }),
    (error: unknown) => error instanceof RouterError && error.code === 'CORRUPT_SNAPSHOT',
  );

  // Swap a character in the payload without fixing the checksum.
  const envelope = JSON.parse(raw) as { payload: string; checksum: string };
  const edited = {
    ...envelope,
    payload: envelope.payload.replace('q-left', 'q-xxxx'),
  };
  adapter.files.set(PATH, JSON.stringify(edited));
  await assert.rejects(
    () => loadSnapshot({ path: PATH, adapter }),
    (error: unknown) => error instanceof RouterError && error.code === 'CORRUPT_SNAPSHOT',
  );
});

test('reading a corrupt file surfaces a typed error, never routes', async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(PATH, 'not json at all');
  await assert.rejects(
    () => loadSnapshot({ path: PATH, adapter }),
    (error: unknown) =>
      error instanceof RouterError &&
      error.code === 'CORRUPT_SNAPSHOT' &&
      /not valid JSON/.test(error.message),
  );
});

test('payload with a valid checksum but an invalid topology is rejected', async () => {
  const adapter = new MemoryAdapter();
  // Hand-build a consistent envelope around a topology that cannot compile.
  const badInput: TopologyInput = {
    exchanges: [{ name: 'e', kind: 'fanout' }],
    bindings: [{ id: 'b', source: 'e', destination: 'missing', destinationKind: 'queue' }],
  };
  const payload = canonicalTopology(badInput);
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(payload, 'utf8').digest('hex');
  adapter.files.set(
    PATH,
    JSON.stringify({ format: 'message-router-topology', formatVersion: 1, version: 1, checksum, payload }),
  );
  await assert.rejects(
    () => loadSnapshot({ path: PATH, adapter }),
    (error: unknown) =>
      error instanceof RouterError &&
      error.code === 'CORRUPT_SNAPSHOT' &&
      /invalid topology/.test(error.message),
  );
});

test('canonical form ignores declaration order', () => {
  const base = shopTopology();
  const shuffled: TopologyInput = {
    exchanges: [...(base.exchanges ?? [])].reverse(),
    queues: [...(base.queues ?? [])].reverse(),
    bindings: [...(base.bindings ?? [])].reverse(),
  };
  assert.equal(canonicalTopology(base), canonicalTopology(shuffled));
});

test('real filesystem: atomic save and load inside a workspace scratch dir', async () => {
  // Temp data stays inside the repository (gitignored) per the project rules.
  const root = join(process.cwd(), '.scratch');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'store-'));
  try {
    const path = join(dir, 'topology.json');
    await saveSnapshot({ path }, shopTopology(), 42);
    const loaded = await loadSnapshot({ path });
    assert.ok(loaded);
    assert.equal(loaded.version, 42);

    // No leftover temp files: exactly one entry in the directory.
    assert.deepEqual(readdirSync(dir), ['topology.json']);

    // Overwrite works and stays a single file.
    await saveSnapshot(
      { path },
      {
        exchanges: [{ name: 'e', kind: 'fanout' }],
        queues: [{ name: 'only' }],
        bindings: [{ id: 'b1', source: 'e', destination: 'only', destinationKind: 'queue' }],
      },
      43,
    );
    assert.deepEqual(readdirSync(dir), ['topology.json']);
    const second = await loadSnapshot({ path });
    assert.equal(second?.version, 43);
    assert.deepEqual([...(second?.topology.queueNames ?? [])], ['only']);

    // The stored file is a readable envelope with a checksum.
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { checksum: string };
    assert.match(envelope.checksum, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});