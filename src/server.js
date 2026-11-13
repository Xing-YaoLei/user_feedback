import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig, normalizeSupplier } from './config.js';
import { iso, todayKey } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求体过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.status = 400;
    throw error;
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError(400, '请求路径编码无效');
  }
}

/**
 * Dashboard + configuration API.
 * Deliberately plain: it only reads persisted snapshots and enqueues collection
 * work; it never blocks a request on a supplier API call.
 */
export class DashboardServer {
  constructor({ store, collector, logger = console, mockBaseUrl = null }) {
    this.store = store;
    this.collector = collector;
    this.logger = logger;
    this.mockBaseUrl = mockBaseUrl;
  }

  async overview() {
    const suppliers = this.store.getConfig().suppliers;
    const described = [];
    for (const supplier of suppliers) {
      described.push(await this.collector.describeSupplier(supplier));
    }
    return {
      now: iso(Date.now()),
      today: todayKey(),
      schedulerIntervalMs: this.collector.schedulerIntervalMs,
      suppliers: described,
      mockBaseUrl: this.mockBaseUrl,
      summary: {
        total: described.length,
        completeToday: described.filter((entry) => entry.completeToday).length,
        waiting: described.filter((entry) => ['waiting', 'never'].includes(entry.status)).length,
        active: described.filter((entry) => ['collecting', 'queued', 'rate_limited', 'retrying', 'waiting_retry', 'stopped'].includes(entry.status)).length,
      },
    };
  }

  async supplierDetail(id) {
    const supplier = this.store.getConfig().suppliers.find((entry) => entry.id === id);
    if (!supplier) throw httpError(404, '供应商不存在');
    const described = await this.collector.describeSupplier(supplier);
    const complete = await this.store.readComplete(id);
    const pendingFile = await this.store.readPending(id);
    let pending = described.pending;
    if (pending) {
      // Read counts from the product cache without shipping a second copy of it.
      pending = {
        ...pending,
        productCount: pendingFile?.products?.length ?? pending.productCount ?? 0,
        pagesFetched: pendingFile?.pagesFetched ?? pending.pagesFetched ?? 0,
      };
    }
    const completeSnapshot = complete
      ? {
          snapshotId: complete.snapshotId,
          startedAt: complete.startedAt ?? null,
          completedAt: complete.completedAt,
          pageCount: complete.pageCount,
          productCount: complete.productCount ?? complete.products.length,
        }
      : null;
    return {
      ...described,
      pending,
      completeProducts: complete?.products ?? [],
      pendingProducts: pendingFile?.products ?? [],
      completeSnapshot,
    };
  }

  async addSupplier(input) {
    const config = this.store.getConfig();
    const supplier = normalizeSupplier(input);
    if (config.suppliers.some((entry) => entry.id === supplier.id)) {
      throw httpError(409, '供应商标识已存在');
    }
    const next = normalizeConfig({ version: 1, suppliers: [...config.suppliers, supplier] });
    await this.store.saveConfig(next);
    await this.collector.reloadConfig({ reason: 'config' });
    return supplier;
  }

  async updateSupplier(id, input) {
    const config = this.store.getConfig();
    const index = config.suppliers.findIndex((entry) => entry.id === id);
    if (index === -1) throw httpError(404, '供应商不存在');
    const supplier = normalizeSupplier({ ...config.suppliers[index], ...input, id }, { id });
    const suppliers = config.suppliers.map((entry, i) => (i === index ? supplier : entry));
    await this.store.saveConfig(normalizeConfig({ version: 1, suppliers }));
    await this.collector.reloadConfig({ reason: 'config' });
    return supplier;
  }

  async removeSupplier(id) {
    const config = this.store.getConfig();
    const index = config.suppliers.findIndex((entry) => entry.id === id);
    if (index === -1) throw httpError(404, '供应商不存在');
    const suppliers = config.suppliers.filter((entry) => entry.id !== id);
    await this.store.saveConfig(normalizeConfig({ version: 1, suppliers }));
    await this.collector.cancel(id);
    await this.collector.reloadConfig({ reason: 'config' });
    await this.store.deleteSupplierData(id);
  }

