// 测试辅助：真值只允许测试代码读取（采集器进程碰不到这个文件）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { Crawler, type CrawlOptions } from '../src/crawler/crawler.ts';
import type { CrawlState, BBox } from '../src/crawler/types.ts';

export interface GroundTruth {
  bbox: BBox;
  maxZoom: number;
  stations: {
    id: string;
    name: string;
    type: string;
    status: string;
    lat: number;
    lng: number;
    elevation: number;
    installDate: string;
    groupId?: string;
  }[];
  coincidentGroups: { groupId: string; lat: number; lng: number; count: number }[];
}

export function loadGroundTruth(): GroundTruth {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'data/ground-truth.json'), 'utf-8')
  ) as GroundTruth;
}

export function baseOptions(overrides: Partial<CrawlOptions> & {
  stateFile: string;
  pauseFile: string;
  reportFile: string;
}): CrawlOptions {
  const gt = loadGroundTruth();
  return {
    url: 'http://127.0.0.1:4321/',
    bbox: gt.bbox,
    maxZoom: gt.maxZoom,
    width: 1280,
    height: 800,
    startZoom: 12,
    ...overrides,
  };
}

export async function runCrawl(browser: Browser, opts: CrawlOptions): Promise<CrawlState> {
  const crawler = await Crawler.create(browser, opts);
  return crawler.run();
}
