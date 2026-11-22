import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../src/clock.ts';
import {
  CursorExpiredError,
  GenerationConflictError,
  InvalidTokenError,
  RegistryError,
  SessionExpiredError,
  type MutateResult,
} from '../src/index.ts';
import { Registry } from '../src/registry.ts';

function makeRegistry(overrides: Parameters<typeof Registry.prototype.constructor>[0] = {}): {
  registry: Registry;
  clock: ManualClock;
} {
  const clock = new ManualClock();
  const registry = new Registry(
    { pageTtlMs: 100, watchTtlMs: 100, watchBacklogLimit: 4, ...overrides },
    clock,
  );
  return { registry, clock };
}

describe('registry: sessions and leases', () => {
  let registry: Registry;
  let clock: ManualClock;
  beforeEach(() => {
    ({ registry, clock } = makeRegistry());
  });

  it('expires a session in one atomic batch and frees owned keys', () => {
    registry.createSession({ id: 's', ttlMs: 50 });
    registry.mutate('s', [
      { type: 'put', key: 'k/1', data: {} },
      { type: 'put', key: 'k/2', data: {} },
    ]);
    assert.equal(registry.list({ prefix: 'k/' }).instances.length, 2);

    clock.advance(51);
    registry.sweepNow();

    assert.equal(registry.getSession('s'), null);
    assert.equal(registry.list({ prefix: 'k/' }).instances.length, 0);
    // r1 register, r2 expiry batch deleting the two owned keys.
    assert.equal(registry.list({}).revision, 2);
  });

  it('keeps instances of a renewed session alive across the original deadline', () => {
    registry.createSession({ id: 's', ttlMs: 50 });
    registry.mutate('s', [{ type: 'put', key: 'k/1', data: {} }]);
    clock.advance(40);
    registry.keepAlive('s');
    clock.advance(40); // t=80, past the original 50ms deadline
    registry.sweepNow();
    assert.ok(registry.getSession('s'));
    assert.ok(registry.viewAt('k/1', registry.currentRevision));
  });

  it('rejects all operations from a dead session', () => {
    registry.createSession({ id: 's', ttlMs: 10 });
    clock.advance(11);
    registry.sweepNow();
    assert.throws(() => registry.mutate('s', [{ type: 'put', key: 'k', data: {} }]), SessionExpiredError);
    assert.throws(() => registry.keepAlive('s'), SessionExpiredError);
    // Closing an already-dead session is an idempotent no-op returning null.
    assert.equal(registry.closeSession('s'), null);
  });
});

describe('registry: batched atomic mutations and revisions', () => {
  let registry: Registry;
  beforeEach(() => {
    ({ registry } = makeRegistry());
  });

  it('assigns one global increasing revision per whole batch', () => {
    registry.createSession({ id: 's', ttlMs: 1000 });
    const r1: MutateResult = registry.mutate('s', [
      { type: 'put', key: 'a/1', data: {} },
      { type: 'put', key: 'a/2', data: {} },
      { type: 'put', key: 'a/3', data: {} },
    ]);
    const r2 = registry.mutate('s', [{ type: 'put', key: 'b/1', data: {} }]);
    assert.equal(r1.revision, 1);
    assert.equal(r2.revision, 2);
    assert.equal(registry.currentRevision, 2);
    assert.deepEqual(
      r1.events.map((e) => e.key),
      ['a/1', 'a/2', 'a/3'],
    );
  });

  it('rolls back the whole batch when any mutation fails validation', () => {
    registry.createSession({ id: 's', ttlMs: 1000 });
    registry.mutate('s', [{ type: 'put', key: 'a/1', data: { v: 1 } }]);
    const before = registry.currentRevision;
    assert.throws(
      () =>
        registry.mutate('s', [
          { type: 'put', key: 'a/2', data: {} },
          { type: 'delete', key: 'a/1', expectedGeneration: 99 },
        ]),
      GenerationConflictError,
    );
    assert.equal(registry.currentRevision, before);
    assert.equal(registry.list({ prefix: 'a/' }).instances.length, 1);
  });

  it('rejects batches touching the same key twice', () => {
    registry.createSession({ id: 's', ttlMs: 1000 });
    assert.throws(
      () =>
        registry.mutate('s', [
          { type: 'put', key: 'a/1', data: {} },
          { type: 'put', key: 'a/1', data: {} },
        ]),
      RegistryError,
    );
  });

  it('serves immutable historical views through viewAt', () => {
    registry.createSession({ id: 's', ttlMs: 1000 });
    registry.mutate('s', [{ type: 'put', key: 'a/1', data: { v: 1 } }]);
    registry.mutate('s', [{ type: 'put', key: 'a/1', data: { v: 2 } }]);
    registry.mutate('s', [{ type: 'delete', key: 'a/1', expectedGeneration: 2 }]);
    assert.equal(registry.viewAt('a/1', 1)?.data.v, 1);
    assert.equal(registry.viewAt('a/1', 2)?.data.v, 2);
    assert.equal(registry.viewAt('a/1', 3), null);
    assert.equal(registry.viewAt('a/1', 0), null);

    registry.mutate('s', [{ type: 'put', key: 'a/1', data: { v: 4 } }]); // r4
    registry.compact(3);
    // Current-state point read stays available even after the key's older
    // versions fell below the compaction watermark.
    assert.equal(registry.viewAt('a/1', 4)?.data.v, 4);
    // Reading an arbitrary historical revision whose version was pruned
    // fails with an explicit rebuild signal.
    assert.throws(() => registry.viewAt('a/1', 2), CursorExpiredError);
  });
});

