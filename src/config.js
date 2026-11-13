import { isValidClockTime, randomId } from './util.js';

export const SUPPLIER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const NAME_LIMIT = 48;

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function integer(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return Math.min(max, Math.max(min, rounded));
}

export function normalizeSupplier(input = {}, { id = null } = {}) {
  const name = text(input.name);
  if (!name) throw new Error('供应商名称不能为空');
  if (name.length > NAME_LIMIT) throw new Error(`供应商名称不能超过 ${NAME_LIMIT} 个字符`);

  const rawUrl = text(input.url);
  if (!rawUrl) throw new Error('接口地址不能为空');
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('接口地址不是有效的 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('接口地址只支持 http 或 https');
  }

  const collectionTime = text(input.collectionTime, '07:30');
  if (!isValidClockTime(collectionTime)) {
    throw new Error('采集时间必须是 HH:MM（例如 07:30）');
  }

  const requestsPerMinute = integer(input.requestsPerMinute, 60, 1, 600);
  const pageSize = integer(input.pageSize, 50, 1, 200);

  let supplierId = id || text(input.id);
  if (!supplierId) supplierId = `src-${randomId()}`;
  if (!SUPPLIER_ID_RE.test(supplierId)) {
    throw new Error('供应商标识只能使用小写字母、数字、下划线和连字符');
  }

  return {
    id: supplierId,
    name,
    url: parsed.toString(),
    collectionTime,
    requestsPerMinute,
    pageSize,
    enabled: input.enabled !== false,
  };
}

export function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('配置必须是对象');
  if (!Array.isArray(input.suppliers)) throw new Error('配置中的 suppliers 必须是数组');

  const suppliers = [];
  const ids = new Set();
  for (const entry of input.suppliers) {
    const supplier = normalizeSupplier(entry, { id: text(entry?.id) || null });
    if (ids.has(supplier.id)) throw new Error(`供应商标识重复：${supplier.id}`);
    ids.add(supplier.id);
    suppliers.push(supplier);
  }
  return { version: 1, suppliers };
}
