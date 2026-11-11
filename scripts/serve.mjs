// 最小静态服务器：只暴露 map-app/ 和 node_modules 中的地图库文件。
// data/（含 ground-truth.json）在服务根目录之外，任何 HTTP 请求都拿不到。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const appDir = join(root, '..', 'map-app');
const vendorRoot = join(root, '..', 'node_modules');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// 白名单前缀 → 磁盘目录
const MOUNTS = [
  { prefix: '/vendor/leaflet/', dir: join(vendorRoot, 'leaflet') },
  { prefix: '/vendor/markercluster/', dir: join(vendorRoot, 'leaflet.markercluster') },
  { prefix: '/', dir: appDir },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  console.log(`[http] ${req.method} ${pathname}`);

  const mount = MOUNTS.find((m) => pathname === m.prefix || pathname.startsWith(m.prefix));
  if (!mount) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let rel = pathname.slice(mount.prefix.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const filePath = normalize(join(mount.dir, rel));
  if (!filePath.startsWith(mount.dir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const port = Number(process.env.PORT || 4321);
server.listen(port, '127.0.0.1', () => {
  console.log(`测试地图: http://127.0.0.1:${port}/`);
});
