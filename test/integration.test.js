import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Collector } from '../src/engine.js';
import { MockSupplierApi, mockSupplierConfig } from '../src/mock-server.js';
import { Store } from '../src/store.js';
import { silentLogger, tempDir } from './helpers.js';

const BASE = {
  totalProducts: 5,
  latencyMs: 0,
  cursorTtlMs: 60_000,
  rateLimit: { everyRequests: 0, retryAfterMs: 400 },
  interrupt: { failAfterPages: 0, status: 502 },
};

/**
 * Integration tests drive the collector one page at a time with collectOnce.
 * The ticker is intentionally not started so the tests do not race the
 * scheduler; what is exercised is the same step machine the scheduler uses.
 */
async function setup(ctx, sources, collectorOptions = {}) {
  const tmp = await tempDir('catalog-int-');
  ctx.after(tmp.cleanup);
  const api = new MockSupplierApi({ sources, logger: silentLogger });
  const store = new Store({ dataDir: tmp.dir, logger: silentLogger });
  await store.init();
  await store.saveConfig({
    version: 1,
    suppliers: sources.map((source) => ({
      ...mockSupplierConfig(api, source.id),
      url: `http://mock.local/catalog/${source.id}`,
      requestsPerMinute: 6000,
      pageSize: 2,
    })),
  });
  const collector = new Collector({
    store,
    logger: silentLogger,
    fetchPage: (request) => api.fetchForTest(request),
    baseRetryMs: 100,
    maxRetryMs: 200,
    cursorExpiredRestartMs: 50,
    ...collectorOptions,
  });
  await collector.reloadConfig({ reason: 'config' });
  ctx.after(() => collector.stop());
  return { api, store, collector };
}

async function step(collector, id, times = 1) {
  for (let i = 0; i < times; i += 1) await collector.collectOnce(id);
}

test('integration: mock API paginates into one complete snapshot', async (ctx) => {
  const { api, store, collector } = await setup(ctx, [{ id: 'demo', name: '演示', ...BASE }]);
  await step(collector, 'demo', 3);

  const complete = await store.readComplete('demo');
  assert.ok(complete);
  assert.equal(complete.products.length, 5);
  assert.equal(complete.pageCount, 3);
  assert.ok(complete.products.every((product) => product.snapshotId === complete.snapshotId));
  assert.equal(api.adminState('demo').servedPages, 3);
  assert.equal(await store.readPending('demo'), null);

  const described = await collector.describeSupplier(store.getConfig().suppliers[0]);
  assert.equal(described.status, 'complete');
  assert.equal(described.completeToday, true);
  assert.equal(described.pending, null);
});

test('integration: injected pagination interruption keeps the old catalog and resumes', async (ctx) => {
  const { api, store, collector } = await setup(ctx, [{ id: 'demo', name: '演示', ...BASE }]);

  // First, one clean snapshot exists.
  await step(collector, 'demo', 3);
  const first = await store.readComplete('demo');
  assert.equal(first.products.length, 5);

  // A new snapshot is started and interrupted before its second page arrives.
  api.adminAction('demo', 'rotate');
  await step(collector, 'demo');
  const pending = await store.readPending('demo');
  assert.notEqual(pending.snapshotId, first.snapshotId);
  assert.equal(pending.pagesFetched, 1);

  api.adminAction('demo', 'interrupt', { pages: 0 });
  await step(collector, 'demo');

  const state = await store.loadSupplierState('demo');
  assert.equal(state.pending.status, 'retrying');
  assert.equal(state.pending.pagesFetched, 1);
  assert.ok(state.pending.stopStep.includes('第 2 页'));
  assert.equal((await store.readComplete('demo')).snapshotId, first.snapshotId, 'old catalog still live');
  assert.equal((await store.readPending('demo')).cursor, pending.cursor, 'cursor preserved');

  api.adminAction('demo', 'resume');
  await step(collector, 'demo', 2);
  const complete = await store.readComplete('demo');
  assert.notEqual(complete.snapshotId, first.snapshotId);
  assert.equal(complete.products.length, 5);
  assert.ok(complete.products.every((product) => product.snapshotId === complete.snapshotId));
});

