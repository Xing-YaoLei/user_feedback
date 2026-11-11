// 暂停 / 恢复验收：跑到中途落暂停信号 → 进程退出并保存进度 → 恢复后不重不漏。
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { rm, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGroundTruth } from './helpers';

const OUT = join(process.cwd(), 'output/test-pause');
const STATE = join(OUT, 'crawl-state.json');

function runCli(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', join(process.cwd(), 'src/crawler/cli.ts'), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child.stdout.on('data', (d) => process.stdout.write(`[cli] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[cli] ${d}`));
    child.on('exit', (code) => (code === 0 ? resolve(code!) : reject(new Error(`CLI 退出码 ${code}`))));
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('等待超时');
}

test.beforeAll(async () => {
  await rm(OUT, { recursive: true, force: true });
  // 同时清理默认输出目录可能残留的暂停信号，避免环境脏数据干扰
  await rm(join(process.cwd(), 'output', 'pause.flag'), { force: true });
});

test('暂停后恢复：覆盖完整且无重复采集', async () => {
  const gt = loadGroundTruth();
  const collectable = gt.stations.filter((s) => !s.groupId);

  // 1) 启动采集，等至少 3 个分块完成后请求暂停
  const cliArgs = [
    '--output', OUT,
    '--width', '1280', '--height', '800',
  ];
  const child = spawn('node', ['--import', 'tsx', join(process.cwd(), 'src/crawler/cli.ts'), ...cliArgs], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', (d) => process.stdout.write(`[cli-a] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[cli-a] ${d}`));

  await waitFor(async () => {
    try {
      const s = JSON.parse(await readFile(STATE, 'utf-8'));
      const done = s.cells.filter((c: { status: string }) => c.status === 'done').length;
      // 若在达到 3 个分块前就暂停，说明存在残留暂停信号等环境问题，立即失败
      if (s.paused && done < 3) {
        throw new Error('子进程在完成 3 个分块前即暂停，检查残留的 pause.flag');
      }
      return done >= 3;
    } catch (e) {
      if (e instanceof Error && e.message.includes('pause.flag')) throw e;
      return false;
    }
  });
  await writeFile(join(OUT, 'pause.flag'), '');
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`暂停退出码 ${code}`))));
  });

  // 2) 检查暂停快照
  const paused = JSON.parse(await readFile(STATE, 'utf-8'));
  expect(paused.paused).toBe(true);
  expect(paused.finished).toBe(false);
  const doneBefore = paused.cells.filter((c: { status: string }) => c.status === 'done').length;
  const collectedBefore = Object.keys(paused.stations).length;
  expect(doneBefore).toBeGreaterThanOrEqual(3);
  expect(collectedBefore).toBeGreaterThan(0);

  // 3) 恢复（先移除暂停信号）
  await rm(join(OUT, 'pause.flag'), { force: true });
  await runCli(['--resume', '--output', OUT, '--width', '1280', '--height', '800']);

  const final = JSON.parse(await readFile(STATE, 'utf-8'));
  expect(final.finished).toBe(true);
  expect(final.paused).toBe(false);
  expect(final.cells.every((c: { status: string }) => c.status === 'done')).toBe(true);

  // 4) 不重不漏
  const ids = Object.keys(final.stations);
  expect(new Set(ids).size).toBe(ids.length); // 无重复
  const missing = collectable.map((s) => s.id).filter((id) => !final.stations[id]);
  expect(missing, `恢复后遗漏: ${missing.join(', ')}`).toEqual([]);
  expect(Object.keys(final.unresolved).length).toBe(gt.coincidentGroups.length);

  // 报告文件已生成
  await expect(stat(join(OUT, 'report.html'))).resolves.toBeTruthy();
});
