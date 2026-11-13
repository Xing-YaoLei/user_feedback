import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { Store } from '../src/store.js';
import { silentLogger, tempDir } from './helpers.js';

test('a corrupt state file is moved aside instead of blocking the collector', async (ctx) => {
  const tmp = await tempDir('catalog-corrupt-');
  ctx.after(tmp.cleanup);
  const store = new Store({ dataDir: tmp.dir, logger: silentLogger });
  await store.init();

  const supplierDir = path.join(tmp.dir, 'suppliers', 's1');
  await mkdir(supplierDir, { recursive: true });
  await writeFile(path.join(supplierDir, 'state.json'), '{ not json');

  const state = await store.loadSupplierState('s1');
  assert.equal(state.complete, null);
  assert.equal(state.pending, null);

  const files = await readdir(supplierDir);
  assert.ok(files.some((name) => name.startsWith('state.json.corrupt-')), 'the bad file is preserved');
});

test('a corrupt config file is replaced and reported as created', async (ctx) => {
  const tmp = await tempDir('catalog-corrupt-config-');
  ctx.after(tmp.cleanup);
  const seed = { version: 1, suppliers: [{ id: 'x', name: 'x', url: 'http://x' }] };

  await writeFile(path.join(tmp.dir, 'config.json'), '{ broken');

  const store = new Store({ dataDir: tmp.dir, logger: silentLogger });
  const { configCreated } = await store.init({ seedConfig: seed });
  assert.equal(configCreated, true, 'the caller can seed demo rows again');
  assert.equal(store.getConfig().suppliers.length, 1);
});
