"""排错页面：标准库 http.server 实现，无额外 Web 依赖。

路由：
  /                 单页排障面板（自动刷新）
  /api/state        全部运行态 JSON（统计/设备/最近测量/缺口/过载/事件流）
  /healthz          存活探针
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .collector import Collector
from .storage import Storage

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>MQTT 遥测采集 · 排障面板</title>
<style>
  :root { --bg:#0f1420; --card:#18202f; --line:#27324a; --fg:#dce4f2;
          --muted:#8391ad; --ok:#37d399; --warn:#f5b942; --err:#ff6b6b; --accent:#5aa2ff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--muted); margin-bottom:18px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
          gap:12px; margin-bottom:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:14px; }
  .card .k { color:var(--muted); font-size:12px; }
  .card .v { font-size:24px; font-weight:650; margin-top:4px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; }
  .on { background:var(--ok); } .off { background:var(--err); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line);
          vertical-align:top; }
  th { color:var(--muted); font-weight:500; position:sticky; top:0; background:var(--card); }
  .section { background:var(--card); border:1px solid var(--line); border-radius:10px;
             padding:14px; margin-bottom:16px; }
  .section h2 { font-size:14px; margin:0 0 10px; }
  .badge { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px;
           background:#233; color:var(--accent); border:1px solid var(--line);
           margin-right:4px; white-space:nowrap; }
  .badge.ok { color:var(--ok); } .badge.anomaly { color:var(--warn); }
  .badge.snap { color:#c792ea; } .badge.err { color:var(--err); }
  .scroll { max-height:340px; overflow:auto; }
  code { color:#a5d6ff; }
  .muted { color:var(--muted); }
  .expl { color:var(--warn); }
</style>
</head>
<body>
<h1>MQTT 遥测采集 · 排障面板</h1>
<div class="sub" id="conn">加载中…</div>

<div class="grid" id="stats"></div>

<div class="section">
  <h2>设备状态（当前 boot / 最后序号 / 单位 / 设备时钟）</h2>
  <div class="scroll"><table id="devices"></table></div>
</div>

<div class="section">
  <h2>最近测量（原值与标准值并列；异常带解释）</h2>
  <div class="scroll"><table id="meas"></table></div>
</div>

<div class="section">
  <h2>序号缺口</h2>
  <div class="scroll"><table id="gaps"></table></div>
</div>

<div class="section">
  <h2>过载事件（背压丢弃）与运行事件流</h2>
  <div class="scroll"><table id="over"></table></div>
  <h2 style="margin-top:14px">事件流</h2>
  <div class="scroll"><table id="events"></table></div>
</div>

<script>
const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const row = cells => "<tr>" + cells.map(c => `<td>${c}</td>`).join("") + "</tr>";
const head = cols => "<tr>" + cols.map(c => `<th>${c}</th>`).join("") + "</tr>";

async function refresh() {
  const r = await fetch("/api/state");
  const s = await r.json();
  const c = s.counters, st = s.stats;
  document.getElementById("conn").innerHTML =
    `<span class="dot ${c.connected ? "on":"off"}"></span>` +
    `${c.connected ? "已连接" : "未连接"} broker · 连接次数 ${c.connect_count} · ` +
    `session_present=${c.session_present} · 刷新于 ${new Date().toLocaleTimeString()}`;

  const cards = [
    ["新测量", st.measurements_total, ""], ["网络重复", st.duplicates, ""],
    ["retained 快照", st.snapshots, ""], ["异常测量", st.anomalies, ""],
    ["缺口事件", st.gap_events, ""], ["累计缺失条数", st.gap_missing_total, ""],
    ["过载丢弃", c.overload_dropped, ""], ["协议错误", c.protocol_errors, ""],
    ["队列已用/上限", `${s.queue_size}/${s.queue_max}`, ""], ["设备数", st.devices, ""],
  ];
  document.getElementById("stats").innerHTML = cards.map(([k,v]) =>
    `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  document.getElementById("devices").innerHTML = head(
    ["device","boot_id","last_seq","unit","device_ts","seen","updated"]) +
    s.devices.map(d => row([
      `<code>${esc(d.device_id)}</code>`, `<code>${esc(d.boot_id.slice(0,8))}…</code>`,
      d.last_seq, esc(d.last_unit), new Date(d.last_device_ts*1000).toLocaleTimeString(),
      d.seen_count, new Date(d.updated_ts*1000).toLocaleTimeString()])).join("")
    || `<tr><td class="muted">暂无</td></tr>`;

  document.getElementById("meas").innerHTML = head(
    ["device / boot / seq","原值","标准值","device_ts","retain","状态/标记","解释"]) +
    s.recent.map(m => row([
      `<code>${esc(m.device_id)}/${esc(m.boot_id.slice(0,8))}/${m.seq}</code>`,
      `${m.value} ${esc(m.unit)}`,
      `${Number(m.canonical_value).toFixed(3)} ${esc(m.canonical_unit)}`,
      new Date(m.device_ts*1000).toLocaleTimeString(),
      m.retained ? "是" : "—",
      `<span class="badge ${m.status==="ok"?"ok":m.status==="anomaly"?"anomaly":"snap"}">${esc(m.status)}</span>`
        + (m.flags ? esc(m.flags).split(",").filter(Boolean)
            .map(f=>`<span class="badge">${esc(f)}</span>`).join("") : ""),
      `<span class="expl">${esc(m.explanation)}</span>`])).join("")
    || `<tr><td class="muted">暂无</td></tr>`;

  document.getElementById("gaps").innerHTML = head(
    ["device","boot_id","期望 seq","实际 seq","缺失条数","原因","详情","时间"]) +
    s.gaps.map(g => row([
      `<code>${esc(g.device_id)}</code>`, `<code>${esc(g.boot_id.slice(0,8))}…</code>`,
      g.expected_seq, g.observed_seq, g.missing_count, esc(g.reason), esc(g.detail),
      new Date(g.created_ts*1000).toLocaleTimeString()])).join("")
    || `<tr><td class="muted">暂无缺口</td></tr>`;

  document.getElementById("over").innerHTML = head(
    ["时间","队列大小","被丢弃的身份"]) +
    s.overloads.map(o => row([
      new Date(o.created_ts*1000).toLocaleTimeString(), o.queue_size,
      `<code>${esc(o.identity)}</code>`])).join("")
    || `<tr><td class="muted">暂无过载</td></tr>`;

  document.getElementById("events").innerHTML = head(["时间","事件"]) +
    c.recent_events.slice().reverse().map(([ts,txt]) =>
      row([new Date(ts*1000).toLocaleTimeString(), esc(txt)])).join("");
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>"""


