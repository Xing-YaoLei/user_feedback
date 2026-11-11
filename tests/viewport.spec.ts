// 视口尺寸改变验收：小视口跑一半 → 换大视口恢复 → 网格重建后仍然完整。
import { test, expect, chromium } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGroundTruth, baseOptions, runCrawl } from './helpers';
import { Crawler } from '../src/crawler/crawler.ts';

const OUT = join(process.cwd(), 'output/test-viewport');

test.beforeAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

test('视口从 960x600 变为 1440x900 后网格重建，采集依旧完整', async () => {
  const gt = loadGroundTruth();
  const collectable = gt.stations.filter((s) => !s.groupId);
  const stateFile = join(OUT, 'state.json');
  const opts = (w: number, h: number, maxCells?: number) =>
    baseOptions({
      stateFile,
      pauseFile: join(OUT, 'pause.flag'),
      reportFile: join(OUT, 'report.html'),
      width: w,
      height: h,
      maxCells,
    });

  const browser = await chromium.launch();
  try {
    // 1) 小视口只跑前 4 个分块
    const partial = await runCrawl(browser, opts(960, 600, 4));
    expect(partial.cells.filter((c) => c.status === 'done').length).toBe(4);
    expect(partial.viewport).toEqual({ width: 960, height: 600 });
    const smallGrid = { ...partial.grid };

    // 2) 大视口恢复：Crawler.create 检测到视口变化并重建网格
    const crawler2 = await Crawler.create(browser, opts(1440, 900));
    const rebuilt = crawler2.currentState;
    expect(rebuilt.viewport).toEqual({ width: 1440, height: 900 });
    // 网格尺寸应当随视口变大而变少（每屏覆盖更多地面）
    expect(rebuilt.grid.cols).toBeLessThanOrEqual(smallGrid.cols);
    expect(rebuilt.grid.rows).toBeLessThanOrEqual(smallGrid.rows);
    // 重建后所有分块回到待办（坐标体系已变，旧覆盖不可复用）
    expect(rebuilt.cells.every((c) => c.status === 'pending')).toBe(true);
    // 已采集测站资料保留，不要求重新点开详情
    expect(Object.keys(rebuilt.stations).length).toBeGreaterThan(0);

    const final = await crawler2.run();
    expect(final.finished).toBe(true);

    // 3) 完整性：所有可采集测站到齐，无重复
    const ids = Object.keys(final.stations);
    expect(new Set(ids).size).toBe(ids.length);
    const missing = collectable.map((s) => s.id).filter((id) => !final.stations[id]);
    expect(missing, missing.join(', ')).toEqual([]);
    expect(Object.keys(final.unresolved).length).toBe(gt.coincidentGroups.length);
  } finally {
    await browser.close();
  }
});
