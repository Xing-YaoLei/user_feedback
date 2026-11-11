// 断点续扫状态的原子读写（写临时文件再 rename），以及暂停控制文件。
import { readFile, writeFile, rename, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import type { CrawlState, BBox } from './types.ts';

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadState(path: string): Promise<CrawlState | null> {
  if (!(await fileExists(path))) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as CrawlState;
}

export async function saveState(path: string, state: CrawlState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

export function createInitialState(
  runId: string,
  bbox: BBox,
  maxZoom: number,
  viewport: { width: number; height: number },
  grid: CrawlState['grid'],
  cells: CrawlState['cells']
): CrawlState {
  return {
    runId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bbox,
    maxZoom,
    viewport,
    grid,
    cells,
    stations: {},
    unresolved: {},
    path: [],
    paused: false,
    finished: false,
    cursor: 0,
  };
}

/** 暂停信号：外部 touch 一个 .pause 文件即可在当前分块边界暂停。 */
export async function isPauseRequested(pauseFile: string): Promise<boolean> {
  return fileExists(pauseFile);
}
