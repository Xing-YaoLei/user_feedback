# -*- coding: utf-8 -*-
"""站点 HTTP 应用。

回发校验顺序（任何一步失败都作废会话并返回错误页）：
  1. Cookie 会话必须存在；
  2. _viewstate 必须与当前会话一致（旧值/他链值一律拒绝）；
  3. _nonce 必须与当前会话一致；
  4. 必须携带页面按钮参数 btn；
  5. 业务字段校验。
成功出页后立即轮转隐藏状态，使本响应里的状态只能使用一次。
"""

import json
import threading
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
from wsgiref.handlers import format_date_time

from . import data, pages
from .state import SessionStore

COOKIE_NAME = "ASID"


class SiteApp:
    def __init__(self, test_mode: bool = False):
        self.test_mode = test_mode
        self.sessions = SessionStore()
        self.access_log = []          # 服务端侧访问日志，便于测试断言关联
        # 全局变异开关：开启后所有会话的结果页数据行 ID 都带 X- 前缀，
        # 用于模拟“恢复后站点返回身份不同的结果”，不受会话重建影响
        self.global_mutate = False
        self._log_lock = threading.Lock()

    # ------------------------------------------------------------------ 工具
    def _record(self, req_id: str, method: str, path: str, sid: str, status: int):
        with self._log_lock:
            self.access_log.append(
                {"request_id": req_id, "method": method, "path": path,
                 "sid": sid or "", "status": status}
            )

    def make_handler(self):
        app = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "LegacyForms/1.0"

            def log_message(self, *_args):
                return  # 静默默认 stderr 日志，关联证据由采集端自己留存

            # ---- 响应辅助
            def _send(self, status: int, body: str, sid: str = "",
                      set_cookie: bool = False, content_type: str = "text/html; charset=utf-8"):
                req_id = self.headers.get("X-Request-Id") or uuid.uuid4().hex
                payload = body.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("X-Request-Id", req_id)
                self.send_header("Date", format_date_time(None))
                if set_cookie and sid:
                    self.send_header(
                        "Set-Cookie",
                        f"{COOKIE_NAME}={sid}; Path=/; HttpOnly",
                    )
                self.end_headers()
                self.wfile.write(payload)
                app._record(req_id, self.command, self.path.split("?", 1)[0], sid, status)

            def _send_json(self, status: int, obj):
                self._send(status, json.dumps(obj, ensure_ascii=False),
                           content_type="application/json; charset=utf-8")

            def _error(self, reason: str, sid: str, status: int = 400):
                self._send(status, pages.render_error(reason, status), sid)

            # ---- 请求读取
            def _read_form(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
                return {k: v[0] for k, v in parsed.items()}

            def _cookie_sid(self):
                cookie = SimpleCookie(self.headers.get("Cookie"))
                morsel = cookie.get(COOKIE_NAME)
                return morsel.value if morsel else ""

            # ---- GET
            def do_GET(self):
                sid = self._cookie_sid()
                path = self.path.split("?", 1)[0]
                if path == "/":
                    sess = app.sessions.get(sid)
                    fresh = sess is None
                    if fresh:
                        # 首次访问或会话已作废：建立全新会话并下发新 Cookie，
                        # 旧 Cookie 不复活、旧状态链不可恢复
                        sess = app.sessions.create()
                        sid = sess.sid
                    else:
                        sess.rotate()  # 入口刷新也轮转状态，旧链立即失效
                    self._send(200, pages.render_entry(sess), sid, set_cookie=fresh)
                    return
                if path == "/__test__/log":
                    if not app.test_mode:
                        self._error("测试控制端未启用", sid, 404)
                        return
                    with app._log_lock:
                        self._send_json(200, list(app.access_log))
                    return
                self._error(f"未知地址：{path}", sid, 404)

            # ---- POST
            def do_POST(self):
                sid = self._cookie_sid()
                path = self.path.split("?", 1)[0]
                form = self._read_form()

                if app.test_mode and path.startswith("/__test__/"):
                    self._handle_test_control(path, form, sid)
                    return

                if path == "/dead-end":
                    self._error("该表单不可用（同名诱饵表单）", sid, 404)
                    return

                if path not in ("/query", "/pager"):
                    self._error(f"未知回发地址：{path}", sid, 404)
                    return

                sess = app.sessions.get(sid)
                if sess is None:
                    self._error("会话不存在或已过期，请从入口重新进入", sid, 400)
                    return

                # 隐藏状态校验：一次性、错一个即作废整个会话
                if form.get("_viewstate") != sess.viewstate:
                    app.sessions.drop(sid)
                    self._error("viewstate 无效或已被使用，会话已作废", sid, 400)
                    return
                if form.get("_nonce") != sess.nonce:
                    app.sessions.drop(sid)
                    self._error("nonce 校验失败，会话已作废", sid, 400)
                    return
                if "btn" not in form:
                    app.sessions.drop(sid)
                    self._error("缺少按钮参数 btn，无法识别回发意图", sid, 400)
                    return

                if path == "/query":
                    self._handle_query(sess, form, sid)
                else:
                    self._handle_pager(sess, form, sid)

            # ---- 业务路由
            def _handle_query(self, sess, form, sid):
                if form["btn"] == "reset":
                    # 重置条件：回到入口表单（携带轮转后的新隐藏状态），不出结果页
                    sess.keyword = ""
                    sess.category = "全部"
                    sess.page = 0
                    sess.rotate()
                    self._send(200, pages.render_entry(sess), sid)
                    return
                if form["btn"] != "search":
                    app.sessions.drop(sid)
                    self._error(f"未知按钮值：{form['btn']}", sid, 400)
                    return
                keyword = form.get("q", "").strip()
                category = form.get("category", "全部").strip() or "全部"
                if category not in data.CATEGORIES:
                    app.sessions.drop(sid)
                    self._error(f"非法分类：{category}", sid, 400)
                    return
                sess.keyword = keyword
                sess.category = category
                sess.page = 1
                self._finish_page(sess, sid)

            def _handle_pager(self, sess, form, sid):
                if sess.page == 0:
                    app.sessions.drop(sid)
                    self._error("尚未发起查询，不能翻页", sid, 400)
                    return
                if form["btn"] not in ("next", "prev"):
                    app.sessions.drop(sid)
                    self._error(f"未知翻页按钮：{form['btn']}", sid, 400)
                    return
                rows = data.query_products(sess.keyword, sess.category)
                total_pages = max(1, (len(rows) + data.PAGE_SIZE - 1) // data.PAGE_SIZE)

                if form["btn"] == "next":
                    expected = sess.page + 1
                else:
                    expected = sess.page - 1
                declared = int(form.get("page") or 0)

                # 页序回退故障注入：服务端返回的页面与表单声明/当前顺序不符
                regress = sess.regress_next
                sess.regress_next = False
                if regress:
                    new_page = max(1, sess.page - 1)
                elif declared != expected:
                    app.sessions.drop(sid)
                    self._error(
                        f"页序异常：表单声明第 {declared} 页，期望第 {expected} 页", sid, 400
                    )
                    return
                elif not (1 <= expected <= total_pages):
                    app.sessions.drop(sid)
                    self._error(f"翻页越界：第 {expected} 页不存在", sid, 400)
                    return
                else:
                    new_page = expected
                sess.page = new_page
                self._finish_page(sess, sid)

            def _finish_page(self, sess, sid):
                rows = data.query_products(sess.keyword, sess.category)
                total_pages = max(1, (len(rows) + data.PAGE_SIZE - 1) // data.PAGE_SIZE)
                page_rows = data.page_slice(rows, sess.page) if rows else []
                # 一次性变异或全局变异（后者跨会话持续，用于恢复后身份校验）
                mutated = sess.mutate_next or app.global_mutate
                sess.mutate_next = False
                # 先轮转再渲染：页面中嵌入的必须是下一次回发可用的新状态，
                # 本次请求携带的旧状态在出页时即作废
                sess.rotate()
                body = pages.render_results(sess, page_rows, sess.page, total_pages, mutated)
                self._send(200, body, sid)

            # ---- 测试控制端
            def _handle_test_control(self, path, form, sid):
                if not app.test_mode:
                    self._error("测试控制端未启用", sid, 404)
                    return
                sess = app.sessions.get(sid)
                if sess is None:
                    self._error("控制端需要先建立会话（携带 Cookie）", sid, 400)
                    return
                if path == "/__test__/expire":
                    app.sessions.drop(sid)
                    self._send_json(200, {"ok": True, "action": "expire", "sid": sid})
                elif path == "/__test__/regress":
                    sess.regress_next = True
                    self._send_json(200, {"ok": True, "action": "regress"})
                elif path == "/__test__/mutate":
                    # 全局变异：模拟“恢复后站点返回了身份不同的结果”，
                    # 之后所有会话结果页的数据行 ID 都带 X- 前缀。
                    # 表单参数 off=1 可显式关闭。
                    if form.get("off") == "1":
                        app.global_mutate = False
                    else:
                        app.global_mutate = True
                        sess.mutate_next = True
                    self._send_json(200, {"ok": True, "action": "mutate",
                                          "global_mutate": app.global_mutate})
                elif path == "/__test__/reset":
                    # 只清理当前会话的一次性标志，全局变异保持不变
                    sess.regress_next = False
                    sess.mutate_next = False
                    self._send_json(200, {"ok": True, "action": "reset"})
                else:
                    self._error(f"未知测试控制：{path}", sid, 404)

        return Handler


def build_server(host: str = "127.0.0.1", port: int = 8000, test_mode: bool = False):
    app = SiteApp(test_mode=test_mode)
    httpd = ThreadingHTTPServer((host, port), app.make_handler())
    return httpd, app
