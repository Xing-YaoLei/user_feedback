const STATUS = {
  complete: { label: '今日已更新', tone: 'success' },
  collecting: { label: '采集中', tone: 'info' },
  queued: { label: '排队中', tone: 'info' },
  rate_limited: { label: '限流排队', tone: 'warn' },
  waiting_retry: { label: '等待重试', tone: 'warn' },
  retrying: { label: '接口异常 · 重试中', tone: 'warn' },
  stopped: { label: '采集已暂停', tone: 'danger' },
  waiting: { label: '等待采集', tone: 'neutral' },
  never: { label: '尚未采集', tone: 'neutral' },
  disabled: { label: '已停用', tone: 'neutral' },
};

const state = {
  overview: null,
  settings: null,
  settingsDirty: false,
  detailId: null,
  detail: null,
  detailQuery: '',
  detailLoading: false,
};

const $ = (id) => document.getElementById(id);

const hasOwnProperty = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'string') {
      for (const declaration of value.split(';')) {
        const [name, setting] = declaration.split(':');
        if (name && setting) node.style.setProperty(name.trim(), setting.trim());
      }
    } else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else if (hasOwnProperty(node, key) || key in node) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function formatTime(value) {
  if (!value) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? time : `${date} ${time}`;
}

function relative(value) {
  if (!value) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  let text;
  if (abs < 45_000) text = `${Math.round(abs / 1000)} 秒`;
  else if (abs < 45 * 60_000) text = `${Math.round(abs / 60_000)} 分钟`;
  else if (abs < 36 * 3_600_000) text = `${Math.round(abs / 3_600_000)} 小时`;
  else text = `${Math.round(abs / 86_400_000)} 天`;
  return past ? `${text}前` : `${text}后`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(body?.message || `请求失败（HTTP ${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return body;
}

function badge(status) {
  const meta = STATUS[status] ?? { label: status ?? '未知', tone: 'neutral' };
  return el('span', { class: `badge ${meta.tone}` }, el('span', { class: 'dot' }), meta.label);
}

function statusNote(item) {
  const pending = item.pending;
  const complete = item.complete;

  if (item.status === 'disabled') {
    return el('div', { class: 'stale-note' }, el('span', {}, '⏸'),
      el('span', {}, complete
        ? '该来源已停用，仍显示最后一次完整清单。'
        : '该来源已停用，从未采集过完整清单。'));
  }

  if (!complete) {
    return el('div', { class: 'stale-note' }, el('span', {}, '⏳'),
      el('span', {}, pending
        ? '今日清单尚未收齐，暂时没有可展示的完整清单。'
        : '尚未成功采集过完整清单，请检查接口地址或手动触发采集。'));
  }

  if (!item.completeToday) {
    if (pending) {
      return el('div', { class: 'stale-note' }, el('span', {}, '⏳'),
        el('span', {}, '今日清单未采完，继续显示上一次完整快照（'),
        el('code', {}, complete.snapshotId ?? '—'),
        el('span', {}, `）；停在${pending.stopStep ?? `第 ${pending.pagesFetched + 1} 页`}。其他来源照常更新。`));
    }
    if (item.lastStop?.reason) {
      return el('div', { class: 'stale-note' }, el('span', {}, '⏳'),
        el('span', {}, `继续显示上一次完整快照（`),
        el('code', {}, complete.snapshotId ?? '—'),
        el('span', {}, `）；最近一次：${item.lastStop.reason}。`));
    }
    const nextLabel = item.nextRunAtIso ? `今日 ${formatDateTime(item.nextRunAtIso)}` : '今日计划';
    return el('div', { class: 'stale-note' }, el('span', {}, '🕗'),
      el('span', {}, `等待${nextLabel}开始采集，当前显示上一次完整快照（`),
      el('code', {}, complete.snapshotId ?? '—'),
      el('span', {}, '）。'));
  }
  return null;
}

function cardFor(item) {
  const complete = item.complete;
  const pending = item.pending;
  const stale = Boolean(complete) && !item.completeToday;
  const classes = ['card'];
  if (stale) classes.push('is-stale');
  if (item.completeToday) classes.push('is-complete');

  const head = el('div', { class: 'card-head' },
    el('div', { class: 'card-title' },
      el('h3', {}, item.name),
      el('span', { class: 'card-url', title: item.url }, item.url)),
    badge(item.status));

  const snapshotBlock = complete
    ? el('div', { class: 'snapshot-line' },
        el('span', {}, item.completeToday ? '今日完整快照' : '上次完整快照'),
        el('span', { class: 'snap-id' }, complete.snapshotId),
        el('span', {}, `${formatDateTime(complete.completedAt)} 收齐 · ${complete.pageCount ?? '—'} 页`))
    : el('div', { class: 'snapshot-line' },
        el('span', {}, '暂无完整快照'),
        el('span', { class: 'snap-id' }, '—'));

  const statRow = complete
    ? el('div', { class: 'stat-row' },
        el('span', {}, '商品 ', el('b', {}, String(complete.productCount ?? 0)), ' 条'),
        el('span', {}, item.completeToday ? '今日已收齐' : `上次收齐于 ${relative(complete.completedAt)}`))
    : el('div', { class: 'stat-row' }, el('span', {}, '每日采集时间 ', el('b', {}, item.collectionTime)));

  const note = statusNote(item);

  const progressWrap = el('div', { class: 'progress' });
  if (pending) {
    const fetched = Number(pending.pagesFetched ?? 0);
    const done = complete ? Number(complete.pageCount ?? 0) : 0;
    const ratio = done > 0 ? Math.min(1, fetched / done) : fetched > 0 ? 0.35 : 0.06;
    progressWrap.append(el('span', { class: 'partial', style: `width:${(ratio * 100).toFixed(1)}%` }));
  } else {
    progressWrap.append(el('span', { style: `width:${item.completeToday ? 100 : 0}%` }));
  }

  const pendingBlock = pending
    ? el('div', { class: 'stat-row' },
        el('span', {}, '停在 ', el('b', {}, pending.stopStep ?? `第 ${pending.pagesFetched + 1} 页`)),
        el('span', {}, '快照 ', el('code', {}, pending.snapshotId ?? '待定')),
        el('span', {}, '已缓存 ', el('b', {}, String(pending.productCount ?? 0)), ' 条'))
    : null;

  const footMeta = (() => {
    if (item.status === 'rate_limited' && pending?.retryAt) {
      return `限流等待中，${relative(pending.retryAt)}（${formatTime(pending.retryAt)}）继续`;
    }
    if (pending?.retryAt && ['retrying', 'waiting_retry'].includes(item.status)) {
      const retryAt = Date.parse(pending.retryAt);
      if (Number.isFinite(retryAt) && retryAt - Date.now() > 3_000) {
        return `第 ${pending.pagesFetched + 1} 页，${relative(pending.retryAt)}重试`;
      }
      return pending.stopStep ?? `第 ${pending.pagesFetched + 1} 页，即将继续`;
    }
    if (pending?.stopStep) return pending.stopStep;
    if (pending?.stopReason) return pending.stopReason;
    if (item.nextRunAtIso) return `下次采集 ${formatDateTime(item.nextRunAtIso)}`;
    return '';
  })();

  const foot = el('div', { class: 'card-foot' },
    el('div', { class: 'card-foot-meta' }, footMeta),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn tiny', type: 'button', on: { click: () => openDetail(item.id) } }, '查看清单'),
      el('button', { class: 'btn tiny', type: 'button', on: { click: () => collectNow(item.id) } }, '立即采集')));

  return el('div', { class: classes.join(' '), dataset: { id: item.id } },
    head, snapshotBlock, note, statRow, progressWrap, pendingBlock, foot);
}

async function collectNow(id) {
  try {
    await api(`/api/suppliers/${encodeURIComponent(id)}/collect`, { method: 'POST', body: '{}' });
    await refresh();
  } catch (error) {
    setFootStatus(`触发采集失败：${error.message}`, true);
  }
}

async function loadSettings() {
  try {
    state.settings = structuredClone(await api('/api/config'));
  } catch (error) {
    setFootStatus(`读取设置失败：${error.message}`, true);
  }
}

function renderSettings() {
  const tbody = $('settings-rows');
  tbody.replaceChildren();
  const config = state.settings;
  if (!config) return;

  config.suppliers.forEach((supplier, index) => {
    const row = el('tr');

    const nameInput = el('input', { type: 'text', value: supplier.name, maxLength: 48, on: { input: () => markSettingsDirty() } });
    const urlInput = el('input', { type: 'url', value: supplier.url, required: true, on: { input: () => markSettingsDirty() } });
    const timeInput = el('input', { type: 'time', value: supplier.collectionTime, required: true, on: { input: () => markSettingsDirty() } });
    const rpmInput = el('input', { type: 'number', min: 1, max: 600, value: supplier.requestsPerMinute, on: { input: () => markSettingsDirty() } });
    const pageInput = el('input', { type: 'number', min: 1, max: 200, value: supplier.pageSize, on: { input: () => markSettingsDirty() } });
    const enabled = el('input', { type: 'checkbox', checked: supplier.enabled, on: { change: () => markSettingsDirty() } });

    row.dataset.index = String(index);
    row.dataset.supplierId = supplier.id ?? '';
    row.append(
      el('td', { class: 'col-name' }, nameInput),
      el('td', { class: 'col-url' }, urlInput),
      el('td', { class: 'col-time' }, timeInput),
      el('td', { class: 'col-num' }, rpmInput),
      el('td', { class: 'col-num' }, pageInput),
      el('td', { class: 'col-toggle' }, enabled),
      el('td', {}, el('button', {
        class: 'btn tiny', type: 'button',
        on: { click: () => removeSettingRow(index) },
      }, '移除')),
    );
    tbody.append(row);
  });
}

function readSettingsFromDom() {
  const rows = [...$('settings-rows').querySelectorAll('tr')];
  return {
    version: 1,
    suppliers: rows.map((row) => {
      const [name, url, time, rpm, pageSize, enabled] = row.querySelectorAll('input');
      return {
        // Keep the id on the row itself: rows may have been removed or reordered.
        id: row.dataset.supplierId || undefined,
        name: name.value.trim(),
        url: url.value.trim(),
        collectionTime: time.value || '07:30',
        requestsPerMinute: Number(rpm.value || 60),
        pageSize: Number(pageSize.value || 50),
        enabled: enabled.checked,
      };
    }),
  };
}

function markSettingsDirty() {
  state.settingsDirty = true;
  setSettingsMsg('有未保存的改动', '');
}

/** Fold current inputs back into state so re-rendering never drops edits. */
function syncSettingsFromDom() {
  if (!state.settings) return;
  state.settings.suppliers = readSettingsFromDom().suppliers;
}

function removeSettingRow(index) {
  syncSettingsFromDom();
  state.settings.suppliers.splice(index, 1);
  renderSettings();
  markSettingsDirty();
}

function setSettingsMsg(text, kind = '') {
  const node = $('settings-msg');
  node.textContent = text;
  node.className = `settings-msg ${kind}`.trim();
}

function setFootStatus(text, isError = false) {
  const node = $('foot-status');
  node.textContent = text;
  node.style.color = isError ? 'var(--danger)' : '';
}

async function saveSettings() {
  try {
    const payload = readSettingsFromDom();
    const saved = await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
    state.settings = structuredClone(saved);
    state.settingsDirty = false;
    setSettingsMsg('已保存，采集计划已更新', 'ok');
    renderSettings();
    await refresh();
  } catch (error) {
    setSettingsMsg(error.message, 'err');
  }
}

function addSettingRow() {
  syncSettingsFromDom();
  state.settings.suppliers.push({
    id: undefined,
    name: '',
    url: '',
    collectionTime: '07:30',
    requestsPerMinute: 60,
    pageSize: 50,
    enabled: true,
  });
  renderSettings();
  markSettingsDirty();
  const rows = $('settings-rows').querySelectorAll('tr');
  rows[rows.length - 1]?.querySelector('input')?.focus();
}

function renderSummary(overview) {
  const summary = overview.summary;
  const wrap = $('summary');
  wrap.replaceChildren(
    el('div', { class: 'stat accent' },
      el('div', { class: 'stat-label' }, '今日已收齐'),
      el('div', { class: 'stat-value' }, String(summary.completeToday), el('small', {}, `/ ${summary.total}`))),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-label' }, '采集中 / 排队'),
      el('div', { class: 'stat-value' }, String(summary.active))),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-label' }, '等待今日采集'),
      el('div', { class: 'stat-value' }, String(summary.waiting))),
    el('div', { class: 'stat' },
      el('div', { class: 'stat-label' }, '本地时间'),
      el('div', { class: 'stat-value', style: 'font-size:19px;font-weight:560' }, formatTime(overview.now))),
  );
}

function renderBoard(overview) {
  const board = $('board');
  board.replaceChildren();
  if (!overview.suppliers.length) {
    board.append(el('p', { class: 'muted' }, '还没有来源，请到“来源设置”添加接口地址。'));
    return;
  }
  for (const item of overview.suppliers) board.append(cardFor(item));
}

async function refresh() {
  try {
    const overview = await api('/api/overview');
    state.overview = overview;
    renderSummary(overview);
    renderBoard(overview);
    setFootStatus(`数据更新于 ${formatTime(overview.now)} · 每 60 秒自动刷新`);
    const mockHint = $('mock-hint');
    if (overview.mockBaseUrl) {
      mockHint.hidden = false;
      $('mock-hint-text').replaceChildren(
        el('span', {}, '用于排查：'),
        el('a', { href: `${overview.mockBaseUrl}/debug`, target: '_blank', rel: 'noopener' }, `${overview.mockBaseUrl}/debug`),
        el('span', {}, ' 可注入分页中断、限流和游标过期。'),
      );
    } else {
      mockHint.hidden = true;
    }
    if (state.detailId) await openDetail(state.detailId, { keepQuery: true, focus: false });
  } catch (error) {
    setFootStatus(`刷新失败：${error.message}`, true);
  }
}

function productRows(products) {
  return products.map((product) => el('tr',
    el('td', {}, el('code', {}, String(product.sku ?? '—'))),
    el('td', {}, String(product.name ?? '—')),
    el('td', {}, String(product.category ?? '—')),
    el('td', {}, String(product.unit ?? '—')),
    el('td', { class: 'num' }, Number.isFinite(product.price) ? product.price.toFixed(2) : '—'),
    el('td', { class: 'num' }, String(product.stock ?? '—')),
    el('td', {}, String(product.origin ?? '—'))));
}

function renderDetail() {
  const detail = state.detail;
  if (!detail) return;
  const complete = detail.completeSnapshot;
  const products = detail.completeProducts ?? [];
  const query = state.detailQuery.trim().toLowerCase();
  const filtered = query
    ? products.filter((product) => [product.name, product.sku, product.category, product.origin]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(query)))
    : products;

  $('detail-title').replaceChildren(
    el('span', {}, `${detail.name} · `),
    el('span', { class: complete ? '' : 'muted' }, complete ? '当前清单' : '清单尚未收齐'),
  );

  const subParts = [];
  if (complete) {
    subParts.push(`快照 ${complete.snapshotId}`);
    subParts.push(`收齐于 ${formatDateTime(complete.completedAt)}`);
    subParts.push(`${complete.pageCount ?? '—'} 页 / ${complete.productCount ?? products.length} 条`);
    if (!detail.completeToday) subParts.push('今日采集未完成，这是上一次完整清单');
  } else {
    subParts.push('还没有可展示的完整清单');
    if (detail.pending) {
      subParts.push(`今日采集 ${detail.pending.stopStep ?? `停在 ${detail.pending.pagesFetched + 1} 页`}`);
    }
  }
  $('detail-sub').textContent = subParts.join(' · ');

  $('detail-meta').replaceChildren(...[
    el('span', {}, '状态 ', badge(detail.status)),
    detail.pending && !detail.completeToday
      ? el('span', { class: 'muted' }, `今日采集未完成：${detail.pending.stopStep ?? `第 ${detail.pending.pagesFetched + 1} 页`}`)
      : null,
    detail.pending?.stopReason ? el('span', { class: 'muted' }, `原因：${detail.pending.stopReason}`) : null,
    detail.lastStop?.reason ? el('span', { class: 'muted' }, `最近一次：${detail.lastStop.reason}`) : null,
  ].filter(Boolean));

  const body = $('detail-rows');
  body.replaceChildren(...productRows(filtered));
  $('detail-empty').hidden = filtered.length > 0;
  $('detail-empty').textContent = complete
    ? '没有匹配的商品。'
    : '尚未收到完整清单；收齐前不会展示未完成的页面。';
}

async function openDetail(id, { keepQuery = false, focus = true } = {}) {
  try {
    const detail = await api(`/api/suppliers/${encodeURIComponent(id)}`);
    state.detailId = id;
    state.detail = detail;
    if (!keepQuery) {
      state.detailQuery = '';
      $('detail-search').value = '';
    }
    $('detail-panel').hidden = false;
    renderDetail();
    if (focus) $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setFootStatus(`读取清单失败：${error.message}`, true);
  }
}

function setupEvents() {
  $('refresh').addEventListener('click', () => refresh());
  $('refresh-all').addEventListener('click', async () => {
    try {
      await api('/api/collect-all', { method: 'POST', body: '{}' });
      setFootStatus('已排队全部来源的采集');
      await refresh();
    } catch (error) {
      setFootStatus(`触发失败：${error.message}`, true);
    }
  });
  $('open-settings').addEventListener('click', async () => {
    if (!state.settings) await loadSettings();
    if (state.settingsDirty) {
      state.settings = null;
      state.settingsDirty = false;
      await loadSettings();
    }
    $('settings-panel').hidden = false;
    renderSettings();
    $('settings-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('settings-close').addEventListener('click', () => { $('settings-panel').hidden = true; });
  $('settings-add').addEventListener('click', addSettingRow);
  $('settings-save').addEventListener('click', saveSettings);
  $('detail-close').addEventListener('click', () => {
    $('detail-panel').hidden = true;
    state.detailId = null;
    state.detail = null;
  });
  $('detail-search').addEventListener('input', (event) => {
    state.detailQuery = event.target.value;
    renderDetail();
  });

  setInterval(() => {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  }, 1000);
  setInterval(() => refresh(), 60_000);
}

async function boot() {
  setupEvents();
  await loadSettings();
  renderSettings();
  await refresh();
}

boot();
