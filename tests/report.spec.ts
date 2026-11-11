// 回看报告验收：报告是自包含 HTML，覆盖网格/路径/未完成聚合都可在 DOM 中回看。
import { test, expect, chromium } from '@playwright/test';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGroundTruth, baseOptions, runCrawl } from './helpers';

const OUT = join(process.cwd(), 'output/test-report');
const REPORT = join(OUT, 'report.html');

test.beforeAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

test('报告含覆盖网格、扫描路径、测站层、未完成聚合层且数字自洽', async ({ page }) => {
  const gt = loadGroundTruth();
  const collectable = gt.stations.filter((s) => !s.groupId);

  const browser = await chromium.launch();
  const state = await runCrawl(
    browser,
    baseOptions({
      stateFile: join(OUT, 'state.json'),
      pauseFile: join(OUT, 'pause.flag'),
      reportFile: REPORT,
      maxCells: 26, // 覆盖到重合组所在分块（索引 ~17），同时保持部分完成状态
    })
  ).finally(() => browser.close());

  const html = await readFile(REPORT, 'utf-8');
  expect(html).toContain('data-testid="grid-cell"');
  expect(html).toContain('data-testid="scan-path"');
  expect(html).toContain('data-testid="report-unresolved"');

  await page.goto(`file://${REPORT}`);
  const cells = page.locator('[data-testid="grid-cell"]');
  expect(await cells.count()).toBe(state.cells.length);
  const doneCells = await cells.evaluateAll(
    (els) => els.filter((e) => (e as HTMLElement).dataset.status === 'done').length
  );
  expect(doneCells).toBe(26);

  // 路径至少包含进入细网格分块与聚合展开两类（跨浏览器边界后 Set 被序列化为数组）
  const paths = page.locator('[data-testid="scan-path"]');
  const actions = await paths.evaluateAll((els) =>
    Array.from(new Set(els.map((e) => (e as SVGElement).getAttribute('data-action'))))
  );
  expect(actions).toContain('enter-cell');
  expect(actions).toContain('click-cluster');

  // 统计卡片与状态文件一致
  expect(await page.locator('[data-testid="stat-collected"]').innerText())
    .toBe(String(Object.keys(state.stations).length));
  expect(Number(await page.locator('[data-testid="stat-collected"]').innerText())).toBeLessThanOrEqual(
    collectable.length
  );

  // 明细表行数等于采集数
  expect(await page.locator('[data-testid="station-table"] tbody tr').count())
    .toBe(Object.keys(state.stations).length);
});

test('全量运行后报告把全部重合组标为未完成', async ({ page }) => {
  const gt = loadGroundTruth();
  const browser = await chromium.launch();
  await runCrawl(
    browser,
    baseOptions({
      stateFile: join(OUT, 'full.json'),
      pauseFile: join(OUT, 'full.pause'),
      reportFile: join(OUT, 'full.html'),
    })
  ).finally(() => browser.close());

  await page.goto(`file://${join(OUT, 'full.html')}`);
  expect(await page.locator('[data-testid="report-unresolved"]').count())
    .toBe(gt.coincidentGroups.length);
  expect(await page.locator('[data-testid="unresolved-table"] tbody tr').count())
    .toBe(gt.coincidentGroups.length);
});