describe('registry: generation fencing across sessions', () => {
  let registry: Registry;
  beforeEach(() => {
    ({ registry } = makeRegistry());
  });

  it('bumps generation on takeover and fences the old session', () => {
    registry.createSession({ id: 'old', ttlMs: 1000 });
    registry.createSession({ id: 'new', ttlMs: 1000 });
    registry.mutate('old', [{ type: 'put', key: 'k', data: { owner: 'old' } }]);
    const r2 = registry.mutate('new', [{ type: 'put', key: 'k', data: { owner: 'new' } }]);
    assert.equal(r2.events[0]!.generation, 2);

    // Late keepalive from the old generation cannot extend anything.
    assert.throws(
      () => registry.keepAlive('old', { key: 'k', generation: 1 }),
      GenerationConflictError,
    );
    // Late fenced delete from the old generation is rejected.
    assert.throws(
      () => registry.mutate('old', [{ type: 'delete', key: 'k', expectedGeneration: 1 }]),
      GenerationConflictError,
    );
    const live = registry.viewAt('k', registry.currentRevision)!;
    assert.equal(live.sessionId, 'new');
    assert.equal(live.generation, 2);
    assert.equal(registry.getSession('old')!.keys.length, 0);
  });

  it('session expiry skips keys already taken over by another session', () => {
    registry.createSession({ id: 'old', ttlMs: 50 });
    registry.createSession({ id: 'new', ttlMs: 1000 });
    registry.mutate('old', [
      { type: 'put', key: 'k/1', data: {} },
      { type: 'put', key: 'k/2', data: {} },
    ]);
    registry.mutate('new', [{ type: 'put', key: 'k/1', data: { taken: true } }]);
    const revisionBeforeExpiry = registry.currentRevision;
    registry.expireSessionNow('old');
    const live = registry.list({ prefix: 'k/' }).instances;
    assert.deepEqual(
      live.map((i) => i.key),
      ['k/1'],
    );
    assert.equal(live[0]!.sessionId, 'new');
    // The expiry batch still gets its own revision.
    assert.equal(registry.currentRevision, revisionBeforeExpiry + 1);
  });

  it('keeps generation monotonic even after a delete', () => {
    registry.createSession({ id: 's', ttlMs: 1000 });
    registry.mutate('s', [{ type: 'put', key: 'k', data: {} }]);
    registry.mutate('s', [{ type: 'delete', key: 'k', expectedGeneration: 1 }]);
    const r3 = registry.mutate('s', [{ type: 'put', key: 'k', data: {} }]);
    assert.equal(r3.events[0]!.generation, 3);
  });
});

