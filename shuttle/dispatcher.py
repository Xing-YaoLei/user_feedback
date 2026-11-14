"""调度员查看页面：各园区运行状态与最近一次成功快照。

- GET /            可读 HTML 页面（2 秒自动刷新）
- GET /api/status  各园区调度状态 JSON
- GET /api/snapshots  各园区最近一次成功快照 JSON
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .poller import Scheduler

_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>班车到站监控</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 24px; background: #f6f7f9; color: #1c2330; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
  .card { background: #fff; border: 1px solid #d9dde4; border-radius: 10px; padding: 14px 16px; }
  .card h2 { font-size: 16px; margin: 0 0 8px; display: flex; justify-content: space-between; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .ok { background: #e3f6e8; color: #146c2e; }
  .busy { background: #fff3d6; color: #8a5a00; }
  .warn { background: #fde4e1; color: #a1261b; }
  .muted { color: #6b7280; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td { padding: 3px 0; vertical-align:: top; }
  td:first-child { color: #6b7280; width: 110px; }
  pre { margin: 8px 0 0; background: #f2f4f7; border-radius: 6px; padding: 8px;
        font-size: 12px; overflow: auto; max-height: 260px; }
  .none { color: #9aa1ac; font-style: italic; }
  @media (prefers-color-scheme: dark) {
    body { background: #15181d; color: #e6e9ee; }
    .card { background: #1f242c; border-color: #303743; }
    .ok { background: #173d24; color: #7ee2a0; }
    .busy { background: #3d3113; color: #ffcf7a; }
    .warn { background: #40201c; color: #ff9d92; }
    pre { background: #14181d; }
  }
</style>
</head>
<body>
<h1>园区班车到站监控 <span class="muted">（每 2 秒自动刷新）</span></h1>
<div class="grid">__CARDS__</div>
</body>
</html>"""

_CARD = """
<div class="card">
  <h2><span>{park_id}</span><span class="badge {cls}">{badge}</span></h2>
  <table>
    <tr><td>最近状态</td><td>{last_status}</td></tr>
    <tr><td>下次请求</td><td>{next_due}s 后</td></tr>
    <tr><td>ETag</td><td>{etag}</td></tr>
    <tr><td>快照时间</td><td>{snapshot_time}</td></tr>
    <tr><td>检查时间</td><td>{check_time}</td></tr>
    <tr><td>失败次数</td><td>{failures}</td></tr>
    <tr><td>计数</td><td>{counters}</td></tr>
    <tr><td>错误</td><td>{error}</td></tr>
  </table>
  <pre>{snapshot}</pre>
</div>"""


class _Handler(BaseHTTPRequestHandler):
    server_version = "ShuttleDispatcher/1.0"

    @property
    def scheduler(self) -> Scheduler:
        return self.server.scheduler  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    def _send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, html: str) -> None:
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/status":
            self._send_json(200, {"parks": self.scheduler.status()})
        elif path == "/api/snapshots":
            self._send_json(200, {"snapshots": self.scheduler.snapshot_view()})
        elif path == "/":
            self._send_html(self._render())
        else:
            self._send_json(404, {"error": "not found"})

    def _render(self) -> str:
        import datetime

        cards: list[str] = []
        snapshots = self.scheduler.snapshot_view()
        for row in self.scheduler.status():
            if row["in_flight"]:
                cls, badge = "busy", "请求在途"
            elif row["last_status"] in (429, "timeout") or (
                isinstance(row["last_status"], int) and row["last_status"] >= 500
            ):
                cls, badge = "warn", "退避中"
            elif row["has_snapshot"]:
                cls, badge = "ok", "正常"
            else:
                cls, badge = "busy", "等待数据"

            def fmt_time(ts: float | None) -> str:
                if not ts:
                    return "—"
                return datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S")

            snap = snapshots.get(row["park_id"])
            snap_text = (
                json.dumps(snap["body"], ensure_ascii=False, indent=2)
                if snap
                else '<span class="none">尚无成功快照</span>'
            )
            counters = row["counters"]
            counter_text = (
                f"请求 {counters['requests']}｜200 {counters['ok']}｜304 {counters['not_modified']}"
                f"｜429 {counters['rate_limited']}｜5xx {counters['server_error']}"
                f"｜超时 {counters['timeout']}｜错误 {counters['error']}"
            )
            cards.append(
                _CARD.format(
                    park_id=row["park_id"],
                    cls=cls,
                    badge=badge,
                    last_status=row["last_status"] if row["last_status"] is not None else "—",
                    next_due=row["next_due_in_seconds"],
                    etag=row["etag"] or "—",
                    snapshot_time=fmt_time(row["snapshot_fetched_at"]),
                    check_time=fmt_time(row["last_check_at"]),
                    failures=row["consecutive_failures"],
                    counters=counter_text,
                    error=row["last_error"] or "—",
                    snapshot=snap_text,
                )
            )
        return _PAGE.replace("__CARDS__", "".join(cards))


class DispatcherServer:
    def __init__(self, scheduler: Scheduler, host: str = "127.0.0.1", port: int = 0) -> None:
        self._httpd = ThreadingHTTPServer((host, port), _Handler)
        self._httpd.scheduler = scheduler  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="dispatcher-http", daemon=True)

    @property
    def address(self) -> tuple[str, int]:
        host, port = self._httpd.server_address[:2]
        return str(host), int(port)

    @property
    def url(self) -> str:
        host, port = self.address
        return f"http://{host}:{port}/"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)
