import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { CursorExpiredError, PageFatalError, PageRetryableError, RateLimitError } from './http.js';
import { iso, sleep } from './util.js';

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(text) {
  try {
    const parsed = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.s || typeof parsed.o !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function hash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

const PRODUCT_FAMILIES = [
  ['叶菜类', '上海青', '菠菜', '生菜', '油麦菜', '小白菜'],
  ['根茎类', '胡萝卜', '白萝卜', '土豆', '山药', '莲藕'],
  ['瓜果类', '番茄', '黄瓜', '茄子', '青椒', '丝瓜'],
  ['菌菇类', '香菇', '平菇', '金针菇', '杏鲍菇', '口蘑'],
  ['豆制品', '北豆腐', '南豆腐', '豆干', '腐竹', '千张'],
  ['调味类', '生姜', '大蒜', '香葱', '香菜', '小米椒'],
];

const UNIT_POOL = ['kg', '箱', '袋', '件'];
const ORIGIN_POOL = ['山东寿光', '云南昆明', '河北张家口', '广东湛江', '本地直采'];

function makeProduct(sourceId, snapshotId, index) {
  const family = PRODUCT_FAMILIES[index % PRODUCT_FAMILIES.length];
  const familyName = family[0];
  const variety = family[1 + (Math.floor(index / PRODUCT_FAMILIES.length) % (family.length - 1))];
  const seed = Number.parseInt(hash(`${sourceId}:${snapshotId}:${index}`), 16);
  const unit = UNIT_POOL[seed % UNIT_POOL.length];
  const origin = ORIGIN_POOL[(seed >> 4) % ORIGIN_POOL.length];
  const price = Number((((seed % 900) + 180) / 100).toFixed(2));
  return {
    sku: `${sourceId.toUpperCase().slice(0, 3)}-${String(index + 1).padStart(4, '0')}`,
    name: `${familyName}·${variety}`,
    category: familyName,
    unit,
    price,
    origin,
    stock: 10 + (seed % 500),
    snapshotId,
  };
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

function parsePositiveInt(value, fallback, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

/**
 * Default demo sources start clean: every failure mode is injected on demand
 * from /debug (or through /admin/:source/:action), so a first run always
 * produces complete catalogs.
 */
export function defaultMockSources() {
  return [
    {
      id: 'fresh-mart',
      name: '鲜丰蔬果',
      totalProducts: 96,
      latencyMs: 120,
      cursorTtlMs: 60_000,
      rateLimit: { everyRequests: 0, retryAfterMs: 8_000 },
      interrupt: { failAfterPages: 0, status: 502 },
    },
    {
      id: 'river-garden',
      name: '江畔菜园',
      totalProducts: 48,
      latencyMs: 90,
      cursorTtlMs: 45_000,
      rateLimit: { everyRequests: 0, retryAfterMs: 5_000 },
      interrupt: { failAfterPages: 0, status: 502 },
    },
    {
      id: 'north-farm',
      name: '北岭农场',
      totalProducts: 144,
      latencyMs: 150,
      cursorTtlMs: 60_000,
      rateLimit: { everyRequests: 0, retryAfterMs: 5_000 },
      interrupt: { failAfterPages: 0, status: 502 },
    },
  ];
}

export async function loadMockSources(configPath) {
  if (!configPath) return defaultMockSources();
  const text = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(text);
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(sources)) throw new Error('模拟配置必须包含 sources 数组');
  return defaultMockSources().map((defaults) => {
    const found = sources.find((entry) => entry.id === defaults.id);
    return { ...defaults, ...(found || {}), rateLimit: { ...defaults.rateLimit, ...(found?.rateLimit || {}) }, interrupt: { ...defaults.interrupt, ...(found?.interrupt || {}) } };
  }).concat(
    sources.filter((entry) => !defaultMockSources().some((defaults) => defaults.id === entry.id)).map((entry) => ({
      id: entry.id,
      name: entry.name || entry.id,
      totalProducts: entry.totalProducts ?? 60,
      latencyMs: entry.latencyMs ?? 100,
      cursorTtlMs: entry.cursorTtlMs ?? 30_000,
      rateLimit: { everyRequests: 0, retryAfterMs: 8_000, ...(entry.rateLimit || {}) },
      interrupt: { failAfterPages: 0, status: 502, ...(entry.interrupt || {}) },
    })),
  );
}

/**
 * A local, deterministic supplier API used to exercise the collector.
 * Every source supports:
 *  - paged catalogs with snapshotId + nextCursor
 *  - forced/scheduled failures at a chosen page (pagination interruption)
 *  - 429 rate limits on a schedule (Retry-After)
 *  - cursor expiry (TTL and manual expiry)
 *  - snapshot rotation mid-pagination
 *  - manual controls via /admin/:source and /admin/status
 */
export class MockSupplierApi {
  constructor({ sources, logger = console, now = () => Date.now() } = {}) {
    this.now = now;
    this.logger = logger;
    this.sources = new Map();
    for (const source of sources ?? defaultMockSources()) {
      this.sources.set(source.id, this._initSource(source));
    }
    this.requests = [];
  }

  _initSource(source) {
    const clean = {
      id: source.id,
      name: source.name ?? source.id,
      totalProducts: parsePositiveInt(source.totalProducts, 60, 2000),
      latencyMs: Number.isFinite(source.latencyMs) ? Math.max(0, source.latencyMs) : 100,
      cursorTtlMs: parsePositiveInt(source.cursorTtlMs, 30_000, 86_400_000),
      rateLimit: {
        everyRequests: Math.max(0, Number(source.rateLimit?.everyRequests) || 0),
        retryAfterMs: parsePositiveInt(source.rateLimit?.retryAfterMs, 8_000, 3_600_000),
      },
      interrupt: {
        failAfterPages: Math.max(0, Number(source.interrupt?.failAfterPages) || 0),
        status: Number(source.interrupt?.status) || 502,
      },
      rotateEveryPages: Math.max(0, Number(source.rotateEveryPages ?? source.rotateEveryRequests) || 0),
    };
    return {
      config: clean,
      snapshotVersion: 1,
      requests: 0,
      servedPages: 0,
      pagesSinceRotation: 0,
      pagesSinceLimit: 0,
      currentRequest: null,
      interrupted: false,
      rateLimitUntil: 0,
      lastRequestAt: null,
    };
  }

  snapshotIdFor(source) {
    return `${source.id}-v${source.snapshotVersion}-${hash(`${source.id}:${source.snapshotVersion}`)}`;
  }

  _productsFor(source, snapshotId) {
    const items = [];
    for (let i = 0; i < source.config.totalProducts; i += 1) {
      items.push(makeProduct(source.id, snapshotId, i));
    }
    return items;
  }

  _record(entry) {
    this.requests.unshift(entry);
    if (this.requests.length > 200) this.requests.length = 200;
  }

  _rotate(source, reason = 'manual') {
    source.snapshotVersion += 1;
    source.servedPages = 0;
    source.pagesSinceRotation = 0;
    source.currentRequest = null;
    this._record({ at: iso(this.now()), source: source.config.id, type: 'rotate', message: `新快照 ${this.snapshotIdFor(source)}（${reason}）` });
    return this.snapshotIdFor(source);
  }

  /**
   * Core catalog logic, independent of the HTTP layer. Returns
   * { status, body, headers }. Used by the HTTP handler and by tests.
   */
  respondCatalog(sourceId, { pageSize: rawPageSize, cursor: cursorParam }) {
    const source = this.sources.get(sourceId);
    if (!source) {
      return { status: 404, body: { error: 'source_not_found', message: `模拟来源 ${sourceId} 不存在` } };
    }

    const pageSize = parsePositiveInt(rawPageSize, 50, 200);
    source.requests += 1;
    const requestIndex = source.requests;

    if (source.rateLimitUntil > this.now()) {
      const remaining = source.rateLimitUntil - this.now();
      this._record({ at: iso(this.now()), source: sourceId, type: 'rate_limited', message: `仍在限流，剩余 ${remaining}ms`, requestIndex });
      return {
        status: 429,
        body: { error: 'rate_limited', message: '请求过于频繁，请按 Retry-After 等待', retryAfterMs: remaining },
        headers: { 'retry-after': String(Math.max(1, Math.ceil(remaining / 1000))) },
      };
    }

    // Count *successful* pages, not every request: a caller that is already
    // waiting on a 429 must not be counted again, or the source would never
    // recover from a rate limit.
    const rateEvery = source.config.rateLimit.everyRequests;
    if (rateEvery > 0 && source.pagesSinceLimit >= rateEvery) {
      const waitMs = source.config.rateLimit.retryAfterMs;
      source.pagesSinceLimit = 0;
      source.rateLimitUntil = this.now() + waitMs;
      this._record({ at: iso(this.now()), source: sourceId, type: 'rate_limited', message: `触发限流，等待 ${waitMs}ms`, requestIndex });
      return {
        status: 429,
        body: { error: 'rate_limited', message: '请求过于频繁，请稍后重试', retryAfterMs: waitMs },
        headers: { 'retry-after': String(Math.max(1, Math.ceil(waitMs / 1000))) },
      };
    }

    if (source.interrupted) {
      this._record({ at: iso(this.now()), source: sourceId, type: 'interrupted', message: '故障注入中，请求被拒绝', requestIndex });
      return {
        status: source.config.interrupt.status,
        body: { error: 'upstream_unavailable', message: '模拟接口故障（分页中断），请等待恢复' },
      };
    }

    if (source.config.interrupt.failAfterPages > 0 && source.servedPages >= source.config.interrupt.failAfterPages) {
      source.interrupted = true;
      this._record({ at: iso(this.now()), source: sourceId, type: 'interrupted', message: `已服务 ${source.servedPages} 页后注入故障`, requestIndex });
      return {
        status: source.config.interrupt.status,
        body: { error: 'upstream_unavailable', message: '模拟接口故障（分页中断），请等待恢复' },
      };
    }

    // Rotate only between catalogs: a rotation while pages of the current
    // snapshot are still in flight is covered by the explicit "expire" action.
    if (source.config.rotateEveryPages > 0 && source.pagesSinceRotation >= source.config.rotateEveryPages && !cursorParam) {
      this._rotate(source, '按页数计划轮换');
    }

    const snapshotId = this.snapshotIdFor(source);
    let offset = 0;

    if (cursorParam) {
      const cursor = decodeCursor(cursorParam);
      const expired =
        !cursor ||
        cursor.s !== snapshotId ||
        (typeof cursor.e === 'number' && cursor.e < this.now());
      if (expired) {
        const reason = !cursor ? '游标格式无效' : cursor.s !== snapshotId ? '快照已轮换' : '游标已过期';
        this._record({ at: iso(this.now()), source: sourceId, type: 'cursor_expired', message: reason, requestIndex });
        return {
          status: 410,
          body: { error: 'cursor_expired', message: `游标已失效：${reason}，请从第一页重新取快照` },
        };
      }
      offset = cursor.o;
      if (offset >= source.config.totalProducts) {
        return { status: 410, body: { error: 'cursor_expired', message: '游标超出快照范围' } };
      }
    }

    const total = source.config.totalProducts;
    const end = Math.min(total, offset + pageSize);
    const products = this._productsFor(source, snapshotId).slice(offset, end);
    const nextCursor = end < total
      ? encodeCursor({ s: snapshotId, o: end, e: this.now() + source.config.cursorTtlMs })
      : null;

    source.servedPages += 1;
    source.pagesSinceLimit += 1;
    source.pagesSinceRotation += 1;
    source.lastRequestAt = iso(this.now());
    source.currentRequest = {
      pageSize,
      offset,
      end,
      cursor: cursorParam,
      nextCursor,
      at: iso(this.now()),
    };
    this._record({
      at: iso(this.now()),
      source: sourceId,
      type: 'page',
      message: `snapshot ${snapshotId} 第 ${Math.floor(offset / pageSize) + 1} 页（${offset}-${end}）`,
      requestIndex,
    });

    return {
      status: 200,
      body: {
        snapshotId,
        products,
        nextCursor,
        page: { offset, size: products.length, total },
      },
    };
  }

  async handleCatalog(sourceId, url, res) {
    const source = this.sources.get(sourceId);
    if (source && source.config.latencyMs > 0) await sleep(source.config.latencyMs);
    const result = this.respondCatalog(sourceId, {
      pageSize: url.searchParams.get('pageSize'),
      cursor: url.searchParams.get('cursor'),
    });
    sendJson(res, result.status, result.body, result.headers ?? {});
  }

  /** Fetch stand-in for the collector: same URL contract, no HTTP. */
  async fetchForTest({ url, cursor = null, pageSize = 50 }) {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'catalog' || !parts[1]) throw new Error(`模拟接口不支持该地址：${url}`);
    const source = this.sources.get(parts[1]);
    if (source && source.config.latencyMs > 0) await sleep(source.config.latencyMs);
    const result = this.respondCatalog(parts[1], {
      pageSize: parsed.searchParams.get('pageSize') ?? pageSize,
      cursor: parsed.searchParams.get('cursor') ?? cursor,
    });
    if (result.status === 429) {
      throw new RateLimitError(result.body.retryAfterMs, result.body.message);
    }
    if (result.status === 410) {
      throw new CursorExpiredError(result.body.message);
    }
    if (result.status >= 500) {
      throw new PageRetryableError(result.body.message, { status: result.status });
    }
    if (result.status >= 400) {
      throw new PageFatalError(result.body.message, { status: result.status });
    }
    return {
      snapshotId: result.body.snapshotId,
      products: result.body.products,
      nextCursor: result.body.nextCursor,
    };
  }

  adminState(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source) return null;
    return {
      id: source.config.id,
      name: source.config.name,
      snapshotId: this.snapshotIdFor(source),
      snapshotVersion: source.snapshotVersion,
      totalProducts: source.config.totalProducts,
      cursorTtlMs: source.config.cursorTtlMs,
      requests: source.requests,
      servedPages: source.servedPages,
      interrupted: source.interrupted,
      rateLimitUntil: source.rateLimitUntil > this.now() ? iso(source.rateLimitUntil) : null,
      rateLimit: source.config.rateLimit,
      interrupt: source.config.interrupt,
      rotateEveryPages: source.config.rotateEveryPages,
      lastRequestAt: source.lastRequestAt,
      currentRequest: source.currentRequest,
    };
  }

  adminAction(sourceId, action, payload = {}) {
    const source = this.sources.get(sourceId);
    if (!source) return { ok: false, status: 404, error: '模拟来源不存在' };
    switch (action) {
      case 'rotate':
        return { ok: true, snapshotId: this._rotate(source, '手动轮换') };
      case 'expire':
        // Rotating invalidates every outstanding cursor while keeping the source usable.
        return { ok: true, snapshotId: this._rotate(source, '手动令游标过期') };
      case 'interrupt': {
        const pages = Math.max(0, Number(payload.pages) || 0);
        if (pages === 0) {
          source.interrupted = true;
        } else {
          source.interrupted = false;
          source.config.interrupt.failAfterPages = source.servedPages + pages;
        }
        this._record({
          at: iso(this.now()),
          source: sourceId,
          type: 'interrupt_armed',
          message: pages === 0 ? '立即注入故障' : `再过 ${pages} 页注入故障`,
        });
        return { ok: true, failAfterPages: source.config.interrupt.failAfterPages, interrupted: source.interrupted };
      }
      case 'resume': {
        const wasInterrupted = source.interrupted;
        source.interrupted = false;
        source.config.interrupt.failAfterPages = 0;
        source.rateLimitUntil = 0;
        this._record({ at: iso(this.now()), source: sourceId, type: 'resume', message: '手动恢复接口' });
        return { ok: true, interrupted: false, wasInterrupted };
      }
      case 'rate-limit': {
        source.config.rateLimit.everyRequests = Math.max(1, Number(payload.everyRequests) || 1);
        source.config.rateLimit.retryAfterMs = Math.max(1, Number(payload.retryAfterMs) || 8_000);
        source.requests = 0;
        source.rateLimitUntil = 0;
        source.pagesSinceLimit = 0;
        this._record({ at: iso(this.now()), source: sourceId, type: 'rate_limit_config', message: `每 ${source.config.rateLimit.everyRequests} 页请求限流一次` });
        return { ok: true, rateLimit: source.config.rateLimit };
      }
      case 'no-rate-limit':
        source.config.rateLimit.everyRequests = 0;
        source.rateLimitUntil = 0;
        source.pagesSinceLimit = 0;
        return { ok: true, rateLimit: source.config.rateLimit };
      case 'reset':
        source.snapshotVersion = 1;
        source.requests = 0;
        source.servedPages = 0;
        source.pagesSinceRotation = 0;
        source.pagesSinceLimit = 0;
        source.currentRequest = null;
        source.interrupted = false;
        source.rateLimitUntil = 0;
        source.config.interrupt.failAfterPages = 0;
        source.config.rotateEveryPages = 0;
        source.config.rateLimit.everyRequests = 0;
        this.requests = this.requests.filter((entry) => entry.source !== sourceId);
        this._record({ at: iso(this.now()), source: sourceId, type: 'reset', message: '重置模拟来源' });
        return { ok: true };
      default:
        return { ok: false, status: 400, error: `未知操作 ${action}` };
    }
  }

  async readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return {};
    }
  }

  renderAdminPage() {
    const sources = [...this.sources.values()];
    const cards = sources
      .map((source) => {
        const state = this.adminState(source.config.id);
        const controls = [
          ['rotate', '轮换快照'],
          ['expire', '令游标过期'],
          ['interrupt', '立即中断'],
          ['resume', '恢复接口'],
          ['no-rate-limit', '关闭限流'],
          ['reset', '重置'],
        ]
          .map(([action, label]) => `<button data-source="${state.id}" data-action="${action}">${label}</button>`)
          .join('');
        return `<section class="card">
          <h2>${escapeHtml(state.name)} <code>${escapeHtml(state.id)}</code></h2>
          <p class="snap">当前快照 <code>${escapeHtml(state.snapshotId)}</code></p>
          <dl>
            <dt>商品数</dt><dd>${state.totalProducts}</dd>
            <dt>已发页数</dt><dd>${state.servedPages}</dd>
            <dt>请求数</dt><dd>${state.requests}</dd>
            <dt>游标有效期</dt><dd>${state.cursorTtlMs} ms</dd>
            <dt>故障注入</dt><dd>${state.interrupted ? '接口故障中' : state.interrupt.failAfterPages > 0 ? `服务满 ${state.interrupt.failAfterPages} 页后中断` : '关闭'}</dd>
            <dt>限流</dt><dd>${state.rateLimit.everyRequests ? `每 ${state.rateLimit.everyRequests} 次请求限流，等待 ${state.rateLimit.retryAfterMs}ms` : '关闭'}</dd>
            <dt>最近请求</dt><dd>${state.lastRequestAt ?? '—'}</dd>
          </dl>
          <div class="controls">${controls}</div>
          <div class="rate-form">
            <input type="number" min="1" max="100" value="${state.rateLimit.everyRequests || 3}" data-role="every" aria-label="每几次请求限流">
            <span>次请求后限流，等待</span>
            <input type="number" min="1" max="120" value="${Math.round(state.rateLimit.retryAfterMs / 1000)}" data-role="seconds" aria-label="等待秒数">
            <span>秒</span>
            <button data-source="${state.id}" data-action="rate-limit-form">应用限流</button>
          </div>
          <div class="rate-form">
            <span>再过</span>
            <input type="number" min="0" max="20" value="2" data-role="pages" aria-label="再过几页中断">
            <span>页后中断</span>
            <button data-source="${state.id}" data-action="interrupt-form">定时中断</button>
          </div>
        </section>`;
      })
      .join('');
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>模拟供货接口</title>
<style>
  :root{color-scheme:light dark;--bg:#f5f6f5;--panel:#fff;--ink:#1c2620;--muted:#66736c;--line:#dde3df;--accent:#2f6b4f;--warn:#a15c12}
  @media(prefers-color-scheme:dark){:root{--bg:#151a17;--panel:#1d2420;--ink:#eaf0ec;--muted:#9aa8a0;--line:#2b342f;--accent:#7fc49f}}
  body{margin:0;padding:24px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 20px}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  .card h2{font-size:16px;margin:0 0 8px}
  .snap code{font-size:12px;word-break:break-all}
  dl{display:grid;grid-template-columns:110px 1fr;gap:4px 12px;margin:12px 0;font-size:13px}
  dt{color:var(--muted)}
  .controls{display:flex;flex-wrap:wrap;gap:8px}
  button{font:inherit;font-size:13px;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
  button:hover{border-color:var(--accent);color:var(--accent)}
  .log{margin-top:24px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;max-height:320px;overflow:auto;font-size:12px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap}
  .rate-form{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px;font-size:12.5px;color:var(--muted)}
  .rate-form input{width:64px;font:inherit;font-size:12.5px;padding:4px 6px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit}
  .ok{color:var(--accent)}
</style></head>
<body>
  <h1>模拟供货接口</h1>
  <p class="sub">可手动重现分页中断、限流与游标过期，用于排查采集进度。</p>
  <div class="grid">${cards}</div>
  <div class="log" id="log">（操作日志）</div>
  <script>
    const log = document.getElementById('log');
    function render(event) { log.textContent = '[' + new Date().toLocaleTimeString() + '] ' + JSON.stringify(event) + '\\n' + log.textContent; }
    document.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', async () => {
        const { source, action } = button.dataset;
        const card = button.closest('.card');
        const numbers = {};
        card.querySelectorAll('input').forEach((input) => { numbers[input.dataset.role] = Number(input.value); });
        let payload = {};
        if (action === 'rate-limit-form') payload = { everyRequests: numbers.every, retryAfterMs: numbers.seconds * 1000 };
        if (action === 'interrupt-form') payload = { pages: numbers.pages };
        if (action === 'interrupt') payload = { pages: 0 };
        const endpoint = action === 'rate-limit-form' ? 'rate-limit'
          : action === 'interrupt-form' ? 'interrupt'
          : action;
        const res = await fetch('/admin/' + source + '/' + endpoint, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
        render({ source, action: endpoint, payload, status: res.status, body: await res.json().catch(() => null) });
        setTimeout(() => location.reload(), 600);
      });
    });
  </script>
</body></html>`;
  }

  createServer() {
    return createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
        const parts = url.pathname.split('/').filter(Boolean);

        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/debug')) {
          sendText(res, 200, this.renderAdminPage(), 'text/html; charset=utf-8');
          return;
        }

        if (parts[0] === 'catalog' && parts.length === 2 && req.method === 'GET') {
          await this.handleCatalog(parts[1], url, res);
          return;
        }

        if (parts[0] === 'admin' && parts[1] === 'status' && req.method === 'GET') {
          sendJson(res, 200, {
            now: iso(this.now()),
            sources: [...this.sources.keys()].map((id) => this.adminState(id)),
            requests: this.requests.slice(0, 60),
          });
          return;
        }

        if (parts[0] === 'admin' && parts.length >= 2 && parts.length <= 3) {
          if (req.method === 'GET' && parts.length === 2) {
            const state = this.adminState(parts[1]);
            if (!state) sendJson(res, 404, { error: 'not_found' });
            else sendJson(res, 200, state);
            return;
          }
          if (req.method === 'POST' && parts.length === 3) {
            const payload = await this.readBody(req);
            const result = this.adminAction(parts[1], parts[2], payload);
            sendJson(res, result.ok ? 200 : result.status ?? 400, result);
            return;
          }
        }

        sendJson(res, 404, { error: 'not_found', message: `没有路由 ${req.method} ${url.pathname}` });
      } catch (error) {
        this.logger.error('[mock] 请求处理失败', error);
        if (!res.headersSent) sendJson(res, 500, { error: 'mock_internal_error', message: error.message });
        else res.end();
      }
    });
  }
}

export async function startMockServer({
  port = 4110,
  host = '127.0.0.1',
  configPath = null,
  sources = null,
  logger = console,
} = {}) {
  const loaded = sources ?? (await loadMockSources(configPath));
  const api = new MockSupplierApi({ sources: loaded, logger });
  const server = api.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const baseUrl = `http://${host}:${typeof address === 'object' && address ? address.port : port}`;
  return {
    api,
    server,
    baseUrl,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

export function mockSupplierConfig(api, id) {
  const source = api.sources.get(id);
  if (!source) throw new Error(`模拟来源不存在：${id}`);
  return {
    id,
    name: source.config.name,
    url: `/catalog/${id}`,
    collectionTime: '07:30',
    requestsPerMinute: 60,
    pageSize: 24,
    enabled: true,
  };
}

export { encodeCursor, decodeCursor, makeProduct as buildMockProduct };

// Allow `node src/mock-server.js` to run the mock API stand-alone.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.MOCK_PORT || 4110);
  const started = await startMockServer({ port, configPath: process.env.MOCK_CONFIG || null });
  console.log(`模拟供货接口: ${started.baseUrl}`);
  console.log(`故障注入管理页: ${started.baseUrl}/debug`);
  const stop = async () => {
    await started.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
