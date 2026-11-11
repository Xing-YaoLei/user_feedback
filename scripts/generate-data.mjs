// 确定性生成测试测站数据。
// 输出两份文件：
//   1) map-app/generated/stations.js  —— 仅地图页面使用（模拟“站点数据服务”，仅按视口推送）
//   2) data/ground-truth.json         —— 测试验收用真值，HTTP 服务根目录之外，机器人无法通过浏览器获取
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- 确定性随机数（mulberry32），保证每次生成的数据完全一致 ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261111);
const gaussian = () => {
  // Box-Muller
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ---- 目标区域（虚构区域，不对应真实地名）----
const BBOX = {
  minLat: 30.38,
  maxLat: 30.52,
  minLng: 121.12,
  maxLng: 121.28,
};

// 近似米制距离（该纬度附近 1° 纬度 ≈ 111320m，1° 经度 ≈ 96300m）
const M_PER_LAT = 111320;
const M_PER_LNG = 111320 * Math.cos(30.45 * Math.PI / 180);
function distMeters(a, b) {
  const dy = (a.lat - b.lat) * M_PER_LAT;
  const dx = (a.lng - b.lng) * M_PER_LNG;
  return Math.hypot(dx, dy);
}

const MIN_GAP_M = 130; // 非重合测站最小间距，保证 z16 下标记可分离
const stations = [];
const coincidentGroups = [];
const TYPES = ['气象', '水文', '空气质量', '噪声', '辐射'];
const STATUSES = ['运行中', '维护中', '停用'];

let seq = 0;
const nextId = () => `ST-${String(++seq).padStart(4, '0')}`;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const makeStation = (lat, lng, extra = {}) => ({
  id: nextId(),
  name: `测站 ${seq} 号`,
  type: pick(TYPES),
  status: pick(STATUSES),
  elevation: Math.round(rand() * 900 * 10) / 10,
  installDate: `${2014 + Math.floor(rand() * 11)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
  lat: Math.round(lat * 1e6) / 1e6,
  lng: Math.round(lng * 1e6) / 1e6,
  ...extra,
});

function tryAdd(lat, lng, extra) {
  if (lat < BBOX.minLat || lat > BBOX.maxLat || lng < BBOX.minLng || lng > BBOX.maxLng) return false;
  const candidate = { lat, lng };
  // 重合点之间不参与最小间距检查
  if (stations.some((s) => !s.groupId && distMeters(s, candidate) < MIN_GAP_M)) return false;
  stations.push(makeStation(lat, lng, extra));
  return true;
}

// ---- 1. 稀疏背景测站：区域内均匀撒点 ----
for (let i = 0; i < 70; i++) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const lat = BBOX.minLat + rand() * (BBOX.maxLat - BBOX.minLat);
    const lng = BBOX.minLng + rand() * (BBOX.maxLng - BBOX.minLng);
    if (tryAdd(lat, lng)) break;
  }
}

// ---- 2. 两个密集城区（高斯聚集）----
const denseCenters = [
  { lat: 30.40, lng: 121.12, n: 55, sLat: 0.006, sLng: 0.008 },
  { lat: 30.50, lng: 121.28, n: 55, sLat: 0.006, sLng: 0.0075 },
];
for (const c of denseCenters) {
  let added = 0;
  let guard = 0;
  while (added < c.n && guard < c.n * 80) {
    guard++;
    const lat = c.lat + gaussian() * c.sLat;
    const lng = c.lng + gaussian() * c.sLng;
    if (tryAdd(lat, lng)) added++;
  }
}

// ---- 3. 完全重合测站组：任何缩放级别都无法展开的聚合（全部位于 bbox 内部）----
const groupSpots = [
  { lat: 30.42, lng: 121.20, sizes: [3, 2, 4] },
];
let groupNo = 0;
for (const spot of groupSpots) {
  for (const size of spot.sizes) {
    const groupId = `GRP-${String(++groupNo).padStart(2, '0')}`;
    const lat = spot.lat + (rand() - 0.5) * 0.01;
    const lng = spot.lng + (rand() - 0.5) * 0.012;
    coincidentGroups.push({ groupId, lat, lng, count: size });
    for (let k = 0; k < size; k++) {
      stations.push(makeStation(lat, lng, { groupId }));
    }
  }
}

// ---- 4. 边缘测站：贴近区域边界，专门考验分块边缘去重 ----
const edgeSpots = [
  { lat: BBOX.minLat + 0.002, lng: 121.18 },
  { lat: BBOX.maxLat - 0.002, lng: 121.2 },
  { lat: 30.46, lng: BBOX.minLng + 0.002 },
  { lat: 30.44, lng: BBOX.maxLng - 0.002 },
];
for (const e of edgeSpots) tryAdd(e.lat, e.lng);

stations.sort((a, b) => a.id.localeCompare(b.id));

const payload = {
  generatedAt: 'deterministic-seed-20261111',
  bbox: BBOX,
  maxZoom: 16,
  loadDelayMs: [120, 300], // 模拟移动地图后数据加载延迟范围
  stations,
  coincidentGroups,
};

mkdirSync(join(root, 'data'), { recursive: true });
mkdirSync(join(root, 'map-app/generated'), { recursive: true });
writeFileSync(join(root, 'data/ground-truth.json'), JSON.stringify(payload, null, 2));
writeFileSync(
  join(root, 'map-app/generated/stations.js'),
  `// 本文件由 scripts/generate-data.mjs 自动生成，请勿手改。\n` +
    `// 数据仅保存在脚本闭包内，不挂到 window 上；地图只按当前视口渲染。\n` +
    `const STATION_DATASET = ${JSON.stringify(stations)};\n` +
    `const MAP_CONFIG = ${JSON.stringify({
      bbox: BBOX,
      maxZoom: 16,
      loadDelayMs: payload.loadDelayMs,
      coincidentGroups,
    })};\n`
);

const grouped = stations.filter((s) => s.groupId).length;
console.log(
  `已生成 ${stations.length} 个测站（其中 ${grouped} 个属于 ${coincidentGroups.length} 个不可展开重合组），` +
    `密集中心 ${denseCenters.length} 个，稀疏背景 + 边缘点若干。`
);
console.log(`- 地图数据: map-app/generated/stations.js`);
console.log(`- 验收真值: data/ground-truth.json（不在 HTTP 服务目录内）`);
