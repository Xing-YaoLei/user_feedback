import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Collector } from '../src/engine.js';
import {
  CursorExpiredError,
  PageRetryableError,
  RateLimitError,
} from '../src/http.js';
import { Store } from '../src/store.js';
import { silentLogger, tempDir } from './helpers.js';

function productsFor(snapshotId, count, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    sku: `SKU-${offset + i + 1}`,
    name: `商品 ${offset + i + 1}`,
    snapshotId,
  }));
}

/**
 * Scriptable page fetcher: pages are keyed by snapshot and cursor offset so tests
 * can control failure exactly where they want it.
 */
function makeFakeSource({ snapshotId = 'snap-A', total = 5, pageSize = 2, id = 's1', url = 'http://fake/s1' } = {}) {
  const calls = [];
  let snapshot = snapshotId;
  let expiryOffset = null;
  let expireCount = 0;
  let rateLimitAt = null;
  const failAt = new Map();

  const fetchPage = async ({ cursor, pageSize: size }) => {
    const offset = cursor ? Number(cursor) : 0;
    calls.push({ cursor, snapshot });
    if (rateLimitAt != null && calls.length === rateLimitAt.at) {
      throw new RateLimitError(rateLimitAt.waitMs, '测试限流');
    }
    if (expireCount > 0 && offset >= expireCount) {
      throw new CursorExpiredError('测试游标过期');
    }
    const fail = [...failAt.entries()].find(([at, remaining]) => at === offset && remaining > 0);
    if (fail) {
      failAt.set(offset, fail[1] - 1);
      throw new PageRetryableError('测试分页中断');
    }
    const end = Math.min(total, offset + size);
    return {
      snapshotId: snapshot,
      products: productsFor(snapshot, end - offset, offset),
      nextCursor: end < total ? String(end) : null,
    };
  };

  return {
    supplier: {
      id,
      name: id,
      url,
      collectionTime: '07:30',
      requestsPerMinute: 600,
      pageSize,
      enabled: true,
    },
    calls,
    fetchPage,
    get snapshot() { return snapshot; },
    setSnapshot(next) { snapshot = next; },
    setExpiry(offset) { expiryOffset = offset; expireCount = offset == null ? 0 : 1; },
    clearExpiry() { expireCount = 0; expiryOffset = null; },
    rateLimitAt(index, waitMs) { rateLimitAt = { at: index, waitMs }; },
    clearRateLimit() { rateLimitAt = null; },
    failOnceAt(offset) { failAt.set(offset, 1); },
  };
}

async function makeStore(ctx) {
  const tmp = await tempDir();
  ctx.after(tmp.cleanup);
  const store = new Store({ dataDir: tmp.dir, logger: silentLogger });
  await store.init();
  return store;
}

async function makeCollector(store, source, ctx, overrides = {}) {
  const collector = new Collector({
    store,
    logger: silentLogger,
    fetchPage: source.fetchPage,
    ...overrides,
  });
  await collector.reloadConfig({ reason: 'config' });
  ctx.after(() => collector.stop());
  return collector;
}

test('collects every page of one snapshot and then promotes it atomically', async (ctx) => {
  const source = makeFakeSource({ total: 5, pageSize: 2 });
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = await makeCollector(store, source, ctx);

  assert.equal(await store.readComplete('s1'), null, 'nothing is published before the first page');
  await collector.collectOnce('s1');
  assert.equal(await store.readComplete('s1'), null, 'one page is not a complete snapshot');

  await collector.collectOnce('s1');
  await collector.collectOnce('s1');
  const complete = await store.readComplete('s1');
  assert.ok(complete, 'the last page promotes the snapshot');
  assert.equal(complete.snapshotId, 'snap-A');
  assert.equal(complete.products.length, 5);
  assert.equal(complete.pageCount, 3);
  assert.deepEqual(
    complete.products.map((product) => product.sku),
    ['SKU-1', 'SKU-2', 'SKU-3', 'SKU-4', 'SKU-5'],
  );

  const state = await store.loadSupplierState('s1', source.supplier);
  assert.equal(state.pending, null);
  assert.equal(state.complete.snapshotId, 'snap-A');
  assert.equal(await store.readPending('s1'), null);
});

