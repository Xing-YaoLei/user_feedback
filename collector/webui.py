# -*- coding: utf-8 -*-
"""采集器查询配置页面（标准库 http.server 实现）。

页面提供：
* 查询配置表单（入口地址、表单名、按钮 value、业务字段、翻页参数等）；
* 后台提交采集任务并轮询状态；
* 结构化结果展示；
* 关联证据展示（敏感状态已遮盖）。
"""

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .config import QueryConfig
from .engine import CollectionEngine


def _parse_config_form(form: dict) -> QueryConfig:
    fields_raw = form.get("fields", "").strip()
    fields = {}
    if fields_raw:
        try:
            fields = json.loads(fields_raw)
            if not isinstance(fields, dict):
                raise ValueError
        except ValueError:
            # 兼容 key=value&key2=value2 写法
            fields = {k: v[0] for k, v in
                      parse_qs(fields_raw, keep_blank_values=True).items()}
    form_index_raw = form.get("form_index", "").strip()
    max_pages_raw = form.get("max_pages", "").strip()
    return QueryConfig(
        name=form.get("name", "").strip() or f"job-{uuid.uuid4().hex[:8]}",
        entry_url=form["entry_url"].strip(),
        form_name=form.get("form_name", "search").strip() or "search",
        form_index=int(form_index_raw) if form_index_raw else None,
        button_value=form.get("button_value", "search").strip() or "search",
        button_name=form.get("button_name", "btn").strip() or "btn",
        fields=fields,
        pager_form_name=form.get("pager_form_name", "pager").strip() or "pager",
        next_button_value=form.get("next_button_value", "next").strip() or "next",
        max_pages=int(max_pages_raw) if max_pages_raw else 10,
    )


