import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { iso, isoDateKey, randomId, todayKey } from './util.js';

const SUPPLIER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function nowMs() {
  return Date.now();
}

async function readJson(file, fallback = null) {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      // A half-written or hand-edited file must not stop the whole collector:
      // move it aside so it can be inspected, and behave as if it were absent.
      const backup = `${file}.corrupt-${Date.now()}`;
      await rename(file, backup).catch(() => {});
      return fallback;
    }
    throw error;
  }
}

async function atomicWriteJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomId()}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

export function completeMeta(snapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    completedAt: snapshot.completedAt,
    startedAt: snapshot.startedAt ?? null,
    pageCount: snapshot.pageCount ?? snapshot.pages ?? null,
    productCount: Array.isArray(snapshot.products)
      ? snapshot.products.length
      : (snapshot.productCount ?? 0),
  };
}

export function pendingMeta(input, overrides = {}) {
  const attempt = input || {};
  const pagesFetched = attempt.pagesFetched ?? 0;
  const meta = {
    snapshotId: attempt.snapshotId ?? null,
    pagesFetched,
    productCount: Array.isArray(attempt.products) ? attempt.products.length : (attempt.productCount ?? 0),
    startedAt: attempt.startedAt ?? null,
    updatedAt: attempt.updatedAt ?? null,
    cursorPreview: attempt.cursor
      ? `${String(attempt.cursor).slice(0, 24)}${String(attempt.cursor).length > 24 ? '…' : ''}`
      : null,
    status: 'active',
    stopStep: `第 ${pagesFetched + 1} 页（采集中）`,
    stopReason: null,
    retryAt: null,
    rateLimitedUntil: null,
    failures: attempt.failures ?? 0,
    ...overrides,
  };
  return meta;
}

export function defaultState() {
  return {
    version: 1,
    nextRunAt: null,
    nextAllowedAt: 0,
    lastRunAt: null,
    lastCompletedDate: null,
    lastError: null,
    complete: null,
    pending: null,
    lastStop: null,
    events: [],
  };
}

export function appendEvent(state, type, message, at = nowMs(), limit = 60) {
  state.events = state.events || [];
  state.events.unshift({ at: iso(at), type, message });
  while (state.events.length > limit) state.events.pop();
  return state.events[0];
}

function metaFromPendingFile(file, overrides = {}) {
  return pendingMeta(file, {
    status: 'retrying',
    stopReason: '进程重启后待恢复',
    stopStep: `第 ${(file.pagesFetched ?? 0) + 1} 页（进程重启，待续采）`,
    retryAt: iso(nowMs()),
    ...overrides,
  });
}

export class Store {
  constructor({ dataDir, logger = console } = {}) {
    if (!dataDir) throw new Error('Store 需要 dataDir');
    this.dataDir = path.resolve(dataDir);
    this.logger = logger;
    this.configPath = path.join(this.dataDir, 'config.json');
    this.suppliersDir = path.join(this.dataDir, 'suppliers');
    this.config = null;
    this.states = new Map();
    this.writeChains = new Map();
  }

  supplierDir(id) {
    if (!SUPPLIER_ID_RE.test(String(id))) throw new Error(`非法供应商 id: ${id}`);
    return path.join(this.suppliersDir, String(id));
  }

  statePath(id) {
    return path.join(this.supplierDir(id), 'state.json');
  }

  pendingPath(id) {
    return path.join(this.supplierDir(id), 'pending.json');
  }

  completePath(id) {
    return path.join(this.supplierDir(id), 'complete.json');
  }

  _queueWrite(key, fn) {
    const previous = this.writeChains.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.writeChains.set(key, next);
    next.finally(() => {
      if (this.writeChains.get(key) === next) this.writeChains.delete(key);
    }).catch(() => {});
    return next;
  }

  _writeJson(file, data) {
    return this._queueWrite(file, () => atomicWriteJson(file, data));
  }

  async init({ seedConfig = null } = {}) {
    await mkdir(this.suppliersDir, { recursive: true });
    let configCreated = false;
    // readJson returns null (and moves the bad file aside) when the file is
    // missing or unparseable; either way the caller may seed a fresh config.
    const loaded = await readJson(this.configPath, null);
    if (!loaded || !Array.isArray(loaded.suppliers)) {
      this.config = { version: 1, suppliers: [] };
      await atomicWriteJson(this.configPath, seedConfig ?? this.config);
      configCreated = true;
    } else {
      this.config = loaded;
    }
    return { configCreated };
  }

  async reloadConfig() {
    this.config = await readJson(this.configPath, { version: 1, suppliers: [] });
    if (!Array.isArray(this.config.suppliers)) this.config.suppliers = [];
    return this.config;
  }

  getConfig() {
    return this.config;
  }

