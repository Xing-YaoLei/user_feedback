import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 900_000,
  expect: { timeout: 20_000 },
  fullyParallel: false, // 采集测试共用 output/ 状态文件，串行执行
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://127.0.0.1:4321/',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4321/',
    headless: true,
    actionTimeout: 15_000,
  },
});
