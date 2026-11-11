"""测试目录接口（http.server 实现）+ 样例数据。

样例覆盖四类情形：
- 共享引用：ds1、ds2 共用作者 a1 与方法 m1（同一对象同一版本只应抓取一次）。
- 循环引用：instrument i1 <-> method m1；作者 a1 <-> a2（合作者环）。
- 删除/缺失：aGone 返回 410（已删除），iMissing 返回 404。
- 版本变化：ds3 与方法 m2 清单标 v1，服务端只存在 v2（返回版本与请求不符）。
- 局部故障：iFlaky 前两次 503 后恢复（重试成功）；iDown 永远 500
  （该分支失败，但不得波及其他分支入库）。
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


def build_catalog():
    """返回 {(type,id,version): {"data":..., "refs":[...]}} 与行为配置。"""
    def ref(t, i, v, role=None):
        r = {"type": t, "id": i, "version": v}
        if role:
            r["role"] = role
        return r

    def obj(data, refs):
        # refs_meta 放入 data，供采集器确定引用边角色
        return {"data": {**data, "refs_meta": [r for r in refs if "role" in r]},
                "refs": [{k: r[k] for k in ("type", "id", "version")} for r in refs]}

    catalog = {
        ("dataset", "ds1", 1): obj(
            {"title": "地表温度观测 2024"},
            [ref("author", "a1", 1, "author"),
             ref("instrument", "i1", 1, "instrument"),
             ref("method", "m1", 1, "method")]),
        ("dataset", "ds2", 1): obj(
            {"title": "大气 CO2 浓度 2024"},
            [ref("author", "a1", 1, "author"),      # 与 ds1 共享作者
             ref("method", "m1", 1, "method"),      # 与 ds1 共享方法
             ref("author", "aGone", 1, "author")]),  # 已删除 -> 410
        ("dataset", "ds3", 1): obj(
            {"title": "降水再分析 2024"},
            [ref("instrument", "iMissing", 1, "instrument"),  # 不存在 -> 404
             ref("method", "m2", 1, "method"),                # 版本漂移 -> 返回 v2
             ref("instrument", "iFlaky", 1, "instrument"),    # 前两次 503
             ref("instrument", "iDown", 1, "instrument")]),   # 永远 500
        # 注意：ds4 在清单里标 v1，服务端实际只存在 v2 —— 版本不符场景
        ("dataset", "ds4", 2): obj(
            {"title": "土壤湿度产品 2024"},
            [ref("author", "a2", 1, "author")]),
        ("author", "a1", 1): obj(
            {"name": "Lin Wang", "affiliation": "Institute A"},
            [ref("author", "a2", 1, "collaborator")]),
        ("author", "a2", 1): obj(
            {"name": "Ada Chen", "affiliation": "Institute B"},
            [ref("author", "a1", 1, "collaborator")]),   # 作者环 a1<->a2
        ("instrument", "i1", 1): obj(
            {"name": "Radiometer X", "serial": "RX-7"},
            [ref("method", "m1", 1, "calibrated_by")]),  # 仪器->方法
        ("method", "m1", 1): obj(
            {"name": "Split-window algorithm"},
            [ref("instrument", "i1", 1, "requires")]),   # 方法->仪器：成环
        # 注意：m2 只有 v2，清单里却写 v1 —— 版本不符场景
        ("method", "m2", 2): obj({"name": "Bias-corrected downscaling v2"}, []),
        ("instrument", "iFlaky", 1): obj({"name": "Tipping-bucket gauge"}, []),
        # iDown 故意不在 catalog 中，由行为配置强制 500
    }

    behavior = {
        # 清单中 ds4 / m2 标 v1，服务端实际只提供 v2 -> 版本不符
        "version_override": {("dataset", "ds4", 1): 2, ("method", "m2", 1): 2},
        "deleted": {("author", "aGone", 1)},                       # -> 410
        "always_fail": {("instrument", "iDown", 1)},               # -> 500
        "flaky": {("instrument", "iFlaky", 1): 2},                 # 前 2 次 503
    }
    return catalog, behavior


DATASETS = [("dataset", "ds1", 1), ("dataset", "ds2", 1),
            ("dataset", "ds3", 1), ("dataset", "ds4", 1)]


def make_handler(catalog, behavior):
    counters = {"flaky": {}}

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/api/reset":
                counters["flaky"].clear()  # 让每个测试/运行看到相同的故障序列
                self._send(200, {"ok": True})
                return
            if parsed.path == "/api/datasets":
                self._send(200, {"objects": [
                    {"type": t, "id": i, "version": v} for t, i, v in DATASETS]})
                return
            if parsed.path == "/api/object":
                q = parse_qs(parsed.query)
                key = (q["type"][0], q["id"][0], int(q["version"][0]))
                if key in behavior["always_fail"]:
                    self._send(500, {"error": "internal error"})
                    return
                if key in behavior["flaky"]:
                    n = counters["flaky"].get(key, 0)
                    counters["flaky"][key] = n + 1
                    if n < behavior["flaky"][key]:
                        self._send(503, {"error": "temporarily unavailable"})
                        return
                if key in behavior["deleted"]:
                    self._send(410, {"error": "gone"})
                    return
                # 版本覆盖优先：请求的版本不存在，但对象以别的版本存在
                override = behavior["version_override"].get(key)
                if override is not None and (key[0], key[1], override) in catalog:
                    real = catalog[(key[0], key[1], override)]
                    self._send(200, {"type": key[0], "id": key[1],
                                     "version": override, **real})
                    return
                entry = catalog.get(key)
                if entry is None:
                    self._send(404, {"error": "not found"})
                    return
                self._send(200, {"type": key[0], "id": key[1],
                                 "version": key[2], **entry})
                return
            self._send(404, {"error": "unknown path"})

        def log_message(self, *args):
            pass  # 静默

    return Handler


def serve(port=0):
    """启动测试接口，返回 (server, base_url)。"""
    catalog, behavior = build_catalog()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(catalog, behavior))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"
