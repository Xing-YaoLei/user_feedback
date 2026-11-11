"""本地测试站：按 manifest 以（可能错误的）Content-Type 提供样本页面。"""
from __future__ import annotations

import http.server
import json
from pathlib import Path


def make_handler(site_dir: str | Path):
    site_dir = Path(site_dir)
    manifest = {e['file']: e for e in json.loads(
        (site_dir / 'manifest.json').read_text('utf-8'))}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            name = self.path.lstrip('/').split('?')[0] or 'index'
            if name == 'index':
                body = ('<html><head><meta charset="utf-8"><title>样本站</title></head>'
                        '<body><h1>编码样本站</h1>'
                        + ''.join(f'<a href="/{f}">{f}</a> — {e["description"]}<br>'
                                  for f, e in manifest.items())
                        + '</body></html>').encode('utf-8')
                content_type = 'text/html; charset=utf-8'
            elif name in manifest:
                body = (site_dir / name).read_bytes()
                content_type = manifest[name]['content_type']
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Handler


def make_server(site_dir: str | Path, port: int = 8765):
    return http.server.ThreadingHTTPServer(
        ('127.0.0.1', port), make_handler(site_dir))


def serve(site_dir: str | Path, port: int = 8765):
    server = make_server(site_dir, port)
    print(f'样本站运行于 http://127.0.0.1:{server.server_address[1]}/')
    server.serve_forever()