test('keeps the previous snapshot while a new one is still being collected', async (ctx) => {
  const source = makeFakeSource({ total: 4, pageSize: 2 });
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = await makeCollector(store, source, ctx);

  await collector.collectOnce('s1');
  await collector.collectOnce('s1');
  const first = await store.readComplete('s1');
  assert.equal(first.snapshotId, 'snap-A');

  // A new snapshot begins, but only one page arrives.
  source.setSnapshot('snap-B');
  await collector.collectOnce('s1');
  const still = await store.readComplete('s1');
  assert.equal(still.snapshotId, 'snap-A', 'old catalog stays live');
  assert.equal(still.products.length, 4);

  const pending = await store.readPending('s1');
  assert.equal(pending.snapshotId, 'snap-B');
  assert.equal(pending.pagesFetched, 1);

  const described = await collector.describeSupplier(source.supplier);
  assert.equal(described.complete.snapshotId, 'snap-A');
  assert.equal(described.pending.snapshotId, 'snap-B');
  assert.ok(described.pending.stopStep.includes('第 2 页'));
});

test('a mid-pagination failure keeps the cursor and resumes from that page', async (ctx) => {
  const source = makeFakeSource({ total: 6, pageSize: 2 });
  source.failOnceAt(2);
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = await makeCollector(store, source, ctx);

  await collector.collectOnce('s1'); // page 1 ok
  await collector.collectOnce('s1'); // page 2 fails
  const state = await store.loadSupplierState('s1', source.supplier);
  assert.equal(state.pending.status, 'retrying');
  assert.equal(state.pending.pagesFetched, 1);
  assert.equal(state.pending.stopStep, '第 2 页（接口异常，2 秒后重试）');
  assert.ok(state.nextRunAt > Date.now());

  const pendingFile = await store.readPending('s1');
  assert.equal(pendingFile.cursor, '2', 'cursor of the failed page is preserved');

  // Next step resumes with the very same cursor and finishes the snapshot.
  await collector.collectOnce('s1');
  await collector.collectOnce('s1');
  const complete = await store.readComplete('s1');
  assert.equal(complete.products.length, 6);
  assert.deepEqual(source.calls.map((call) => call.cursor), [null, '2', '2', '4']);
});

test('a rate limit re-queues after the supplier-provided wait and leaves other suppliers alone', async (ctx) => {
  const sourceA = makeFakeSource({ total: 6, pageSize: 2, id: 'a', url: 'http://fake/a' });
  const sourceB = makeFakeSource({ total: 4, pageSize: 2, id: 'b', url: 'http://fake/b' });
  sourceA.rateLimitAt(2, 5_000);
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [sourceA.supplier, sourceB.supplier] });
  const collector = await makeCollector(store, sourceA, ctx);
  collector.fetchPage = async (request) => {
    if (request.url.endsWith('/a')) return sourceA.fetchPage(request);
    return sourceB.fetchPage(request);
  };

  await collector.collectOnce('a');
  await collector.collectOnce('a'); // 429
  const stateA = await store.loadSupplierState('a', sourceA.supplier);
  assert.equal(stateA.pending.status, 'rate_limited');
  assert.equal(stateA.rateLimitedUntil, stateA.nextRunAt);
  assert.ok(Math.abs(stateA.nextRunAt - Date.now() - 5_000) < 100, 'respects the supplier-provided wait');

  // Source B is not blocked and completes in the meantime.
  await collector.collectOnce('b');
  await collector.collectOnce('b');
  assert.equal((await store.readComplete('b')).products.length, 4);
  assert.equal(await store.readComplete('a'), null);

  // Source A returns to the queue after the wait (simulate the wait passing).
  stateA.rateLimitedUntil = 0;
  stateA.nextRunAt = 0;
  await store.saveSupplierState('a', stateA);
  await collector.collectOnce('a');
  await collector.collectOnce('a');
  assert.equal((await store.readComplete('a')).products.length, 6);
});

