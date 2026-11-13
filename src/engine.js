import {
  CursorExpiredError,
  PageFatalError,
  PageRetryableError,
  RateLimitError,
  StopError,
  requestPage,
} from './http.js';
import { appendEvent, completeMeta, pendingMeta } from './store.js';
import { iso, nextDailyTomorrow, parseMs, todayKey } from './util.js';

const RATE_SAFETY_MS = 30;

function sourceKeyOf(supplier) {
  return `${supplier.url}|${supplier.pageSize}`;
}

function pageIntervalMs(supplier) {
  return Math.ceil(60_000 / Math.max(1, supplier.requestsPerMinute));
}

function atTime(dayMs, collectionTime) {
  const [hour, minute] = String(collectionTime).split(':').map(Number);
  const d = new Date(dayMs);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function stopStepText(pending) {
  if (!pending) return '尚未开始';
  if (pending.status === 'rate_limited') {
    return `第 ${pending.pagesFetched + 1} 页（接口限流，等待重试）`;
  }
  if (pending.status === 'retrying') {
    return `第 ${pending.pagesFetched + 1} 页（接口异常，等待重试）`;
  }
  if (pending.status === 'stopped') {
    return `第 ${pending.pagesFetched + 1} 页（采集已暂停）`;
  }
  return `第 ${pending.pagesFetched + 1} 页（采集中）`;
}

export class Collector {
  constructor({
    store,
    logger = console,
    now = () => Date.now(),
    fetchPage = requestPage,
    schedulerIntervalMs = 400,
    timeoutMs = 20_000,
    cursorExpiredRestartMs = 750,
    baseRetryMs = 2_000,
    maxRetryMs = 5 * 60_000,
    fatalRetryMs = 10 * 60_000,
    fatalMaxFailures = 3,
  }) {
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.fetchPage = fetchPage;
    this.schedulerIntervalMs = schedulerIntervalMs;
    this.timeoutMs = timeoutMs;
    this.cursorExpiredRestartMs = cursorExpiredRestartMs;
    this.baseRetryMs = baseRetryMs;
    this.maxRetryMs = maxRetryMs;
    this.fatalRetryMs = fatalRetryMs;
    this.fatalMaxFailures = fatalMaxFailures;

    this.activeRuns = new Map();
    this.controllers = new Map();
    this.stepChains = new Map();
    this.initialized = new Set();
    this.timer = null;
    this.ticking = false;
    this.tickQueued = false;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    await this.evaluateAllSchedules({ reason: 'startup' });
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error('[collector] tick 失败', error));
    }, this.schedulerIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) {
      controller.abort(new StopError('采集器正在停止'));
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    this.controllers.clear();
    await this.store.flush();
  }

  /** Recompute schedules after the config was edited. */
  async reloadConfig({ reason = 'config' } = {}) {
    return this.evaluateAllSchedules({ reason });
  }

  async evaluateAllSchedules({ reason = 'startup' } = {}) {
    const config = this.store.getConfig();
    const nowMs = this.now();
    for (const supplier of config.suppliers) {
      await this._evaluateSchedule(supplier, { nowMs, reason });
    }
  }

  async _evaluateSchedule(supplier, { nowMs, reason, force = false } = {}) {
    const state = await this.store.loadSupplierState(supplier.id, supplier);
    const key = sourceKeyOf(supplier);
    const configChanged = state.sourceKey && state.sourceKey !== key;
    const scheduleChanged = state.collectionTime && state.collectionTime !== supplier.collectionTime;
    const enabledChanged = typeof state.enabledAt === 'boolean' && state.enabledAt !== supplier.enabled;
    const firstSeen = !this.initialized.has(supplier.id) || force;

    if (configChanged && state.pending) {
      // A cursor points into the old endpoint's snapshot and can never be reused.
      await this.store.deletePending(supplier.id);
      state.pending = {
        ...state.pending,
        snapshotId: null,
        pagesFetched: 0,
        productCount: 0,
        cursorPreview: null,
        stopStep: '第 1 页（接口已变更，等待重新取快照）',
        stopReason: '接口地址或分页大小已变更，旧游标已作废',
        retryAt: null,
        status: 'retrying',
        failures: 0,
      };
      state.rateLimitedUntil = null;
      state.nextRunAt = nowMs;
      appendEvent(state, 'warn', '接口地址或分页大小已变更，已放弃旧游标，将重新取快照');
    }
    state.sourceKey = key;
    state.collectionTime = supplier.collectionTime;
    state.enabledAt = supplier.enabled;
    this.initialized.add(supplier.id);

    if (firstSeen || configChanged || scheduleChanged || enabledChanged) {
      if (state.pending) {
        // Resume a partial catalog before the daily schedule matters. Waits the
        // supplier asked for (rate limit, fatal backoff) survive a restart.
        const paused = ['rate_limited', 'stopped', 'retrying'].includes(state.pending.status);
        state.nextRunAt = paused
          ? Math.max(nowMs, parseMs(state.pending.retryAt, 0))
          : nowMs;
        if (reason === 'startup') {
          appendEvent(state, 'info', '进程重启：发现未完成快照，将从已保存的游标继续或重新取快照');
        }
      } else if (state.lastCompletedDate === todayKey(nowMs)) {
        // Already done today — even if that happened before the scheduled time
        // (manual pull), the next automatic run belongs to tomorrow.
        state.nextRunAt = nextDailyTomorrow(supplier.collectionTime, nowMs);
      } else if (!state.complete) {
        // Nothing has ever been collected: waiting for tomorrow's slot would
        // leave the buyer with an empty page, so collect now.
        state.nextRunAt = nowMs;
      } else {
        state.nextRunAt = Math.max(nowMs, atTime(nowMs, supplier.collectionTime));
        if (reason === 'startup' && nowMs >= atTime(nowMs, supplier.collectionTime)) {
          appendEvent(state, 'info', '进程启动时已过采集时间，立即开始今日采集');
        }
      }
    }

    await this.store.saveSupplierState(supplier.id, state);
    return state;
  }

  earliestNextRun(state, supplier, nowMs) {
    let next = Math.max(nowMs, parseMs(state.nextRunAt, nowMs));
    if (state.rateLimitedUntil) next = Math.max(next, parseMs(state.rateLimitedUntil, 0));
    const lastRequest = parseMs(state.lastRequestAt, 0);
    if (lastRequest) next = Math.max(next, lastRequest + pageIntervalMs(supplier) + RATE_SAFETY_MS);
    return next;
  }

  async tick() {
    if (this.stopped) return;
    if (this.ticking) {
      this.tickQueued = true;
      return;
    }
    this.ticking = true;
    try {
      const config = this.store.getConfig();
      const nowMs = this.now();
      for (const supplier of config.suppliers) {
        if (!supplier.enabled) continue;
        if (this.activeRuns.has(supplier.id)) continue;
        let state;
        try {
          state = await this.store.loadSupplierState(supplier.id, supplier);
        } catch (error) {
          this.logger.error(`[collector] 读取 ${supplier.id} 状态失败`, error);
          continue;
        }
        if (!state.sourceKey) {
          await this._evaluateSchedule(supplier, { nowMs, reason: 'config' });
          state = this.store.states.get(supplier.id);
        }
        if (this.earliestNextRun(state, supplier, nowMs) > nowMs) continue;
        this._startRun(supplier);
      }
    } finally {
      this.ticking = false;
      if (this.tickQueued) {
        this.tickQueued = false;
        queueMicrotask(() => this.tick().catch((error) => this.logger.error('[collector] tick 失败', error)));
      }
    }
  }

  _startRun(supplier) {
    const controller = new AbortController();
    this.controllers.set(supplier.id, controller);
    const promise = this._serializeStep(supplier.id, () =>
      this._runStep(supplier, controller.signal).catch((error) => {
        if (!(error instanceof StopError)) {
          this.logger.error(`[collector] ${supplier.name} 采集异常`, error);
        }
      }).finally(() => {
        if (this.controllers.get(supplier.id) === controller) this.controllers.delete(supplier.id);
      }));
    promise.finally(() => {
      if (this.activeRuns.get(supplier.id) === promise) this.activeRuns.delete(supplier.id);
    }).catch(() => {});
    this.activeRuns.set(supplier.id, promise);
  }

  /** Force a supplier to collect now (used by the dashboard's 立即采集 button). */
  async trigger(id) {
    const config = this.store.getConfig();
    const supplier = config.suppliers.find((entry) => entry.id === id);
    if (!supplier) throw new Error('供应商不存在');
    const state = await this.store.loadSupplierState(id, supplier);
    state.nextRunAt = this.now();
    state.manualTriggerAt = this.now();
    if (state.pending?.status === 'stopped') {
      state.pending.status = 'retrying';
      state.pending.failures = 0;
      state.pending.retryAt = null;
      state.pending.stopReason = null;
      state.pending.stopStep = `第 ${(state.pending.pagesFetched ?? 0) + 1} 页（手动恢复，等待采集）`;
    }
    appendEvent(state, 'info', '手动触发采集');
    await this.store.saveSupplierState(id, state);
    return state;
  }

  async triggerAll() {
    const results = [];
    for (const supplier of this.store.getConfig().suppliers) {
      if (!supplier.enabled) continue;
      results.push(await this.trigger(supplier.id));
    }
    return results;
  }

  /** If a supplier is removed or disabled, abandon its in-flight step. */
  async cancel(id) {
    const controller = this.controllers.get(id);
    if (controller) controller.abort(new StopError('该来源已被移除'));
    const pendingRun = this.stepChains.get(id);
    if (pendingRun) await pendingRun.catch(() => {});
  }

  /** A supplier may be removed mid-request; never write its data afterwards. */
  _isConfigured(id) {
    return this.store.getConfig().suppliers.some((entry) => entry.id === id);
  }

  /** Run exactly one collection step (one page request) for a supplier. */
  async collectOnce(id, { signal = null } = {}) {
    const supplier = this.store.getConfig().suppliers.find((entry) => entry.id === id);
    if (!supplier) throw new Error('供应商不存在');
    await this._serializeStep(id, () => this._runStep(supplier, signal ?? new AbortController().signal));
    return this.store.loadSupplierState(id, supplier);
  }

  /** Serialise steps per supplier so a manual trigger cannot interleave pages. */
  _serializeStep(id, task) {
    const previous = this.stepChains.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.stepChains.set(id, run);
    run.finally(() => {
      if (this.stepChains.get(id) === run) this.stepChains.delete(id);
    }).catch(() => {});
    return run;
  }

  _backoffMs(failures) {
    return Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** Math.max(0, failures - 1));
  }

  async _persistPendingFile(id, attempt) {
    if (!attempt) return;
    attempt.updatedAt = iso(this.now());
    await this.store.writePending(id, attempt);
  }

  async _markStopped(id, state, attempt, { status, reason, nextRunAt, failures, extra = {} }) {
    state.pending = pendingMeta(attempt, {
      status,
      stopReason: reason,
      stopStep: stopStepText({ ...(attempt || {}), status, pagesFetched: attempt?.pagesFetched ?? 0 }),
      retryAt: nextRunAt ? iso(nextRunAt) : null,
      rateLimitedUntil: extra.rateLimitedUntil ?? state.pending?.rateLimitedUntil ?? null,
      failures,
      ...extra.pending,
    });
    state.nextRunAt = nextRunAt;
    state.lastRunAt = iso(this.now());
    if (attempt) await this._persistPendingFile(id, attempt);
    await this.store.saveSupplierState(id, state);
  }

  async _runStep(supplier, signal) {
    const id = supplier.id;
    const nowMs = this.now();
    const state = await this.store.loadSupplierState(id, supplier);
    let pending = await this.store.readPending(id);
    // A pending file for a snapshot that has already been promoted is stale.
    if (pending && state.complete?.snapshotId === pending.snapshotId) {
      await this.store.deletePending(id);
      pending = null;
      state.pending = null;
    }

    if (state.rateLimitedUntil && parseMs(state.rateLimitedUntil, 0) > nowMs) {
      state.nextRunAt = Math.max(state.nextRunAt ?? 0, parseMs(state.rateLimitedUntil));
      await this.store.saveSupplierState(id, state);
      return;
    }

    const cursor = pending?.cursor ?? null;
    const pageIndex = (pending?.pagesFetched ?? 0) + 1;
    // With no product cache the failure counter still lives in the state index,
    // otherwise a broken endpoint would be retried forever without ever pausing.
    const priorFailures = pending?.failures ?? state.pending?.failures ?? 0;
    const priorStartedAt = pending?.startedAt ?? state.pending?.startedAt ?? null;
    state.lastRequestAt = nowMs;
    state.lastRunAt = iso(nowMs);
    if (!pending) {
      state.pending = pendingMeta(null, {
        status: 'active',
        stopStep: '第 1 页（采集中）',
        failures: priorFailures,
        startedAt: priorStartedAt,
      });
    } else {
      state.pending = pendingMeta(pending, { status: 'active', retryAt: null });
    }

    let page;
    try {
      page = await this.fetchPage({
        url: supplier.url,
        cursor,
        pageSize: supplier.pageSize,
        signal,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (!this._isConfigured(id)) return;
      await this._handlePageError(supplier, state, pending, pageIndex, error);
      return;
    }

    // The supplier was removed from the config while the request was in flight.
    if (!this._isConfigured(id)) return;

    const startedAt = pending?.startedAt ?? state.pending?.startedAt ?? iso(nowMs);
    let attempt;

    if (pending && page.snapshotId !== pending.snapshotId) {
      // Pages inside one catalog must all belong to a single snapshot. If the
      // supplier rotated its snapshot mid-pagination, start over next step.
      await this.store.deletePending(id);
      state.pending = null;
      state.nextRunAt = nowMs + this.cursorExpiredRestartMs;
      state.lastStop = {
        at: iso(nowMs),
        reason: '分页途中快照发生变化，将重新取快照',
        snapshotId: page.snapshotId,
        replacedSnapshotId: pending.snapshotId,
        pagesFetched: pending.pagesFetched,
      };
      appendEvent(
        state,
        'warn',
        `分页途中快照由 ${pending.snapshotId} 变为 ${page.snapshotId}，丢弃已取页面并重新开始`,
      );
      await this.store.saveSupplierState(id, state);
      return;
    }

    if (!pending) {
      attempt = {
        snapshotId: page.snapshotId,
        products: [...page.products],
        cursor: page.nextCursor,
        pagesFetched: 1,
        startedAt,
        updatedAt: iso(nowMs),
        failures: 0,
      };
      state.pending = pendingMeta(attempt, { status: 'active' });
      appendEvent(state, 'info', `开始新快照 ${page.snapshotId}（第 1 页，${page.products.length} 条）`);
    } else {
      if (page.nextCursor && page.nextCursor === pending.cursor) {
        appendEvent(state, 'error', '接口游标未向前推进，本次采集暂停');
        await this._markStopped(id, state, pending, {
          status: 'stopped',
          reason: '接口返回了与请求相同的游标，已停止以避免死循环',
          nextRunAt: nextDailyTomorrow(supplier.collectionTime, nowMs),
          failures: (pending.failures ?? 0) + 1,
        });
        return;
      }
      attempt = {
        ...pending,
        products: [...pending.products, ...page.products],
        cursor: page.nextCursor,
        pagesFetched: pending.pagesFetched + 1,
        updatedAt: iso(nowMs),
        failures: 0,
      };
      state.pending = pendingMeta(attempt, { status: 'active' });
    }

    if (!page.nextCursor) {
      const completedAt = iso(nowMs);
      const snapshot = {
        snapshotId: attempt.snapshotId,
        products: attempt.products,
        pages: attempt.pagesFetched,
        pageCount: attempt.pagesFetched,
        productCount: attempt.products.length,
        startedAt: attempt.startedAt,
        completedAt,
        sourceUrl: supplier.url,
        supplierName: supplier.name,
      };
      // Only promote to "current" once every page of the same snapshot arrived.
      await this.store.writeComplete(id, snapshot);
      await this.store.deletePending(id);
      state.complete = completeMeta(snapshot);
      state.pending = null;
      state.lastCompletedDate = todayKey(parseMs(completedAt, nowMs));
      state.rateLimitedUntil = null;
      state.lastStop = null;
      state.nextRunAt = nextDailyTomorrow(supplier.collectionTime, nowMs);
      appendEvent(
        state,
        'success',
        `快照 ${snapshot.snapshotId} 已收齐（${snapshot.pages} 页 / ${snapshot.productCount} 条），已替换旧清单`,
      );
      await this.store.saveSupplierState(id, state);
      return;
    }

    await this._persistPendingFile(id, attempt);
    state.pending = pendingMeta(attempt, { status: 'active' });
    state.rateLimitedUntil = null;
    state.nextRunAt = nowMs + pageIntervalMs(supplier);
    await this.store.saveSupplierState(id, state);
  }

  async _handlePageError(supplier, state, pending, pageIndex, error) {
    const id = supplier.id;
    const nowMs = this.now();
    // Without a product cache, page count and failure count come from the state
    // index so backoff still advances across attempts.
    const shown = pending ?? state.pending ?? {};
    const priorFailures = shown.failures ?? 0;

    if (error instanceof StopError || (error?.name === 'AbortError' && !error?.retryAfterMs)) {
      // Graceful shutdown or removal: don't leave the state looking "active"
      // while nothing is running.
      if (state.pending) {
        state.pending = pendingMeta(pending ?? state.pending, {
          status: 'retrying',
          stopReason: '采集器已停止，等待恢复',
          retryAt: iso(nowMs),
          failures: priorFailures,
        });
      }
      state.nextRunAt = nowMs;
      await this.store.saveSupplierState(id, state);
      return;
    }

    if (error instanceof RateLimitError) {
      const waitMs = Math.max(100, error.retryAfterMs ?? 1000);
      const retryAt = nowMs + waitMs;
      state.rateLimitedUntil = retryAt;
      state.pending = pendingMeta(pending ?? state.pending, {
        status: 'rate_limited',
        stopReason: `接口限流：${error.message}`,
        stopStep: `第 ${pageIndex} 页（限流，${Math.ceil(waitMs / 1000)} 秒后重试）`,
        retryAt: iso(retryAt),
        rateLimitedUntil: iso(retryAt),
        failures: priorFailures,
      });
      state.nextRunAt = retryAt;
      state.lastRunAt = iso(nowMs);
      appendEvent(
        state,
        'warn',
        `接口限流，${Math.ceil(waitMs / 1000)} 秒后从第 ${pageIndex} 页重新排队（其他来源继续采集）`,
      );
      await this.store.saveSupplierState(id, state);
      return;
    }

    if (error instanceof CursorExpiredError) {
      await this.store.deletePending(id);
      state.lastStop = {
        at: iso(nowMs),
        reason: `游标过期：${error.message}`,
        snapshotId: shown.snapshotId ?? null,
        pagesFetched: shown.pagesFetched ?? 0,
      };
      state.pending = null;
      state.rateLimitedUntil = null;
      state.nextRunAt = nowMs + this.cursorExpiredRestartMs;
      appendEvent(state, 'warn', '游标已过期，将重新取一份新快照（旧清单继续展示）');
      await this.store.saveSupplierState(id, state);
      return;
    }

    if (error instanceof PageFatalError) {
      const failures = priorFailures + 1;
      // Give up for the rest of the day after repeated permanent failures.
      const waitMs = failures >= this.fatalMaxFailures
        ? Math.max(1000, nextDailyTomorrow(supplier.collectionTime, nowMs) - nowMs)
        : this.fatalRetryMs;
      const nextRunAt = nowMs + waitMs;
      state.rateLimitedUntil = null;
      state.pending = pendingMeta(pending ?? state.pending, {
        status: 'stopped',
        stopReason: error.message,
        stopStep: `第 ${pageIndex} 页（接口错误，已暂停）`,
        retryAt: iso(nextRunAt),
        failures,
      });
      state.nextRunAt = nextRunAt;
      appendEvent(
        state,
        'error',
        failures >= this.fatalMaxFailures
          ? `接口错误：${error.message}；连续失败 ${failures} 次，今日不再重试`
          : `接口错误：${error.message}；${Math.round(waitMs / 60000)} 分钟后重试`,
      );
      await this.store.saveSupplierState(id, state);
      return;
    }

    const retryable = error instanceof PageRetryableError || error?.name === 'PageRetryableError';
    if (!retryable) {
      this.logger.error(`[collector] ${supplier.id} 出现未知错误`, error);
    }
    const failures = priorFailures + 1;
    // A 5xx may carry a Retry-After, but an endpoint that keeps failing should
    // still back off instead of being hammered at a fixed short interval.
    const waitMs = Math.max(error?.retryAfterMs ?? 0, this._backoffMs(failures));
    const nextRunAt = nowMs + waitMs;
    state.pending = pendingMeta(pending ?? state.pending, {
      status: 'retrying',
      stopReason: `接口异常：${error?.message ?? String(error)}`,
      stopStep: `第 ${pageIndex} 页（接口异常，${Math.ceil(waitMs / 1000)} 秒后重试）`,
      retryAt: iso(nextRunAt),
      failures,
    });
    state.nextRunAt = nextRunAt;
    appendEvent(state, 'warn', `接口异常：${error?.message ?? error}；第 ${pageIndex} 页稍后重试`);
    await this.store.saveSupplierState(id, state);
  }

  /** Status used by the HTTP API; reads only the state index, never the catalogs. */
  async describeSupplier(supplier) {
    const state = await this.store.loadSupplierState(supplier.id, supplier);
    const nowMs = this.now();
    const completeToday = state.lastCompletedDate === todayKey(nowMs);
    const pending = state.pending ? { ...state.pending } : null;
    if (pending && pending.status === 'active' && !this.activeRuns.has(supplier.id)) {
      // Between page requests nothing is in flight; don't claim "采集中".
      pending.stopStep = `第 ${(pending.pagesFetched ?? 0) + 1} 页（等待下一轮）`;
    }

    let status;
    if (!supplier.enabled) status = 'disabled';
    else if (pending) {
      const retryAt = parseMs(pending.retryAt, 0);
      if (pending.status === 'rate_limited') status = 'rate_limited';
      else if (pending.status === 'stopped') status = 'stopped';
      else if (pending.status === 'retrying') status = 'retrying';
      else if (this.activeRuns.has(supplier.id)) status = 'collecting';
      else if (retryAt && retryAt > nowMs) status = 'waiting_retry';
      else if (this.earliestNextRun(state, supplier, nowMs) > nowMs) status = 'queued';
      else status = 'collecting';
    } else if (completeToday) status = 'complete';
    else if (state.complete) status = 'waiting';
    else status = 'never';

    return {
      id: supplier.id,
      name: supplier.name,
      url: supplier.url,
      collectionTime: supplier.collectionTime,
      requestsPerMinute: supplier.requestsPerMinute,
      pageSize: supplier.pageSize,
      enabled: supplier.enabled,
      status,
      completeToday,
      complete: state.complete ? { ...state.complete } : null,
      pending: pending ?? null,
      lastStop: state.lastStop ?? null,
      nextRunAt: state.nextRunAt ?? null,
      nextRunAtIso: state.nextRunAt ? iso(parseMs(state.nextRunAt, nowMs)) : null,
      lastRunAt: state.lastRunAt ?? null,
      events: (state.events ?? []).slice(0, 8),
      hasProducts: Boolean(state.complete),
    };
  }
}
