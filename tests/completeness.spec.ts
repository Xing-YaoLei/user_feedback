// 完整性验收：对照真值核对采集结果。
import { test, expect, chromium } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGroundTruth, baseOptions, runCrawl } from './helpers';

const OUT = join(process.cwd(), 'output/test-full');

test.beforeAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

test('完整采集：所有非重合测站被采集，重合组标为未完成且不估算', async () => {
  const gt = loadGroundTruth();
  const grouped = new Set(gt.stations.filter((s) => s.groupId).map((s) => s.id));
  const collectable = gt.stations.filter((s) => !s.groupId);

  const browser = await chromium.launch();
  const state = await runCrawl(
    browser,
    baseOptions({
      stateFile: join(OUT, 'state.json'),
      pauseFile: join(OUT, 'pause.flag'),
      reportFile: join(OUT, 'report.html'),
    })
  ).finally(() => browser.close());

  // 1) 所有可单独点击的测站必须全部采集到
  expect(state.finished).toBe(true);
  const collectedIds = new Set(Object.keys(state.stations));
  const missing = collectable.map((s) => s.id).filter((id) => !collectedIds.has(id));
  expect(missing, `遗漏测站: ${missing.join(', ')}`).toEqual([]);

  // 2) 重合组测站一个都不允许出现在采集结果里（无法点开详情就不能编）
  const leakedGrouped = [...collectedIds].filter((id) => grouped.has(id));
  expect(leakedGrouped).toEqual([]);

  // 3) 每个重合组都必须有一条“未完成聚合”，位置与组坐标吻合（50 米内），计数正确
  expect(Object.keys(state.unresolved).length).toBe(gt.coincidentGroups.length);
  for (const g of gt.coincidentGroups) {
    const match = Object.values(state.unresolved).find(
      (u) =>
        Math.abs(u.lat - g.lat) < 0.001 &&
        Math.abs(u.lng - g.lng) < 0.001 &&
        u.visibleCount === g.count
    );
    expect(match, `重合组 ${g.groupId} 未登记为未完成`).toBeTruthy();
  }

  // 4) 采集详情字段与真值一致（数据来自详情弹窗可见文本）
  for (const s of collectable.slice(0, 25)) {
    const rec = state.stations[s.id];
    expect(rec).toBeTruthy();
    expect(rec.name).toBe(s.name);
    expect(rec.type).toBe(s.type);
    expect(rec.status).toBe(s.status);
    expect(rec.lat).toBeCloseTo(s.lat, 5);
    expect(rec.lng).toBeCloseTo(s.lng, 5);
    expect(rec.elevation).toBe(s.elevation);
    expect(rec.installDate).toBe(s.installDate);
  }

  // 5) 边缘分块重复不产生重复记录
  expect(Object.keys(state.stations).length).toBe(collectable.length);

  // 6) 每个完成的分块都有路径记录
  expect(state.path.length).toBeGreaterThan(state.cells.length);
  expect(state.cells.every((c) => c.status === 'done')).toBe(true);
});