class DashboardHandler(BaseHTTPRequestHandler):
    collector: Collector = None  # 由 make_server 注入
    storage: Storage = None

    def log_message(self, fmt, *args):  # 静默默认访问日志
        pass

    def _send(self, code, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self._send(200, b"ok", "text/plain")
        elif path == "/":
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/api/state":
            c = self.collector
            payload = {
                "stats": self.storage.stats(),
                "devices": self.storage.devices(),
                "recent": self.storage.recent_measurements(60),
                "gaps": self.storage.gaps(),
                "overloads": self.storage.overloads(),
                "queue_size": c._queue.qsize(),
                "queue_max": c.cfg.queue_max,
                "counters": {
                    "received": c.counters.received,
                    "enqueued": c.counters.enqueued,
                    "overload_dropped": c.counters.overload_dropped,
                    "protocol_errors": c.counters.protocol_errors,
                    "new_measurements": c.counters.new_measurements,
                    "duplicates": c.counters.duplicates,
                    "snapshots": c.counters.snapshots,
                    "connected": c.counters.connected,
                    "session_present": c.counters.session_present,
                    "connect_count": c.counters.connect_count,
                    "recent_events": c.counters.recent_events,
                },
            }
            self._send(200, json.dumps(payload, ensure_ascii=False).encode(),
                       "application/json")
        else:
            self._send(404, b"not found", "text/plain")


def make_server(host: str, port: int, collector: Collector,
                storage: Storage) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (DashboardHandler,),
                   {"collector": collector, "storage": storage})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd


def serve_in_thread(httpd: ThreadingHTTPServer) -> threading.Thread:
    t = threading.Thread(target=httpd.serve_forever, name="dashboard", daemon=True)
    t.start()
    return t
