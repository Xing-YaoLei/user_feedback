export class StopError extends Error {
  constructor(message = '采集已停止') {
    super(message);
    this.name = 'StopError';
  }
}

export class RateLimitError extends Error {
  constructor(retryAfterMs, message = '接口触发限流') {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class CursorExpiredError extends Error {
  constructor(message = '游标已过期') {
    super(message);
    this.name = 'CursorExpiredError';
  }
}

export class PageRetryableError extends Error {
  constructor(message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'PageRetryableError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PageFatalError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'PageFatalError';
    this.status = status;
  }
}

const MIN_RETRY_MS = 100;
const MAX_RETRY_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function clampRetry(ms) {
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms));
}

function parseRetryAfter(headers, body, fallbackMs) {
  // The body's millisecond value is the most precise thing a supplier can give;
  // Retry-After is usually rounded up to whole seconds.
  if (body && typeof body === 'object') {
    for (const key of ['retryAfterMs', 'retry_after_ms']) {
      const ms = Number(body[key]);
      if (Number.isFinite(ms) && ms >= 0) return clampRetry(ms);
    }
  }
  const header = headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return clampRetry(seconds * 1000);
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) return clampRetry(dateMs - Date.now());
  }
  if (body && typeof body === 'object') {
    for (const key of ['retryAfter', 'retry_after']) {
      const seconds = Number(body[key]);
      if (Number.isFinite(seconds) && seconds >= 0) return clampRetry(seconds * 1000);
    }
  }
  return clampRetry(fallbackMs);
}

function isCursorExpired(status, body) {
  if (status === 410) return true;
  const code = String(body?.error ?? body?.code ?? '').toLowerCase();
  return code === 'cursor_expired' || code === 'snapshot_expired' || code === 'cursor_invalid';
}

async function readJson(response) {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new PageFatalError('接口返回内容过大', { status: response.status });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PageFatalError('接口返回的内容不是合法 JSON', { status: response.status });
  }
}

function normalizeProducts(products) {
  if (!Array.isArray(products)) throw new PageFatalError('接口返回的 products 不是数组');
  return products;
}

function normalizeNextCursor(value) {
  if (value == null || value === '') return null;
  return String(value);
}

/** Opens a fetch request with a timeout and an externally-abortable signal. */
async function fetchWithPolicy(url, { signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  let onExternalAbort = null;

  if (signal) {
    if (signal.aborted) throw signal.reason ?? new StopError();
    onExternalAbort = () => controller.abort(signal.reason ?? new StopError());
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new PageRetryableError(`接口请求超时（${timeoutMs} ms）`));
  }, timeoutMs);
  if (typeof timeout.unref === 'function') timeout.unref();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json' },
    });
    return response;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new StopError();
    if (timedOut) throw new PageRetryableError(`接口请求超时（${timeoutMs} ms）`);
    throw new PageRetryableError(`无法连接接口：${error.message}`);
  } finally {
    clearTimeout(timeout);
    if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Request one page of a supplier catalog.
 *
 * Contract: GET <url>?pageSize=N[&cursor=X]
 *   200 -> { snapshotId, products: [], nextCursor: string|null }
 *   429 -> rate limited (Retry-After / retryAfterMs honoured)
 *   410 or body.error === "cursor_expired" -> snapshot cursor no longer valid
 */
export async function requestPage({
  url,
  cursor = null,
  pageSize = 50,
  signal = null,
  timeoutMs = 20000,
}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new PageFatalError('接口地址不是有效的 URL');
  }
  target.searchParams.set('pageSize', String(pageSize));
  if (cursor) target.searchParams.set('cursor', String(cursor));

  const response = await fetchWithPolicy(target.toString(), { signal, timeoutMs });
  const status = response.status;

  let body = null;
  try {
    body = await readJson(response);
  } catch (error) {
    if (status === 429) {
      throw new RateLimitError(parseRetryAfter(response.headers, null, 5000));
    }
    if (status === 410) {
      throw new CursorExpiredError('游标所指向的快照已过期');
    }
    if (status >= 500) {
      throw new PageRetryableError(`接口返回 ${status}`, { status });
    }
    throw error;
  }

  if (status === 429) {
    throw new RateLimitError(
      parseRetryAfter(response.headers, body, 5000),
      String(body?.message ?? body?.error ?? '接口触发限流'),
    );
  }
  if (isCursorExpired(status, body)) {
    throw new CursorExpiredError(String(body?.message ?? '游标所指向的快照已过期'));
  }
  if (status >= 500 || status === 408 || status === 425) {
    throw new PageRetryableError(`接口暂时不可用（HTTP ${status}）`, {
      status,
      retryAfterMs: parseRetryAfter(response.headers, body, 3000),
    });
  }
  if (status >= 400) {
    throw new PageFatalError(
      `接口返回 ${status}：${String(body?.message ?? body?.error ?? '无法读取数据')}`,
      { status },
    );
  }
  if (status < 200 || status >= 300) {
    throw new PageFatalError(`接口返回了意外的状态码 ${status}`, { status });
  }
  if (!body || typeof body !== 'object') {
    throw new PageFatalError('接口返回的 JSON 不是对象');
  }
  if (body.ok === false) {
    throw new PageFatalError(String(body.message ?? '接口返回失败'), { status });
  }
  const snapshotId = body.snapshotId;
  if (snapshotId == null || String(snapshotId).trim() === '') {
    throw new PageFatalError('接口未返回快照编号 snapshotId');
  }
  // Both fields must be present: a missing nextCursor would otherwise look like
  // "catalog finished" and promote a truncated catalog, and a missing products
  // array would silently drop records.
  const hasProducts = Array.isArray(body.products) || Array.isArray(body.items);
  if (!hasProducts) {
    throw new PageFatalError('接口返回中缺少 products 数组');
  }
  const hasCursorKey = 'nextCursor' in body || 'next_cursor' in body;
  if (!hasCursorKey) {
    throw new PageFatalError('接口返回中缺少 nextCursor（末页必须显式返回 null）');
  }
  return {
    snapshotId: String(snapshotId),
    products: normalizeProducts(body.products ?? body.items ?? []),
    nextCursor: normalizeNextCursor(body.nextCursor ?? body.next_cursor ?? null),
    raw: body,
  };
}