  async saveConfig(config) {
    this.config = structuredClone(config);
    await this._writeJson(this.configPath, this.config);
    return this.config;
  }

  async loadSupplierState(id, supplierConfig = null) {
    if (this.states.has(id)) return this.states.get(id);
    const state = await readJson(this.statePath(id), null);
    const result = { ...defaultState(), ...(state || {}) };
    result.events = Array.isArray(result.events) ? result.events : [];
    result.version = 1;

    // Reconcile files with the state index. This makes a restart recover a cursor
    // that was written before the process went down, and a promotion that happened
    // just before a crash.
    const pendingFile = await readJson(this.pendingPath(id), null);
    if (pendingFile && Array.isArray(pendingFile.products)) {
      if (!result.pending) {
        result.pending = metaFromPendingFile(pendingFile);
        result.nextRunAt = nowMs();
        appendEvent(result, 'warn', '检测到重启前未完成的快照，将从已保存的游标继续');
      } else if (result.pending.snapshotId !== pendingFile.snapshotId) {
        result.pending = metaFromPendingFile(pendingFile);
        result.nextRunAt = nowMs();
        appendEvent(result, 'warn', '状态索引与未完成快照缓存不一致，已按缓存恢复');
      } else {
        // Keep the pause status and wait window from the closed process; only
        // refresh the progress counters from the cache. A leftover "active"
        // status is fixed up below.
        result.pending.pagesFetched = pendingFile.pagesFetched ?? result.pending.pagesFetched;
        result.pending.productCount = pendingFile.products.length;
        result.pending.cursorPreview = pendingFile.cursor
          ? `${String(pendingFile.cursor).slice(0, 24)}${String(pendingFile.cursor).length > 24 ? '…' : ''}`
          : null;
      }
    } else if (result.pending) {
      // Without a product cache the cursor cannot be replayed. Metadata with no
      // pages fetched (a rate-limit wait or a paused first page) carries no
      // cursor, so it is safe to keep it visible until the retry time.
      const hadPages = (result.pending.pagesFetched ?? 0) > 0;
      if (hadPages) {
        result.pending = null;
        if (!result.nextRunAt || result.nextRunAt > nowMs()) result.nextRunAt = nowMs();
        appendEvent(result, 'warn', '未找到未完成快照的商品缓存，将重新取一份快照');
      }
    }

    // A process that died mid-page leaves status "active" behind; nothing is
    // running now, so present it as queued for resume instead of "采集中".
    if (result.pending && result.pending.status === 'active') {
      result.pending = {
        ...result.pending,
        status: 'retrying',
        stopReason: '进程重启后待恢复',
        retryAt: iso(nowMs()),
        stopStep: `第 ${(result.pending.pagesFetched ?? 0) + 1} 页（进程重启，待续采）`,
      };
    }

    const completeFile = await readJson(this.completePath(id), null);
    if (completeFile && completeFile.snapshotId && Array.isArray(completeFile.products)) {
      const meta = completeMeta(completeFile);
      if (!result.complete || result.complete.snapshotId !== meta.snapshotId) {
        result.complete = meta;
        result.lastCompletedDate = isoDateKey(meta.completedAt) || todayKey();
      }
    }

    // A crash may leave both files behind after a promotion. The pending cache
    // then belongs to the already-promoted snapshot and must be dropped.
    if (result.pending && result.complete && result.pending.snapshotId === result.complete.snapshotId) {
      result.pending = null;
      await rm(this.pendingPath(id), { force: true });
    }

    if (!result.lastCompletedDate && result.complete?.completedAt) {
      result.lastCompletedDate = isoDateKey(result.complete.completedAt);
    }

    this.states.set(id, result);
    return result;
  }

  async saveSupplierState(id, state) {
    this.states.set(id, state);
    await this._writeJson(this.statePath(id), state);
  }

  async readPending(id) {
    const file = await readJson(this.pendingPath(id), null);
    return file && Array.isArray(file.products) ? file : null;
  }

  async writePending(id, attempt) {
    await mkdir(this.supplierDir(id), { recursive: true });
    await this._writeJson(this.pendingPath(id), attempt);
  }

  async deletePending(id) {
    await rm(this.pendingPath(id), { force: true });
  }

  async readComplete(id) {
    const file = await readJson(this.completePath(id), null);
    return file && Array.isArray(file.products) ? file : null;
  }

  async writeComplete(id, snapshot) {
    await mkdir(this.supplierDir(id), { recursive: true });
    await this._writeJson(this.completePath(id), snapshot);
  }

  async deleteSupplierData(id) {
    this.states.delete(id);
    await rm(this.supplierDir(id), { recursive: true, force: true });
  }

  async listSupplierDirs() {
    try {
      return await readdir(this.suppliersDir);
    } catch {
      return [];
    }
  }

  async flush() {
    await Promise.allSettled([...this.writeChains.values()]);
  }
}
