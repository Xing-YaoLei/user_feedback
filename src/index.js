import { pathToFileURL } from 'node:url';

import { Store } from './store.js';
import { Collector } from './engine.js';
import { DashboardServer } from './server.js';
import { defaultMockSources, startMockServer } from './mock-server.js';

const DEFAULT_PORT = 4100;
const DEFAULT_MOCK_PORT = 4110;
const DEMO_IDS = ['fresh-mart', 'river-garden', 'north-farm'];

function seedConfig(mockBaseUrl) {
  const names = new Map(defaultMockSources().map((source) => [source.id, source.name]));
  return {
    version: 1,
    suppliers: DEMO_IDS.map((id) => ({
      id,
      name: names.get(id) ?? id,
      url: `${mockBaseUrl}/catalog/${id}`,
      collectionTime: '07:30',
      requestsPerMinute: 40,
      pageSize: id === 'north-farm' ? 18 : 24,
      enabled: true,
    })),
  };
}

export async function startApp({
  dataDir = './data',
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  withMock = true,
  mockPort = DEFAULT_MOCK_PORT,
  mockConfigPath = null,
  logger = console,
} = {}) {
  const store = new Store({ dataDir, logger });
  const { configCreated } = await store.init();

  let mock = null;
  let mockBaseUrl = `http://${host}:${mockPort}`;
  if (withMock) {
    mock = await startMockServer({ port: mockPort, host, configPath: mockConfigPath, logger });
    mockBaseUrl = mock.baseUrl;
  }

  if (configCreated && withMock) {
    await store.saveConfig(seedConfig(mockBaseUrl));
  } else if (withMock) {
    // Only the seeded demo rows follow the mock server when its port changes;
    // real supplier URLs are never rewritten.
    const config = store.getConfig();
    let changed = false;
    for (const supplier of config.suppliers) {
      if (!DEMO_IDS.includes(supplier.id)) continue;
      if (!supplier.url.includes('/catalog/')) continue;
      if (!supplier.url.startsWith(mockBaseUrl)) {
        supplier.url = `${mockBaseUrl}${supplier.url.replace(/^https?:\/\/[^/]+/, '')}`;
        changed = true;
      }
    }
    if (changed) await store.saveConfig(config);
  }

  const collector = new Collector({ store, logger });
  await collector.start();

  const dashboard = new DashboardServer({ store, collector, logger, mockBaseUrl: mock ? mock.baseUrl : null });
  const http = await dashboard.listen({ host, port });

  return {
    store,
    collector,
    dashboard,
    http,
    mock,
    url: http.url,
    async close() {
      await collector.stop();
      await http.close();
      if (mock) await mock.close();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const options = {
    dataDir: process.env.DATA_DIR || './data',
    port: Number(process.env.PORT || DEFAULT_PORT),
    mockPort: Number(process.env.MOCK_PORT || DEFAULT_MOCK_PORT),
    withMock: process.env.WITH_MOCK !== '0',
    mockConfigPath: process.env.MOCK_CONFIG || null,
  };
  const app = await startApp(options);
  console.log(`采集控制台: ${app.url}`);
  if (app.mock) {
    console.log(`本地模拟接口: ${app.mock.baseUrl}`);
    console.log(`模拟接口管理页: ${app.mock.baseUrl}/debug`);
  }
  const shutdown = async () => {
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