describe('registry: snapshot pagination', () => {
  let registry: Registry;
  beforeEach(() => {
    ({ registry } = makeRegistry({ pageTtlMs: 1000 }));
  });

  it('binds every page to the first-page revision despite concurrent writes', () => {
    registry.createSession({ id: 's', ttlMs: 10_000 });
    registry.mutate(
      's',
      [1, 2, 3, 4, 5].map((n) => ({ type: 'put' as const, key: `k/${n}`, data: { n } })),
    );
    const first = registry.list({ prefix: 'k/', pageSize: 2 });
    assert.equal(first.revision, 1);

    // Writes and deletes while the client is paging.
    registry.mutate('s', [
      { type: 'put', key: 'k/6', data: {} },
      { type: 'delete', key: 'k/2', expectedGeneration: 1 },
      { type: 'put', key: 'k/1', data: { replaced: true } },
    ]);
    const second = registry.list({ prefix: 'k/', pageSize: 2, pageToken: first.nextPageToken! });
    const third = registry.list({ prefix: 'k/', pageSize: 2, pageToken: second.nextPageToken! });

    for (const page of [first, second, third]) assert.equal(page.revision, 1);
    const keys = [...first.instances, ...second.instances, ...third.instances].map((i) => i.key);
    assert.deepEqual(keys, ['k/1', 'k/2', 'k/3', 'k/4', 'k/5']);
    assert.equal(third.nextPageToken, null);
    // Snapshot content is the revision-1 payload, not the replacement.
    assert.equal(first.instances[0]!.data.replaced, undefined);
  });

  it('never duplicates or skips rows when ordering changes between pages', () => {
    registry.createSession({ id: 's', ttlMs: 10_000 });
    registry.mutate(
      's',
      ['a', 'b', 'c', 'd', 'e'].map((k) => ({ type: 'put' as const, key: `k/${k}`, data: {} })),
    );
    const first = registry.list({ prefix: 'k/', pageSize: 2 });
    // Keys inserted lexicographically inside the scan range after page 1.
    registry.mutate('s', [
      { type: 'put', key: 'k/a2', data: {} },
      { type: 'put', key: 'k/b2', data: {} },
    ]);
    const second = registry.list({ prefix: 'k/', pageSize: 2, pageToken: first.nextPageToken! });
    const third = registry.list({ prefix: 'k/', pageSize: 2, pageToken: second.nextPageToken! });
    const all = [...first.instances, ...second.instances, ...third.instances].map((i) => i.key);
    assert.deepEqual(all, ['k/a', 'k/b', 'k/c', 'k/d', 'k/e']);
    assert.equal(new Set(all).size, all.length);
  });

  it('rejects tokens from another prefix and malformed tokens', () => {
    registry.createSession({ id: 's', ttlMs: 10_000 });
    registry.mutate('s', [
      { type: 'put', key: 'a/1', data: {} },
      { type: 'put', key: 'b/1', data: {} },
    ]);
    const page = registry.list({ prefix: 'a/', pageSize: 1 });
    assert.throws(
      () => registry.list({ prefix: 'b/', pageSize: 1, pageToken: page.nextPageToken! }),
      InvalidTokenError,
    );
    assert.throws(() => registry.list({ pageToken: 'not-a-token' }), InvalidTokenError);
  });

  it('expires page cursors on TTL, capacity eviction and compaction', () => {
    const clock = new ManualClock();
    const local = new Registry(
      { pageTtlMs: 50, maxPageCursors: 2, watchBacklogLimit: 4 },
      clock,
    );
    local.createSession({ id: 's', ttlMs: 10_000 });
    local.mutate('s', [{ type: 'put', key: 'k/1', data: {} }]);

    // Liveness expiry.
    const p1 = local.list({ prefix: 'k/', pageSize: 1 });
    clock.advance(51);
    local.sweepNow();
    assert.throws(() => local.list({ pageToken: p1.nextPageToken! }), (error: unknown) => {
      return error instanceof CursorExpiredError && error.reason === 'liveness';
    });

    // Capacity eviction (LRU).
    const t1 = local.list({ prefix: 'k/', pageSize: 1 }).nextPageToken!;
    const t2 = local.list({ prefix: 'k/', pageSize: 1 }).nextPageToken!;
    local.list({ prefix: 'k/', pageSize: 1 }); // third cursor evicts the oldest
    assert.throws(() => local.list({ pageToken: t1 }), (error: unknown) => {
      return error instanceof CursorExpiredError && error.reason === 'capacity';
    });
    assert.ok(t2);

    // Compaction expiry.
    const page = local.list({ prefix: 'k/', pageSize: 1 });
    local.mutate('s', [{ type: 'put', key: 'k/2', data: {} }]);
    local.compact(local.currentRevision);
    assert.throws(() => local.list({ pageToken: page.nextPageToken! }), (error: unknown) => {
      return error instanceof CursorExpiredError && error.reason === 'compacted';
    });
    local.close();
  });
});