  async replaceConfig(input) {
    const previous = this.store.getConfig();
    const config = normalizeConfig(input);
    await this.store.saveConfig(config);
    const removed = previous.suppliers.filter(
      (entry) => !config.suppliers.some((next) => next.id === entry.id),
    );
    for (const entry of removed) {
      await this.collector.cancel(entry.id);
      await this.store.deleteSupplierData(entry.id);
    }
    await this.collector.reloadConfig({ reason: 'config' });
    return config;
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts[0] === 'api') {
        if (parts[1] === 'overview' && req.method === 'GET') {
          sendJson(res, 200, await this.overview());
          return;
        }
        if (parts[1] === 'config' && req.method === 'GET') {
          sendJson(res, 200, this.store.getConfig());
          return;
        }
        if (parts[1] === 'config' && req.method === 'PUT') {
          const body = await readBody(req);
          sendJson(res, 200, await this.replaceConfig(body));
          return;
        }
        if (parts[1] === 'suppliers' && parts.length === 2 && req.method === 'POST') {
          const body = await readBody(req);
          sendJson(res, 201, await this.addSupplier(body));
          return;
        }
        if (parts[1] === 'suppliers' && parts.length >= 3) {
          const id = decodeURIComponentSafe(parts[2]);
          if (parts.length === 3 && req.method === 'GET') {
            sendJson(res, 200, await this.supplierDetail(id));
            return;
          }
          if (parts.length === 3 && req.method === 'PATCH') {
            const body = await readBody(req);
            sendJson(res, 200, await this.updateSupplier(id, body));
            return;
          }
          if (parts.length === 3 && req.method === 'DELETE') {
            await this.removeSupplier(id);
            sendJson(res, 200, { ok: true });
            return;
          }
          if (parts[3] === 'collect' && req.method === 'POST') {
            const state = await this.collector.trigger(id);
            sendJson(res, 202, { ok: true, nextRunAt: state?.nextRunAt ?? null });
            return;
          }
          if (parts[3] === 'products' && req.method === 'GET') {
            const complete = await this.store.readComplete(id);
            const search = (url.searchParams.get('q') ?? '').trim().toLowerCase();
            const products = (complete?.products ?? []).filter((product) => {
              if (!search) return true;
              return [product.name, product.sku, product.category, product.origin]
                .filter(Boolean)
                .some((field) => String(field).toLowerCase().includes(search));
            });
            sendJson(res, 200, {
              snapshotId: complete?.snapshotId ?? null,
              completedAt: complete?.completedAt ?? null,
              total: complete?.products?.length ?? 0,
              count: products.length,
              products,
            });
            return;
          }
        }
        if (parts[1] === 'collect-all' && req.method === 'POST') {
          const states = await this.collector.triggerAll();
          sendJson(res, 202, { ok: true, queued: states.length });
          return;
        }
        if (parts[1] === 'health' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, now: iso(Date.now()), uptimeSec: Math.round(process.uptime()) });
          return;
        }
        sendJson(res, 404, { error: 'not_found', message: `没有路由 ${req.method} ${url.pathname}` });
        return;
      }

      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const relative = url.pathname === '/' ? '/index.html' : decodeURIComponentSafe(url.pathname);
      const file = path.resolve(webDir, `.${relative}`);
      if (file !== webDir && !file.startsWith(`${webDir}${path.sep}`)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        res.end(body);
      } catch (error) {
        if (error.code === 'ENOENT') {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        throw error;
      }
    } catch (error) {
      const status = error.status ?? 400;
      if (status >= 500) this.logger.error('[dashboard] 请求处理失败', error);
      sendJson(res, status, { error: error.code ?? 'bad_request', message: error.message });
    }
  }

  createServer() {
    return createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.error('[dashboard] 未捕获异常', error);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: error.message });
        else res.end();
      });
    });
  }

  async listen({ host = '127.0.0.1', port = 4100 } = {}) {
    const server = this.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    return {
      server,
      url: `http://${host}:${actualPort}`,
      close: () => new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
    };
  }
}