test('an expired cursor restarts the snapshot while the old catalog stays live', async (ctx) => {
  const source = makeFakeSource({ total: 4, pageSize: 2 });
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = await makeCollector(store, source, ctx);

  await collector.collectOnce('s1');
  await collector.collectOnce('s1');
  const first = await store.readComplete('s1');
  assert.equal(first.snapshotId, 'snap-A');

  // A new snapshot starts, page 1 is cached, then the cursor expires.
  source.setSnapshot('snap-B');
  await collector.collectOnce('s1');
  const pending = await store.readPending('s1');
  assert.equal(pending.snapshotId, 'snap-B');

  source.setExpiry(2);
  await collector.collectOnce('s1');

  const state = await store.loadSupplierState('s1', source.supplier);
  assert.equal(state.pending, null, 'expired attempt is discarded');
  assert.ok(state.lastStop.reason.includes('游标过期'));
  assert.equal(await store.readPending('s1'), null);
  assert.equal((await store.readComplete('s1')).snapshotId, 'snap-A', 'old catalog still shown');

  source.clearExpiry();
  await collector.collectOnce('s1'); // page 1 of a fresh snapshot
  await collector.collectOnce('s1');
  const complete = await store.readComplete('s1');
  assert.equal(complete.snapshotId, 'snap-B');
  assert.equal(complete.products.length, 4);
});

test('a snapshot change mid-pagination discards the partial attempt', async (ctx) => {
  const source = makeFakeSource({ total: 4, pageSize: 2 });
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = await makeCollector(store, source, ctx);

  await collector.collectOnce('s1'); // page 1 of snap-A
  source.setSnapshot('snap-B');
  await collector.collectOnce('s1'); // returns snap-B for cursor 2
  const state = await store.loadSupplierState('s1', source.supplier);
  assert.equal(state.pending, null);
  assert.ok(state.lastStop.reason.includes('快照发生变化'));
  assert.equal(await store.readPending('s1'), null);

  await collector.collectOnce('s1');
  await collector.collectOnce('s1');
  const complete = await store.readComplete('s1');
  assert.equal(complete.snapshotId, 'snap-B');
  assert.equal(complete.products.length, 4);
  assert.equal(complete.products.filter((p) => p.snapshotId === 'snap-A').length, 0);
});

test('restarting the process resumes from the persisted cursor', async (ctx) => {
  const source = makeFakeSource({ total: 6, pageSize: 2 });
  const tmp = await tempDir();
  ctx.after(tmp.cleanup);

  const store1 = new Store({ dataDir: tmp.dir, logger: silentLogger });
  await store1.init();
  await store1.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector1 = new Collector({ store: store1, logger: silentLogger, fetchPage: source.fetchPage });
  await collector1.reloadConfig({ reason: 'config' });
  await collector1.collectOnce('s1');
  await collector1.collectOnce('s1');
  await collector1.stop();

  // Brand-new process, same data directory. Recovery happens during state load.
  const store2 = new Store({ dataDir: tmp.dir, logger: silentLogger });
  await store2.init();
  const collector2 = new Collector({ store: store2, logger: silentLogger, fetchPage: source.fetchPage });

  const recovered = await store2.loadSupplierState('s1', source.supplier);
  assert.ok(recovered.pending, 'pending attempt is recovered at startup');
  assert.equal(recovered.pending.pagesFetched, 2);

  await collector2.collectOnce('s1');
  const complete = await store2.readComplete('s1');
  assert.equal(complete.products.length, 6);
  assert.deepEqual(source.calls.map((call) => call.cursor), [null, '2', '4']);
});