describe('registry: watches', () => {
  let registry: Registry;
  let clock: ManualClock;
  beforeEach(() => {
    ({ registry, clock } = makeRegistry({ watchTtlMs: 1000, watchBacklogLimit: 3 }));
    registry.createSession({ id: 's', ttlMs: 10_000 });
  });

  it('delivers only prefix-matching events and keeps resumable progress', () => {
    const watch = registry.watch({ prefix: 'svc/' });
    // One atomic batch contains a filtered key and a matching key: only the
    // matching event is delivered, but the batch's revision is fully confirmed.
    registry.mutate('s', [
      { type: 'put', key: 'other/1', data: {} },
      { type: 'put', key: 'svc/1', data: {} },
    ]);
    const messages = watch.consume();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.type, 'changes');
    if (messages[0]!.type === 'changes') {
      assert.deepEqual(messages[0].events.map((e) => e.key), ['svc/1']);
      assert.equal(messages[0].revision, 1);
    }
    const [heartbeat] = watch.consume();
    assert.equal(heartbeat!.type, 'progress');
    if (heartbeat!.type === 'progress') assert.equal(heartbeat.progress, 1);

    // A revision whose every event is filtered out still advances the
    // resumable progress: a following heartbeat reports the skipped revision.
    registry.mutate('s', [{ type: 'put', key: 'other/2', data: {} }]); // rev2, filtered
    const [gapHeartbeat] = watch.consume();
    assert.equal(gapHeartbeat!.type, 'progress');
    if (gapHeartbeat!.type === 'progress') assert.equal(gapHeartbeat.progress, 2);

    // Resume strictly after progress never replays old revisions.
    watch.close();
    const resumed = registry.watch({ prefix: 'svc/', startRevision: 3 });
    registry.mutate('s', [{ type: 'put', key: 'svc/2', data: {} }]); // rev3
    const [msg] = resumed.consume();
    assert.equal(msg!.type, 'changes');
    if (msg!.type === 'changes') assert.deepEqual(msg.events.map((e) => e.key), ['svc/2']);
    resumed.close();
  });

  it('replays retained history when starting at an older revision', () => {
    registry.mutate('s', [{ type: 'put', key: 'svc/1', data: {} }]); // rev1
    registry.mutate('s', [{ type: 'put', key: 'svc/2', data: {} }]); // rev2
    const watch = registry.watch({ prefix: 'svc/', startRevision: 1 });
    const messages = watch.consume(16);
    assert.deepEqual(
      messages.map((m) => (m.type === 'changes' ? m.revision : -1)),
      [1, 2],
    );
    watch.close();
  });

  it('evicts a slow watcher with a rebuild basis while writes and peers continue', () => {
    const slow = registry.watch({ prefix: 'svc/' });
    // The peer drains after every write, so only the slow watcher falls behind.
    const peer = registry.watch({ prefix: 'svc/' });
    for (let i = 1; i <= 4; i++) {
      registry.mutate('s', [{ type: 'put', key: `svc/${i}`, data: {} }]);
      peer.consume();
    }
    assert.throws(() => slow.consume(), (error: unknown) => {
      return (
        error instanceof CursorExpiredError &&
        error.reason === 'backlog' &&
        error.rebuildBasis.snapshotRevision === registry.currentRevision
      );
    });
    // The peer and the write path are unaffected.
    registry.mutate('s', [{ type: 'put', key: 'svc/after', data: {} }]);
    const peerMessages = peer.consume(16);
    assert.equal(peerMessages.length, 1);
    assert.equal(registry.stats().liveWatches, 1);
    peer.close();
  });

  it('refuses a watch starting inside compacted history with a rebuild signal', () => {
    registry.mutate('s', [{ type: 'put', key: 'svc/1', data: {} }]);
    registry.compact(1);
    assert.throws(() => registry.watch({ startRevision: 1 }), (error: unknown) => {
      return error instanceof CursorExpiredError && error.reason === 'compacted';
    });
  });

  it('expires an idle watch through its liveness TTL', () => {
    const watch = registry.watch({ ttlMs: 100 });
    clock.advance(101);
    registry.sweepNow();
    assert.throws(() => watch.consume(), (error: unknown) => {
      return error instanceof CursorExpiredError && error.reason === 'liveness';
    });
  });

  it('a closed watch releases its slot and history pin', () => {
    const watch = registry.watch();
    assert.equal(registry.stats().liveWatches, 1);
    watch.close();
    assert.equal(registry.stats().liveWatches, 0);
  });
});