CONFIG_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>传统表单采集器 · 查询配置</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; margin: 2rem; color: #222; }
  fieldset { margin-bottom: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  legend { font-weight: 600; padding: 0 .4rem; }
  label { display: block; margin: .4rem 0; }
  label span { display: inline-block; width: 11rem; color: #555; }
  input[type=text], input[type=number], textarea { width: 26rem; padding: .25rem; }
  textarea { height: 4rem; font-family: monospace; }
  button { padding: .45rem 1.2rem; background: #2b5; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
  .hint { color: #888; font-size: .85rem; }
  pre { background: #f6f6f6; padding: .8rem; border-radius: 6px; overflow: auto; max-height: 24rem; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ddd; padding: .25rem .5rem; font-size: .9rem; }
</style>
</head>
<body>
<h1>传统服务端表单采集器</h1>
<p class="hint">隐藏状态（viewstate/nonce）与 Cookie 由采集器按会话自动解析维护，
页面只配置业务字段；翻页仅使用页面提供的表单 action，不构造地址。</p>

<form method="post" action="/jobs">
  <fieldset>
    <legend>目标与表单</legend>
    <label><span>任务名称</span><input type="text" name="name" placeholder="my-query"></label>
    <label><span>站点入口 URL</span><input type="text" name="entry_url"
      value="http://127.0.0.1:8000/" required></label>
    <label><span>查询表单 name</span><input type="text" name="form_name" value="search"></label>
    <label><span>同名表单序号(可选)</span><input type="text" name="form_index"
      placeholder="留空则优先选择带隐藏状态的表单"></label>
  </fieldset>
  <fieldset>
    <legend>按钮参数（取自页面真实按钮）</legend>
    <label><span>按钮 name</span><input type="text" name="button_name" value="btn"></label>
    <label><span>按钮 value</span><input type="text" name="button_value" value="search"></label>
  </fieldset>
  <fieldset>
    <legend>查询业务字段</legend>
    <label><span>字段 JSON</span><textarea name="fields"
      placeholder='{"q": "键盘", "category": "电子"}'>{"q": "", "category": "全部"}</textarea></label>
  </fieldset>
  <fieldset>
    <legend>翻页</legend>
    <label><span>翻页表单 name</span><input type="text" name="pager_form_name" value="pager"></label>
    <label><span>下一页按钮 value</span><input type="text" name="next_button_value" value="next"></label>
    <label><span>最大页数</span><input type="number" name="max_pages" value="10" min="1"></label>
  </fieldset>
  <button type="submit">提交采集任务</button>
</form>

<h2>任务列表</h2>
<div id="jobs"><p class="hint">暂无任务</p></div>
<p><a href="/evidence">查看关联证据（敏感状态已遮盖）</a></p>

<script>
async function refresh() {
  const resp = await fetch('/jobs');
  const jobs = await resp.json();
  const box = document.getElementById('jobs');
  if (!jobs.length) { return; }
  box.innerHTML = '<table><tr><th>任务</th><th>状态</th><th>行数</th><th>页序</th>' +
    '<th>恢复次数</th><th>详情</th></tr>' +
    jobs.map(j => '<tr><td>' + j.query + '</td><td>' + j.status + '</td><td>' +
      (j.row_count || 0) + '</td><td>' + JSON.stringify(j.page_seq || []) + '</td><td>' +
      (j.recoveries || 0) + '</td><td><a href="/jobs/' + j.id + '">查看</a></td></tr>').join('') +
    '</table>';
}
refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>
"""


def _detail_page(job: dict) -> str:
    import html
    body = json.dumps(job, ensure_ascii=False, indent=2)
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>任务 {html.escape(job.get('query',''))}</title></head>
<body><h1>任务详情：{html.escape(job.get("query", ""))}</h1>
<p><a href="/">← 返回配置页</a> ｜ <a href="/evidence">关联证据</a></p>
<pre>{html.escape(body)}</pre></body></html>"""


class CollectorWebUI:
    def __init__(self, engine: CollectionEngine, host: str = "127.0.0.1", port: int = 8080):
        self.engine = engine
        self.host = host
        self.port = port
        self.jobs = {}
        self._lock = threading.Lock()

    def make_handler(self):
        ui = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "CollectorUI/1.0"

            def log_message(self, *_args):
                return

            def _send(self, status, body, content_type="text/html; charset=utf-8"):
                payload = body.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _read_form(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                return {k: v[0] for k, v in
                        parse_qs(raw, keep_blank_values=True).items()}

            def do_GET(self):
                path = urlparse(self.path).path
                if path == "/":
                    self._send(200, CONFIG_PAGE)
                elif path == "/jobs":
                    with ui._lock:
                        jobs = [dict(j, id=jid) for jid, j in ui.jobs.items()]
                    self._send(200, json.dumps(jobs, ensure_ascii=False),
                               "application/json; charset=utf-8")
                elif path.startswith("/jobs/"):
                    jid = path.split("/", 2)[2]
                    with ui._lock:
                        job = ui.jobs.get(jid)
                    if not job:
                        self._send(404, "<h1>任务不存在</h1>")
                        return
                    self._send(200, _detail_page(dict(job, id=jid)))
                elif path == "/evidence":
                    records = ui.engine.evidence.all_records()
                    self._send(200, json.dumps(records, ensure_ascii=False, indent=2),
                               "application/json; charset=utf-8")
                else:
                    self._send(404, "<h1>404</h1>")

            def do_POST(self):
                path = urlparse(self.path).path
                if path != "/jobs":
                    self._send(404, "<h1>404</h1>")
                    return
                try:
                    config = _parse_config_form(self._read_form())
                except (KeyError, ValueError) as exc:
                    self._send(400, f"<h1>配置无效</h1><pre>{exc}</pre>")
                    return
                jid = uuid.uuid4().hex
                with ui._lock:
                    ui.jobs[jid] = {"query": config.name, "status": "running"}
                threading.Thread(
                    target=ui._run_job, args=(jid, config), daemon=True
                ).start()
                self.send_response(303)
                self.send_header("Location", "/")
                self.end_headers()

        return Handler

    def _run_job(self, jid: str, config: QueryConfig):
        try:
            result = self.engine.run_one(config)
        except Exception as exc:  # noqa: BLE001 - 页面需要展示失败原因
            result = {"query": config.name, "status": "failed",
                      "error": f"{type(exc).__name__}: {exc}",
                      "rows": [], "row_count": 0, "page_seq": [],
                      "recoveries": 0, "chain_attempts": 0}
        with self._lock:
            self.jobs[jid] = result

    def serve_forever(self):
        httpd = ThreadingHTTPServer((self.host, self.port), self.make_handler())
        print(f"采集器配置页面运行在 http://{self.host}:{self.port}/")
        try:
            httpd.serve_forever()
        finally:
            httpd.server_close()
