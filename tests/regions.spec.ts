// 稀疏 / 密集区域分别验收：裁剪 bbox 局部运行，检查聚合展开与覆盖完整性。
import { test, expect, chromium } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGroundTruth, baseOptions, runCrawl } from './helpers';

const OUT = join(process.cwd(), 'output/test-regions');

test.beforeAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

async function runRegion(name: string, bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number }) {
  const gt = loadGroundTruth();
  const inRegion = gt.stations.filter(
    (s) =>
      !s.groupId &&
      s.lat >= bbox.minLat && s.lat <= bbox.maxLat &&
      s.lng >= bbox.minLng && s.lng <= bbox.maxLng
  );
  const groupsInRegion = gt.coincidentGroups.filter(
    (g) => g.lat >= bbox.minLat && g.lat <= bbox.maxLat && g.lng >= bbox.minLng && g.lng <= bbox.maxLng
  );

  const browser = await chromium.launch();
  const state = await runCrawl(
    browser,
    baseOptions({
      stateFile: join(OUT, `${name}.json`),
      pauseFile: join(OUT, `${name}.pause`),
      reportFile: join(OUT, `${name}.html`),
      bbox,
    })
  ).finally(() => browser.close());

  expect(state.finished).toBe(true);
  const ids = new Set(Object.keys(state.stations));
  const missing = inRegion.map((s) => s.id).filter((id) => !ids.has(id));
  expect(missing, `${name} 区域遗漏: ${missing.join(', ')}`).toEqual([]);
  // 不允许采到区域之外的测站（网格只覆盖目标 bbox，容差 0.002°）
  for (const rec of Object.values(state.stations)) {
    expect(rec.lat).toBeGreaterThanOrEqual(bbox.minLat - 0.002);
    expect(rec.lat).toBeLessThanOrEqual(bbox.maxLat + 0.002);
    expect(rec.lng).toBeGreaterThanOrEqual(bbox.minLng - 0.002);
    expect(rec.lng).toBeLessThanOrEqual(bbox.maxLng + 0.002);
  }
  expect(Object.keys(state.unresolved).length).toBe(groupsInRegion.length);
  return { state, expected: inRegion.length };
}

test('稀疏区域：低标记密度下分块不遗漏', async () => {
  // 取远离两个密集中心和重合组的稀疏区域（真值中仅 6 个测站）
  const { state, expected } = await runRegion('sparse', {
    minLat: 30.46,
    maxLat: 30.49,
    minLng: 121.22,
    maxLng: 121.26,
  });
  expect(Object.keys(state.stations).length).toBe(expected);
});

test('密集区域：聚合逐级展开后全部测站可单独点开', async () => {
  const { state, expected } = await runRegion('dense', {
    minLat: 30.385,
    maxLat: 30.415,
    minLng: 121.10,
    maxLng: 121.14,
  });
  expect(Object.keys(state.stations).length).toBe(expected);
  // 密集区必然经历过聚合展开
  expect(state.path.some((p) => p.action === 'click-cluster')).toBe(true);
  expect(expected).toBeGreaterThan(30);
});