describe('registry: compaction and resource accounting', () => {
  let registry: Registry;
  beforeEach(() => {
    ({ registry } = makeRegistry());
    registry.createSession({ id: 's', ttlMs: 10_000 });
  });

  it('drops old revisions while keeping the newest state of each key', () => {
    registry.mutate('s', [{ type: 'put', key: 'k/1', data: { v: 1 } }]); // r1
    registry.mutate('s', [{ type: 'put', key: 'k/1', data: { v: 2 } }]); // r2
    registry.mutate('s', [{ type: 'put', key: 'k/2', data: {} }]); // r3
    const result = registry.compact(2);
    assert.equal(result.removedRevisions, 2);
    assert.equal(registry.compactedRevision, 2);
    // Current state remains readable.
    assert.equal(registry.viewAt('k/1', 3)?.data.v, 2);
    assert.ok(registry.viewAt('k/2', 3));
    // Historical read inside the compacted window fails with a rebuild signal.
    assert.throws(() => registry.viewAt('k/1', 1), CursorExpiredError);
  });

  it('retains tombstones so post-compaction deletes stay invisible', () => {
    registry.mutate('s', [{ type: 'put', key: 'k/1', data: {} }]); // r1
    registry.mutate('s', [{ type: 'delete', key: 'k/1', expectedGeneration: 1 }]); // r2
    registry.compact(2);
    assert.equal(registry.viewAt('k/1', 2), null);
    // A new registration after compaction gets generation 3, proving the
    // tombstone preserved the per-key generation.
    const r3 = registry.mutate('s', [{ type: 'put', key: 'k/1', data: {} }]);
    assert.equal(r3.events[0]!.generation, 3);
  });

  it('auto-compacts when the retained-revision bound is exceeded', () => {
    const local = new Registry({ maxRetainedRevisions: 2, watchBacklogLimit: 8 }, new ManualClock());
    local.createSession({ id: 's', ttlMs: 10_000 });
    for (let i = 1; i <= 5; i++) local.mutate('s', [{ type: 'put', key: `k/${i}`, data: {} }]);
    assert.ok(local.compactedRevision >= 1);
    assert.equal(local.stats().retainedRevisions, 2);
    local.close();
  });

  it('releases the history pin when a page scan finishes or a watch closes', () => {
    const local = new Registry({ pageTtlMs: 5_000, watchTtlMs: 5_000 }, new ManualClock());
    local.createSession({ id: 's', ttlMs: 10_000 });
    local.mutate('s', [{ type: 'put', key: 'k/1', data: {} }]);

    // A completed multi-page scan leaves no live cursor behind.
    const first = local.list({ prefix: 'k/', pageSize: 1 });
    assert.ok(first.nextPageToken);
    assert.equal(local.stats().livePageCursors, 1);
    assert.equal(local.stats().oldestPinnedRevision, 1);
    const second = local.list({ prefix: 'k/', pageSize: 1, pageToken: first.nextPageToken! });
    assert.equal(second.nextPageToken, null);
    assert.equal(local.stats().livePageCursors, 0);

    const watch = local.watch();
    assert.equal(local.stats().liveWatches, 1);
    watch.close();
    assert.equal(local.stats().liveWatches, 0);
    assert.equal(local.stats().oldestPinnedRevision, null);
    local.close();
  });

  it('fires automatic lease expiry from the manual clock sweep', () => {
    const clock = new ManualClock();
    const local = new Registry({ sweepIntervalMs: 100 }, clock);
    local.createSession({ id: 's', ttlMs: 100 });
    local.mutate('s', [{ type: 'put', key: 'k/1', data: {} }]);
    let expiredRevision = -1;
    local.on('sessionExpired', (event) => {
      expiredRevision = event.revision;
    });
    clock.advance(101); // the registry's own sweep timer fires inside advance()
    assert.equal(expiredRevision, 2);
    assert.equal(local.getSession('s'), null);
    assert.equal(local.list({ prefix: 'k/' }).instances.length, 0);
    local.close();
  });
});
