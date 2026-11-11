"""运行控制页 + 事件时间线(纯标准库 HTTP 服务)。

- GET  /             控制台页面(状态卡片、启停按钮、缺口列表、事件时间线)
- GET  /api/status   采集器与游标状态 JSON
- GET  /api/events   增量拉取结构化事件(?after=<seq>&limit=<n>)
- GET  /api/gaps     缺口记录
- POST /api/start    启动采集器
- POST /api/stop     停止采集器
- POST /api/reset    重置游标(事件保留,重放时演示去重)
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>SSE 采集控制台</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", sans-serif; margin: 24px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 28px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .card { border: 1px solid #9995; border-radius: 8px; padding: 10px 16px; min-width: 120px; }
  .card .k { font-size: 12px; opacity: .6; }
  .card .v { font-size: 18px; font-weight: 600; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; } .warn { color: #9a6700; }
  button { font-size: 14px; padding: 6px 14px; margin-right: 8px; border-radius: 6px;
           border: 1px solid #9998; background: transparent; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #9993; padding: 4px 8px; text-align: left;
           vertical-align: top; }
  td.data { max-width: 480px; overflow: hidden; text-overflow: ellipsis;
            white-space: nowrap; font-family: ui-monospace, monospace; }
  #err { color: #cf222e; }
</style>
</head>
<body>
<h1>SSE 采集控制台</h1>
<div class="cards" id="cards"></div>
<p id="err"></p>
<p>
  <button onclick="ctl('start')">▶ 启动采集</button>
  <button onclick="ctl('stop')">⏸ 停止</button>
  <button onclick="ctl('reset')">↺ 重置游标(重放演示去重)</button>
</p>
<h2>缺口记录(不可补齐,绝不声称连续)</h2>
<table id="gaps"><thead><tr>
  <th>#</th><th>时间</th><th>from</th><th>to</th><th>原因</th>
</tr></thead><tbody></tbody></table>
<h2>事件时间线</h2>
<table id="tl"><thead><tr>
  <th>seq</th><th>落库时间</th><th>event id</th><th>类型</th><th>data</th>
</tr></thead><tbody></tbody></table>
<script>
let lastSeq = 0;
const fmt = t => new Date(t * 1000).toLocaleTimeString('zh-CN', {hour12: false})
  + '.' + String(Math.floor((t % 1) * 1000)).padStart(3, '0');
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function refresh() {
  try {
    const st = await (await fetch('/api/status')).json();
    const cur = st.cursor || {};
    const cards = [
      ['采集器', st.running ? '<span class="ok">运行中</span>'
                            : (st.completed ? '<span class="warn">已结束</span>' : '停止')],
      ['游标 last_event_id', cur.last_event_id ?? '—'],
      ['连续性', cur.contiguous === false ? '<span class="bad">存在缺口</span>'
                                          : '<span class="ok">连续</span>'],
      ['结构化事件', st.stats.events],
      ['原始事件', st.stats.raw_events],
      ['心跳', st.stats.heartbeats],
      ['去重丢弃', st.stats.duplicates_dropped],
      ['缺口', st.stats.gaps ? '<span class="bad">' + st.stats.gaps + '</span>' : 0],
    ];
    document.getElementById('cards').innerHTML = cards.map(
      ([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`
    ).join('');
    document.getElementById('err').textContent = st.error ? '错误: ' + st.error : '';

    const evs = await (await fetch('/api/events?after=' + lastSeq + '&limit=200')).json();
    const tbody = document.querySelector('#tl tbody');
    for (const e of evs) {
      lastSeq = Math.max(lastSeq, e.seq);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${e.seq}</td><td>${fmt(e.received_at)}</td>` +
        `<td>${e.event_id ?? '<span class="warn">(无 id)</span>'}</td>` +
        `<td>${esc(e.event_type)}</td><td class="data" title="${esc(e.data)}">${esc(e.data)}</td>`;
      tbody.prepend(tr);  // 最新在上
    }

    const gaps = await (await fetch('/api/gaps')).json();
    document.querySelector('#gaps tbody').innerHTML = gaps.map(g =>
      `<tr><td>${g.seq}</td><td>${fmt(g.detected_at)}</td>` +
      `<td>${g.from_id ?? '—'}</td><td>${g.to_id ?? '—'}</td><td class="bad">${esc(g.reason)}</td></tr>`
    ).join('');
  } catch (e) { /* 服务未就绪时静默重试 */ }
}
async function ctl(action) {
  await fetch('/api/' + action, {method: 'POST'});
  setTimeout(refresh, 200);
}
setInterval(refresh, 1000);
refresh();
</script>
</body>
</html>
"""


class ControlHandler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # 静音
        pass

    # ------------------------------------------------------------ 工具

    def _json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @property
    def srv(self) -> "ControlServer":
        return self.server  # type: ignore[return-value]

    # ------------------------------------------------------------ 路由

    def do_GET(self) -> None:
        path, _, qs = self.path.partition("?")
        params = parse_qs(qs)
        if path == "/":
            body = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/status":
            self._json(self.srv.status())
        elif path == "/api/events":
            after = int(params.get("after", ["0"])[0])
            limit = min(int(params.get("limit", ["200"])[0]), 1000)
            self._json(self.srv.store.timeline(self.srv.source_name, after, limit))
        elif path == "/api/gaps":
            self._json(self.srv.store.list_gaps(self.srv.source_name))
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        if self.path == "/api/start":
            self._json(self.srv.start_collector())
        elif self.path == "/api/stop":
            self._json(self.srv.stop_collector())
        elif self.path == "/api/reset":
            self.srv.stop_collector()
            self.srv.store.reset_cursor(self.srv.source_name)
            self._json({"ok": True})
        else:
            self.send_error(404)


class ControlServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, store, source_name: str, collector_factory) -> None:
        super().__init__(addr, ControlHandler)
        self.store = store
        self.source_name = source_name
        self._collector_factory = collector_factory
        self._collector = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------ 采集器控制

    def start_collector(self) -> dict:
        with self._lock:
            if self._collector is not None and self._collector.running:
                return {"ok": False, "error": "collector already running"}
            self._collector = self._collector_factory()
            self._collector.start()
        return {"ok": True}

    def stop_collector(self) -> dict:
        with self._lock:
            if self._collector is not None:
                self._collector.stop()
        return {"ok": True}

    def status(self) -> dict:
        with self._lock:
            col = self._collector
        cur = self.store.get_cursor(self.source_name)
        return {
            "running": bool(col and col.running),
            "completed": bool(col and col.completed),
            "error": col.error if col else None,
            "cursor": (
                {"last_event_id": cur[0], "contiguous": cur[1]} if cur else None
            ),
            "stats": self.store.stats(self.source_name),
        }

    @property
    def url(self) -> str:
        host, port = self.server_address[:2]
        return f"http://{host}:{port}/"

    def start_background(self) -> threading.Thread:
        t = threading.Thread(target=self.serve_forever, name="sse-control", daemon=True)
        t.start()
        return t
