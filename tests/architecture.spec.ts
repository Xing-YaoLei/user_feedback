// 架构守卫：机器人只能通过可见地图与详情交互。
// 静态扫描采集器源码，禁止任何页面内执行 / 内部对象访问 / 隐藏接口调用。
import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const CRAWLER_DIR = join(process.cwd(), 'src/crawler');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (extname(p) === '.ts') out.push(p);
  }
  return out;
}

const FORBIDDEN_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\.evaluate\s*\(/, reason: 'page.evaluate 会在页面上下文执行代码，绕过可见交互' },
  { re: /\.addInitScript\s*\(/, reason: 'addInitScript 向页面注入脚本，属于隐藏接口' },
  { re: /\.exposeFunction\s*\(/, reason: 'exposeFunction 向页面暴露桥接接口' },
  { re: /\.exposeBinding\s*\(/, reason: 'exposeBinding 向页面暴露桥接接口' },
  { re: /\bwindow\.[A-Za-z_]/, reason: '禁止读取 window 上的页面内部对象' },
  { re: /\bdocument\.[A-Za-z_]/, reason: '禁止直接访问页面 document（应使用 locator）' },
  { re: /\bfetch\s*\(/, reason: '禁止在页面侧调用接口代替浏览器操作' },
  { re: /XMLHttpRequest/, reason: '禁止 XHR 隐藏接口' },
  { re: /STATION_DATASET|MAP_CONFIG/, reason: '禁止引用页面内部数据对象' },
  { re: /__playwright|cdpSession|newCDPSession/, reason: '禁止 CDP 绕过' },
  { re: /route\.(fulfill|continue|abort)/, reason: '禁止拦截/伪造网络请求' },
  { re: /ground-truth/, reason: '采集器不得读取验收真值文件' },
];

test('采集器源码不含任何隐藏接口或页面内执行调用', () => {
  const violations: string[] = [];
  for (const file of listTsFiles(CRAWLER_DIR)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      for (const { re, reason } of FORBIDDEN_PATTERNS) {
        if (re.test(line)) {
          violations.push(`${file}:${idx + 1}  ${reason}\n    ${trimmed}`);
        }
      }
    });
  }
  expect(violations, violations.join('\n')).toEqual([]);
});

test('采集器只使用白名单内的 Playwright 页面 API', () => {
  const allowed = new Set([
    'locator', 'goto', 'mouse', 'keyboard', 'waitForTimeout',
    'newContext', 'newPage', 'close', 'launch', 'context',
  ]);
  const offenders: string[] = [];
  for (const file of listTsFiles(CRAWLER_DIR)) {
    const src = readFileSync(file, 'utf-8');
    const calls = src.matchAll(/(?:page|context|browser)\.([a-zA-Z]+)\s*\(/g);
    for (const m of calls) {
      if (!allowed.has(m[1])) offenders.push(`${file}: 使用了非白名单 API: ${m[1]}`);
    }
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});

test('真值文件不在 HTTP 服务目录内，浏览器无法获取', async ({ request }) => {
  // 服务器只挂载 map-app 与 vendor；尝试各种穿越路径都必须失败
  const probes = [
    '/../data/ground-truth.json',
    '/generated/../ground-truth.json',
    '/data/ground-truth.json',
  ];
  for (const path of probes) {
    const res = await request.get(path);
    expect(res.status(), path).toBeGreaterThanOrEqual(400);
  }
});

test('地图页面不把数据集挂到 window 上', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="hud-loading"]', { hasText: '空闲' }).waitFor();
  // 这里测试代码可以执行 evaluate（测试本身不是采集器）；验证的是页面没有内部对象泄露
  const leaked = await page.evaluate(() =>
    Object.keys(window).filter((k) => /STATION|DATASET|MAP_CONFIG|station/i.test(k))
  );
  expect(leaked).toEqual([]);
});