test('a stale pending file for an already-promoted snapshot is dropped on restart', async (ctx) => {
  const source = makeFakeSource({ total: 4, pageSize: 2 });
  const tmp = await tempDir();
  ctx.after(tmp.cleanup);
  const store = new Store({ dataDir: tmp.dir, logger: silentLogger });
  await store.init();
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = new Collector({ store, logger: silentLogger, fetchPage: source.fetchPage });
  await collector.reloadConfig({ reason: 'config' });
  await collector.collectOnce('s1');
  await collector.collectOnce('s1');
  await collector.stop();

  // Simulate a crash between "promote" and "delete pending" by re-creating the file.
  const complete = await store.readComplete('s1');
  await store.writePending('s1', {
    snapshotId: complete.snapshotId,
    products: complete.products,
    cursor: null,
    pagesFetched: complete.pageCount,
  });

  const store2 = new Store({ dataDir: tmp.dir, logger: silentLogger });
  await store2.init();
  const state = await store2.loadSupplierState('s1', source.supplier);
  assert.equal(state.pending, null);
  assert.equal(state.complete.snapshotId, complete.snapshotId);
});

test('never promotes pages from two different snapshots into one catalog', async (ctx) => {
  const source = makeFakeSource({ total: 6, pageSize: 2 });
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = await makeCollector(store, source, ctx);

  await collector.collectOnce('s1'); // snap-A page 1
  await collector.collectOnce('s1'); // snap-A page 2
  source.setSnapshot('snap-B');
  await collector.collectOnce('s1'); // mismatch -> discard
  source.setSnapshot('snap-B');
  await collector.collectOnce('s1'); // page 1
  await collector.collectOnce('s1'); // page 2
  await collector.collectOnce('s1'); // page 3 end

  const complete = await store.readComplete('s1');
  assert.equal(complete.snapshotId, 'snap-B');
  assert.equal(complete.products.length, 6);
  assert.ok(complete.products.every((product) => product.snapshotId === 'snap-B'));
});

test('config edits abandon an incompatible cursor instead of replaying it', async (ctx) => {
  const source = makeFakeSource({ total: 4, pageSize: 2 });
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [source.supplier] });
  const collector = await makeCollector(store, source, ctx);
  await collector.collectOnce('s1');

  const changed = { ...source.supplier, url: 'http://fake/other', pageSize: 1 };
  await store.saveConfig({ version: 1, suppliers: [changed] });
  await collector.reloadConfig({ reason: 'config' });

  const state = await store.loadSupplierState('s1', changed);
  assert.ok(state.pending, 'pending metadata kept for the dashboard');
  assert.equal(state.pending.snapshotId, null, 'the stale snapshot id is dropped');
  assert.equal(state.pending.pagesFetched, 0);
  assert.equal(state.pending.status, 'retrying', 'a non-active pause is visible, not stuck in "采集中"');
  assert.equal(await store.readPending('s1'), null, 'stale product cache removed');
  assert.ok(state.events.some((event) => event.message.includes('接口地址或分页大小已变更')));

  await collector.collectOnce('s1');
  assert.equal(source.calls.at(-1).cursor, null);
});

test('stalled cursor advancement stops instead of looping forever', async (ctx) => {
  const stuck = {
    supplier: {
      id: 's1', name: 's1', url: 'http://fake/s1', collectionTime: '07:30',
      requestsPerMinute: 600, pageSize: 2, enabled: true,
    },
    calls: [],
    fetchPage: async ({ cursor }) => {
      stuck.calls.push(cursor);
      return { snapshotId: 'snap-A', products: productsFor('snap-A', 2, 0), nextCursor: 'stuck' };
    },
  };
  const store = await makeStore(ctx);
  await store.saveConfig({ version: 1, suppliers: [stuck.supplier] });
  const collector = await makeCollector(store, stuck, ctx);

  await collector.collectOnce('s1');
  await collector.collectOnce('s1'); // cursor 'stuck' first time
  await collector.collectOnce('s1'); // same cursor returned again

  const state = await store.loadSupplierState('s1', stuck.supplier);
  assert.equal(state.pending.status, 'stopped');
  assert.ok(state.pending.stopReason.includes('相同的游标'));
  assert.equal(await store.readComplete('s1'), null);
});
