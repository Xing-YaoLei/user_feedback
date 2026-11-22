import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { DiscoveryClient } from '../src/client.ts';

function bootstrap(): { registry: Registry; clock: ManualClock; client: DiscoveryClient } {
  const clock = new ManualClock();
  const registry = new Registry(
    { pageTtlMs: 5_000, watchTtlMs: 5_000, watchBacklogLimit: 2 },
    clock,
  );
  registry.createSession({ id: 's', ttlMs: 50_000 });
  const client = new DiscoveryClient(registry, { prefix: 'svc/', pageSize: 2 });
  client.start();
  return { registry, clock, client };
}

describe('DiscoveryClient', () => {
  it('materializes a paged snapshot then converges through the watch', () => {
    const { registry, client } = bootstrap();
    assert.equal(client.syncedRevision, registry.currentRevision);
    assert.equal(client.listInstances().length, 0);

    registry.mutate('s', [
      { type: 'put', key: 'svc/a', data: { n: 1 } },
      { type: 'put', key: 'svc/b', data: { n: 2 } },
    ]); // r1
    registry.mutate('s', [{ type: 'put', key: 'other/c', data: {} }]); // r2 (filtered)
    client.pumpWatch(); // applies r1 changes
    client.pumpWatch(); // empty queue -> progress heartbeat confirming r2

    assert.deepEqual(
      client.listInstances().map((i) => i.key),
      ['svc/a', 'svc/b'],
    );
    // The filtered revision r2 is confirmed through the progress heartbeat.
    assert.equal(client.syncedRevision, 2);

    registry.mutate('s', [{ type: 'delete', key: 'svc/a', expectedGeneration: 1 }]); // r3
    client.pumpWatch();
    assert.deepEqual(
      client.listInstances().map((i) => i.key),
      ['svc/b'],
    );
  });

  it('rebuilds from the provided basis and converges at the snapshot revision', () => {
    const clock = new ManualClock();
    const registry = new Registry(
      { pageTtlMs: 5_000, watchTtlMs: 5_000, watchBacklogLimit: 2 },
      clock,
    );
    registry.createSession({ id: 's', ttlMs: 50_000 });
    const client = new DiscoveryClient(registry, { prefix: 'svc/', pageSize: 2 });
    client.start();

    // Exhaust the watch backlog (limit 2) without pumping the client.
    registry.mutate('s', [{ type: 'put', key: 'svc/a', data: {} }]); // r1
    registry.mutate('s', [{ type: 'put', key: 'svc/b', data: {} }]); // r2
    registry.mutate('s', [{ type: 'put', key: 'svc/c', data: {} }]); // r3 -> backlog 3 evicts
    const evictionRevision = registry.currentRevision;
    assert.equal(evictionRevision, 3);

    // The next pump observes the eviction and performs exactly one rebuild.
    assert.equal(client.pumpWatch(), 0);
    assert.equal(client.rebuildCount, 1);
    const rebuildTrace = client.trace.filter((t) => t.kind === 'watch-rebuild');
    assert.equal(rebuildTrace.length, 1);
    if (rebuildTrace[0]!.kind !== 'watch-rebuild') throw new Error('trace shape');
    assert.equal(rebuildTrace[0].baselineRevision, evictionRevision);
    // The fresh watch starts strictly after the snapshot revision.
    assert.equal(rebuildTrace[0].watchStartRevision, evictionRevision + 1);
    assert.equal(rebuildTrace[0].resumeAfterRevision, evictionRevision);

    // The rebuilt directory equals a fresh full scan of the same prefix.
    const fresh = registry.list({ prefix: 'svc/', pageSize: 100 });
    assert.deepEqual(
      client.listInstances().map((i) => i.key),
      fresh.instances.map((i) => i.key),
    );
    client.close();
    registry.close();
  });

  it('records every page baseline and never mixes snapshot revisions', () => {
    const clock = new ManualClock();
    const registry = new Registry({ pageTtlMs: 5_000, watchBacklogLimit: 8 }, clock);
    registry.createSession({ id: 's', ttlMs: 50_000 });
    registry.mutate(
      's',
      [1, 2, 3, 4, 5].map((n) => ({ type: 'put' as const, key: `svc/${n}`, data: {} })),
    );
    const client = new DiscoveryClient(registry, { prefix: 'svc/', pageSize: 2 });
    const { pages, baselineRevision } = client.resync(null);
    assert.equal(pages.length, 3);
    assert.ok(pages.every((p) => p.baselineRevision === baselineRevision));
    assert.ok(pages.slice(1).every((p) => p.tokenReused));
    assert.equal(client.listInstances().length, 5);
    client.close();
    registry.close();
  });

  it('progress heartbeats move the resume point across filtered revisions', () => {
    const { registry, client } = bootstrap();
    registry.mutate('s', [{ type: 'put', key: 'other/1', data: {} }]);
    // No matching change: the empty-queue consume returns a progress heartbeat
    // that confirms the filtered-out revision.
    client.pumpWatch();
    const progressTraces = client.trace.filter((t) => t.kind === 'progress');
    assert.ok(progressTraces.length >= 1);
    if (progressTraces[0]!.kind !== 'progress') throw new Error('trace shape');
    assert.equal(progressTraces[0].progress, registry.currentRevision);
  });

  it('keepalive extends the watch without consuming messages', () => {
    const { registry, client, clock } = bootstrap();
    registry.mutate('s', [{ type: 'put', key: 'svc/a', data: {} }]);
    const progress = client.keepalive();
    assert.equal(progress, registry.currentRevision);
    assert.equal(client.watchProgress, registry.currentRevision);
    clock.advance(1);
    assert.equal(client.listInstances().length, 0); // not consumed yet
    client.pumpWatch();
    assert.equal(client.listInstances().length, 1);
  });
});
