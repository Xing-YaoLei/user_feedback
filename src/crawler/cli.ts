// 采集器 CLI：
//   npm run crawl -- --width 1280 --height 800
//   暂停：touch output/pause.flag（当前分块结束后落盘暂停）
//   恢复：npm run crawl -- --resume
//   仅用已有状态重建报告：npm run crawl -- --report-only
import { parseArgs } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { Crawler } from './crawler.ts';
import { loadState } from './state.ts';
import { buildReport } from './report.ts';
import type { BBox } from './types.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4321/' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    'start-zoom': { type: 'string', default: '12' },
    'max-zoom': { type: 'string', default: '16' },
    'max-cells': { type: 'string' },
    resume: { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false },
    output: { type: 'string', default: 'output' },
  },
});

const outDir = values.output;
const stateFile = join(outDir, 'crawl-state.json');
const pauseFile = join(outDir, 'pause.flag');
const reportFile = join(outDir, 'report.html');

// 与 data/ground-truth.json 相同的目标区域（CLI 配置，不是从页面读取）
const BBOX: BBox = {
  minLat: 30.38,
  maxLat: 30.52,
  minLng: 121.12,
  maxLng: 121.28,
};

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  if (values['report-only']) {
    const state = await loadState(stateFile);
    if (!state) throw new Error(`找不到状态文件 ${stateFile}`);
    await buildReport(state, reportFile, stateFile);
    console.log(`报告已重建: ${reportFile}`);
    return;
  }
  if (!values.resume) {
    await rm(stateFile, { force: true });
    await rm(pauseFile, { force: true });
  }

  const browser = await chromium.launch();
  try {
    const crawler = await Crawler.create(browser, {
      url: values.url!,
      stateFile,
      pauseFile,
      reportFile,
      bbox: BBOX,
      maxZoom: Number(values['max-zoom']),
      width: Number(values.width),
      height: Number(values.height),
      startZoom: Number(values['start-zoom']),
      maxCells: values['max-cells'] ? Number(values['max-cells']) : undefined,
    });
    const state = await crawler.run();
    const collected = Object.keys(state.stations).length;
    const unresolved = Object.keys(state.unresolved).length;
    const done = state.cells.filter((c) => c.status === 'done').length;
    console.log('────────────────────────────────');
    console.log(`状态: ${state.paused ? '已暂停（可 --resume 恢复）' : state.finished ? '全部完成' : '未完成'}`);
    console.log(`分块: ${done}/${state.cells.length}`);
    console.log(`已采集测站: ${collected}`);
    console.log(`未完成聚合: ${unresolved}（涉及 ${Object.values(state.unresolved).reduce((n, u) => n + u.visibleCount, 0)} 个测站，未估算）`);
    console.log(`状态文件: ${stateFile}`);
    console.log(`回看报告: ${reportFile}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
