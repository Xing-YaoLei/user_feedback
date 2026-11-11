"""查看页面：引用图 + 缺口一览。

启动：python viewer.py [db_path] [port]
页面包含：
- 运行列表及状态（complete / partial）
- 引用图（按从根出发的层深布局的 SVG，缺失对象以虚线红框标出）
- 缺口表（not_found / deleted / fetch_failed / version_mismatch）
"""
import html
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import db as dbmod
import queries

TYPE_COLOR = {"dataset": "#2563eb", "author": "#059669",
              "instrument": "#d97706", "method": "#7c3aed"}


def _layout(graph):
    """按 BFS 层深给节点布局，返回 {key: (x, y)}。"""
    nodes = {(o["type"], o["id"], o["version"]) for o in graph["objects"]}
    for g in graph["gaps"]:
        nodes.add((g["to_type"], g["to_id"], g["to_version"]))
    adj = {}
    for e in graph["edges"]:
        src = (e["from_type"], e["from_id"], e["from_version"])
        dst = (e["to_type"], e["to_id"], e["to_version"])
        adj.setdefault(src, []).append(dst)
    depth = {}
    frontier = [(r["type"], r["id"], r["version"]) for r in graph["roots"]]
    for r in frontier:
        depth[r] = 0
    while frontier:
        nxt = []
        for n in frontier:
            for m in adj.get(n, []):
                if m not in depth:
                    depth[m] = depth[n] + 1
                    nxt.append(m)
        frontier = nxt
    for n in nodes:  # 不可达节点放最后一列
        depth.setdefault(n, (max(depth.values()) + 1) if depth else 0)
    by_depth = {}
    for n, d in depth.items():
        by_depth.setdefault(d, []).append(n)
    pos = {}
    for d, ns in by_depth.items():
        for i, n in enumerate(sorted(ns)):
            pos[n] = (80 + d * 220, 60 + i * 90)
    return pos, nodes


def render_page(graph):
    pos, nodes = _layout(graph)
    width = max((p[0] for p in pos.values()), default=100) + 220
    height = max((p[1] for p in pos.values()), default=100) + 80
    gap_keys = {(g["to_type"], g["to_id"], g["to_version"]) for g in graph["gaps"]}

    parts = []
    # 边
    for e in graph["edges"]:
        src = (e["from_type"], e["from_id"], e["from_version"])
        dst = (e["to_type"], e["to_id"], e["to_version"])
        if src in pos and dst in pos:
            x1, y1 = pos[src]
            x2, y2 = pos[dst]
            parts.append(
                f'<line x1="{x1+150}" y1="{y1+20}" x2="{x2}" y2="{y2+20}" '
                f'stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow)"/>'
                f'<text x="{(x1+x2)/2+75}" y="{(y1+y2)/2+14}" font-size="10" '
                f'fill="#64748b">{html.escape(e["role"])}</text>')
    # 节点
    for n, (x, y) in pos.items():
        t, i, v = n
        missing = n in gap_keys
        color = TYPE_COLOR.get(t, "#475569")
        style = (f'fill="#fff" stroke="#dc2626" stroke-width="2" '
                 f'stroke-dasharray="5,3"') if missing else \
                f'fill="{color}" fill-opacity="0.12" stroke="{color}" stroke-width="2"'
        parts.append(
            f'<rect x="{x}" y="{y}" width="150" height="40" rx="8" {style}/>'
            f'<text x="{x+8}" y="{y+17}" font-size="11" fill="#0f172a">'
            f'{html.escape(t)}:{html.escape(i)}</text>'
            f'<text x="{x+8}" y="{y+32}" font-size="10" fill="#64748b">v{v}'
            f'{"（未解析）" if missing else ""}</text>')

    svg = (f'<svg width="{width}" height="{height}" '
           f'xmlns="http://www.w3.org/2000/svg">'
           f'<defs><marker id="arrow" markerWidth="8" markerHeight="8" '
           f'refX="7" refY="3" orient="auto">'
           f'<path d="M0,0 L7,3 L0,6 z" fill="#94a3b8"/></marker></defs>'
           + "".join(parts) + "</svg>")

    run_rows = "".join(
        f"<tr><td>{r['run_id']}</td><td>{r['status']}</td>"
        f"<td>{html.escape(r['stats'] or '')}</td></tr>"
        for r in graph["runs"])
    gap_rows = "".join(
        f"<tr><td>{g['run_id']}</td><td>{html.escape(g['reason'])}</td>"
        f"<td>{g['to_type']}:{g['to_id']}:v{g['to_version']}</td>"
        f"<td>{html.escape(g['detail'] or '')}</td></tr>"
        for g in graph["gaps"])

    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>引用图与缺口</title>
<style>body{{font-family:system-ui;margin:24px;color:#0f172a}}
h1{{font-size:20px}}h2{{font-size:16px;margin-top:28px}}
table{{border-collapse:collapse}}td,th{{border:1px solid #cbd5e1;
padding:4px 10px;font-size:13px}}</style></head><body>
<h1>科研数据目录 · 引用图与缺口</h1>
<h2>采集运行</h2>
<table><tr><th>run</th><th>状态</th><th>统计</th></tr>{run_rows}</table>
<h2>引用图（虚线红框 = 未解析引用）</h2>
{svg}
<h2>缺口</h2>
<table><tr><th>run</th><th>原因</th><th>目标</th><th>详情</th></tr>{gap_rows}</table>
</body></html>"""


def serve(db_path, port=8000):
    if db_path == ":memory:":
        raise SystemExit("查看页面需要文件数据库，请先运行 demo.py 生成 catalog.db")
    conn = sqlite3.connect(db_path, check_same_thread=False)  # 只读，跨线程安全
    conn.row_factory = sqlite3.Row
    db = dbmod.DB.__new__(dbmod.DB)  # 复用查询方法，不重建 schema
    db.conn = conn

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = render_page(queries.graph_data(db)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"查看页面: http://127.0.0.1:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    import sys
    serve(sys.argv[1] if len(sys.argv) > 1 else "catalog.db",
          int(sys.argv[2]) if len(sys.argv) > 2 else 8000)