test('integration: rate limit from the mock API is honoured and retried', async (ctx) => {
  const { api, store, collector } = await setup(ctx, [{ id: 'demo', name: '演示', ...BASE }]);
  api.adminAction('demo', 'rate-limit', { everyRequests: 1, retryAfterMs: 400 });

  await step(collector, 'demo'); // page 1 is served
  await step(collector, 'demo'); // the next request is rate limited
  const state = await store.loadSupplierState('demo');
  assert.equal(state.pending.status, 'rate_limited');
  assert.equal(state.pending.pagesFetched, 1, 'the served page is kept');
  assert.ok(Math.abs(state.nextRunAt - Date.now() - 400) < 150, 'waits exactly the supplier-provided time');
  assert.ok(state.pending.stopStep.startsWith('第 2 页'));
  assert.equal(await store.readComplete('demo'), null);

  api.adminAction('demo', 'no-rate-limit');
  state.rateLimitedUntil = 0;
  state.nextRunAt = Date.now();
  await store.saveSupplierState('demo', state);
  await step(collector, 'demo', 2);

  const complete = await store.readComplete('demo');
  assert.equal(complete.products.length, 5);
  assert.equal(complete.pageCount, 3);
});

test('integration: expired cursor restarts the snapshot and keeps the old catalog', async (ctx) => {
  const { api, store, collector } = await setup(ctx, [{ id: 'demo', name: '演示', ...BASE }]);
  await step(collector, 'demo', 3); // 5 products, 2 per page -> 3 pages
  const first = await store.readComplete('demo');
  assert.ok(first);

  // New snapshot half-collected, then invalidated by the supplier.
  api.adminAction('demo', 'rotate');
  await step(collector, 'demo');
  const pending = await store.readPending('demo');
  assert.notEqual(pending.snapshotId, first.snapshotId);

  api.adminAction('demo', 'expire');
  await step(collector, 'demo');

  const state = await store.loadSupplierState('demo');
  assert.equal(state.pending, null, 'invalid attempt is discarded');
  assert.ok(state.lastStop.reason.includes('游标过期'));
  assert.equal(await store.readPending('demo'), null);
  assert.equal((await store.readComplete('demo')).snapshotId, first.snapshotId, 'old catalog preserved');

  await step(collector, 'demo', 3);
  const complete = await store.readComplete('demo');
  assert.notEqual(complete.snapshotId, first.snapshotId);
  assert.equal(complete.products.length, 5);
});

test('integration: a restored snapshot never mixes products from two snapshots', async (ctx) => {
  const { api, store, collector } = await setup(ctx, [{ id: 'demo', name: '演示', ...BASE }], {
    // No pause between the discarded attempt and the fresh one, so the same
    // rotate-before-cursor request can be exercised deterministically.
    cursorExpiredRestartMs: 0,
  });

  await step(collector, 'demo'); // snap-X page 1
  api.adminAction('demo', 'rotate'); // cursor for snap-X now points at snap-Y
  await step(collector, 'demo'); // 410 -> discarded

  let state = await store.loadSupplierState('demo');
  assert.equal(state.pending, null);
  assert.ok(state.lastStop.reason.includes('游标过期'));

  // The next page 1 starts snap-Y; its second page must also come from snap-Y.
  await step(collector, 'demo');
  const pending = await store.readPending('demo');
  assert.equal(pending.snapshotId, api.adminState('demo').snapshotId);
  await step(collector, 'demo', 2);

  const complete = await store.readComplete('demo');
  assert.equal(complete.products.length, 5);
  assert.ok(complete.products.every((product) => product.snapshotId === complete.snapshotId));
});

test('integration: one rate-limited supplier does not block another', async (ctx) => {
  const { api, store, collector } = await setup(ctx, [
    { id: 'slow', name: '慢来源', ...BASE },
    { id: 'fast', name: '快来源', ...BASE, totalProducts: 4 },
  ]);
  api.adminAction('slow', 'rate-limit', { everyRequests: 1, retryAfterMs: 20_000 });

  await step(collector, 'slow'); // page 1
  await step(collector, 'slow'); // 429
  await step(collector, 'fast', 2);

  const fast = await store.readComplete('fast');
  assert.equal(fast.products.length, 4);
  const slowState = await store.loadSupplierState('slow');
  assert.equal(slowState.pending.status, 'rate_limited');
  assert.equal(await store.readComplete('slow'), null);
});

test('integration: manual interrupt with pages>0 stops mid-pagination', async (ctx) => {
  const { api, store, collector } = await setup(ctx, [{ id: 'demo', name: '演示', ...BASE, totalProducts: 8 }]);
  await step(collector, 'demo');
  api.adminAction('demo', 'interrupt', { pages: 1 });

  await step(collector, 'demo'); // one more page is allowed
  await step(collector, 'demo'); // now the source fails

  const state = await store.loadSupplierState('demo');
  assert.equal(state.pending.status, 'retrying');
  assert.ok(state.pending.stopReason.includes('接口异常'));
  assert.ok(state.pending.failures > 0);
  assert.equal((await store.readPending('demo')).pagesFetched, 2, 'two pages were kept');
});
