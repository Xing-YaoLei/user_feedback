#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地模拟巡检门户（纯标准库实现）。

能力：
1. 网页表单录入：GET / 提供录入表单，POST /submit 以 application/x-www-form-urlencoded 接收。
2. 查询页：GET /query?order_no=... 返回 HTML，记录放在带 data-* 属性的 div 中，便于程序读取。
3. 按巡检单号只登记一次：order_no 为主键，重复提交返回 409，永不覆盖已有记录。
4. 故障注入（一次性，触发后自动解除）：
   - pre_write_timeout       写入前超时：先睡死超过客户端超时，且不写库，随后返回 504。
   - post_write_receipt_lost 写入后回执丢失：先写库提交，再睡死并直接断开连接，不返回任何回执。
5. 管理接口：GET/POST /admin/faults 配置故障，GET /admin 查看登记情况，POST /admin/reset 清空记录。

数据持久化在 --data-dir 下的 SQLite 文件中，进程重启后记录仍在。
"""

import argparse
import csv
import html
import json
import os
import sqlite3
import sys
import threading
import time
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# 表单字段名（与批量程序、CSV 表头保持一致）
F_ORDER = "巡检单号"
F_DEVICE = "设备编号"
F_DATE = "巡检日期"
F_CONCLUSION = "结论"
F_INSPECTOR = "巡检员"
F_REMARK = "备注"

VALID_CONCLUSIONS = {"合格", "不合格", "待复检"}

# 全局运行状态（由 main 注入）
DB_PATH = None
FAULT_PATH = None
FAULT_LOCK = threading.RLock()
FAULT_DELAY = 8.0


# ---------------------------------------------------------------- 数据层

def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                order_no     TEXT PRIMARY KEY,
                device_no    TEXT NOT NULL,
                inspect_date TEXT NOT NULL,
                conclusion   TEXT NOT NULL,
                inspector    TEXT,
                remark       TEXT,
                receipt_no   TEXT NOT NULL,
                created_at   TEXT NOT NULL
            )
            """
        )


def load_faults():
    if not os.path.exists(FAULT_PATH):
        return {"pre_write_timeout": {}, "post_write_receipt_lost": {},
                "fault_delay": FAULT_DELAY}
    with open(FAULT_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    # 兼容旧版列表格式：单号 -> 窗口过期时间戳（None 表示尚未触发）
    for key in ("pre_write_timeout", "post_write_receipt_lost"):
        val = data.setdefault(key, {})
        if isinstance(val, list):
            data[key] = {str(x): None for x in val}
    data.setdefault("fault_delay", FAULT_DELAY)
    return data


def save_faults(cfg):
    tmp = FAULT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, FAULT_PATH)


def consume_fault(order_no):
    """
    返回 (故障类型或None, 休眠秒数)。

    故障窗口模型：首次命中时记录“激活到 现在+休眠时长”，窗口内对该单号的
    任何请求（含客户端超时后的立即重试）都持续命中；窗口过后自动解除，
    因此正常重跑时故障一定已经消失。每个故障只对一个单号生效一次完整窗口。
    """
    with FAULT_LOCK:
        cfg = load_faults()
        delay = float(cfg["fault_delay"])
        now = time.time()
        changed = False
        for fault_type in ("pre_write_timeout", "post_write_receipt_lost"):
            entries = cfg[fault_type]
            # 清理已过期的窗口
            for expired in [o for o, exp in entries.items()
                            if exp is not None and now >= exp]:
                del entries[expired]
                changed = True
            if order_no not in entries:
                continue
            expire_at = entries[order_no]
            if expire_at is None:
                expire_at = now + delay
                entries[order_no] = expire_at
                changed = True
            if now < expire_at:
                if changed:
                    save_faults(cfg)
                return fault_type, delay
        if changed:
            save_faults(cfg)
        return None, delay


def next_receipt(conn, now):
    count = conn.execute("SELECT COUNT(*) AS c FROM records").fetchone()["c"]
    return "HZ-%s-%05d" % (time.strftime("%Y%m%d", now), count + 1)


def seed_from_csv(seed_path):
    """启动时预置记录（用于内容冲突等场景），已存在的单号跳过。"""
    if not seed_path or not os.path.exists(seed_path):
        return 0
    n = 0
    with open(seed_path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            order_no = (row.get(F_ORDER) or "").strip()
            if not order_no:
                continue
            with FAULT_LOCK, db_connect() as conn:
                exists = conn.execute(
                    "SELECT 1 FROM records WHERE order_no=?", (order_no,)
                ).fetchone()
                if exists:
                    continue
                now = time.strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    "INSERT INTO records VALUES (?,?,?,?,?,?,?,?)",
                    (order_no, (row.get(F_DEVICE) or "").strip(),
                     (row.get(F_DATE) or "").strip(),
                     (row.get(F_CONCLUSION) or "").strip(),
                     (row.get(F_INSPECTOR) or "").strip(),
                     (row.get(F_REMARK) or "").strip(),
                     next_receipt(conn, time.localtime()), now),
                )
                n += 1
    return n


# ---------------------------------------------------------------- 校验

def server_validate(fields):
    errs = []
    order_no = fields.get(F_ORDER, "")
    device = fields.get(F_DEVICE, "")
    date_s = fields.get(F_DATE, "")
    conclusion = fields.get(F_CONCLUSION, "")
    if not order_no:
        errs.append("巡检单号为空")
    elif len(order_no) > 40:
        errs.append("巡检单号超长")
    if not device:
        errs.append("设备编号为空")
    if not date_s:
        errs.append("巡检日期为空")
    else:
        try:
            time.strptime(date_s, "%Y-%m-%d")
        except ValueError:
            errs.append("巡检日期不是 YYYY-MM-DD: %r" % date_s)
    if conclusion not in VALID_CONCLUSIONS:
        errs.append("结论非法: %r（允许：合格/不合格/待复检）" % conclusion)
    return errs


# ---------------------------------------------------------------- HTML

PAGE_CSS = """
body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
       margin: 32px; color: #1f2933; background: #fafafa; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
table { border-collapse: collapse; background: #fff; }
th, td { border: 1px solid #cbd2d9; padding: 6px 10px; font-size: 13px; }
th { background: #f0f4f8; }
form { background: #fff; padding: 16px; border: 1px solid #cbd2d9; max-width: 520px; }
label { display: block; margin: 8px 0 2px; font-size: 13px; }
input, select { width: 100%; padding: 6px; box-sizing: border-box; }
button { margin-top: 14px; padding: 8px 18px; }
.nav a { margin-right: 14px; font-size: 13px; }
.note { color: #7b8794; font-size: 12px; }
"""


def page(title, body):
    return (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        "<title>%s</title><style>%s</style></head><body>"
        "<div class='nav'><a href='/'>录入表单</a>"
        "<a href='/query'>查询页</a><a href='/admin'>管理后台</a></div>"
        "<h1>%s</h1>%s</body></html>"
    ) % (html.escape(title), PAGE_CSS, html.escape(title), body)


def record_div(rec, div_id="query-result"):
    """把记录渲染成带 data-* 的 div，批量程序靠这些属性读取登记内容与回执。"""
    attrs = {
        "id": div_id,
        "data-found": "1",
        "data-order-no": rec["order_no"],
        "data-device-no": rec["device_no"],
        "data-inspect-date": rec["inspect_date"],
        "data-conclusion": rec["conclusion"],
        "data-inspector": rec["inspector"] or "",
        "data-receipt-no": rec["receipt_no"],
        "data-created-at": rec["created_at"],
    }
    attr_html = " ".join(
        "%s='%s'" % (k, html.escape(str(v), quote=True)) for k, v in attrs.items()
    )
    rows = "".join(
        "<tr><th>%s</th><td>%s</td></tr>"
        % (html.escape(k), html.escape(str(v)))
        for k, v in (
            (F_ORDER, rec["order_no"]), (F_DEVICE, rec["device_no"]),
            (F_DATE, rec["inspect_date"]), (F_CONCLUSION, rec["conclusion"]),
            (F_INSPECTOR, rec["inspector"] or ""),
            ("回执编号", rec["receipt_no"]), ("登记时间", rec["created_at"]),
        )
    )
    return "<div %s><table>%s</table></div>" % (attr_html, rows)


# ---------------------------------------------------------------- HTTP 处理

class Handler(BaseHTTPRequestHandler):
    server_version = "MockInspectionPortal/1.0"

    def _send(self, code, html_text, ctype="text/html; charset=utf-8"):
        body = html_text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   ctype="application/json; charset=utf-8")

    def _read_form(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
        return {k: v[0].strip() for k, v in parsed.items()}

    def log_message(self, fmt, *args):
        sys.stderr.write("[portal %s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ------------------------------------------------ GET
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/":
            return self._handle_index()
        if url.path == "/query":
            return self._handle_query(parse_qs(url.query))
        if url.path == "/admin":
            return self._handle_admin()
        if url.path == "/admin/faults":
            with FAULT_LOCK:
                return self._send_json(200, load_faults())
        self._send(404, page("页面不存在", "<p>404 Not Found</p>"))

    def _handle_index(self):
        body = """
        <form method='post' action='/submit'>
          <label>巡检单号</label><input name='{order}' required>
          <label>设备编号</label><input name='{device}' required>
          <label>巡检日期</label><input name='{date}' placeholder='YYYY-MM-DD' required>
          <label>结论</label>
          <select name='{conclusion}'>
            <option>合格</option><option>不合格</option><option>待复检</option>
          </select>
          <label>巡检员</label><input name='{inspector}'>
          <label>备注</label><input name='{remark}'>
          <button type='submit'>提交巡检单</button>
        </form>
        <p class='note'>同一巡检单号只登记一次，重复提交将被拒绝并返回已有回执。</p>
        """.format(order=F_ORDER, device=F_DEVICE, date=F_DATE,
                   conclusion=F_CONCLUSION, inspector=F_INSPECTOR, remark=F_REMARK)
        self._send(200, page("巡检单录入", body))

    def _handle_query(self, qs):
        order_no = (qs.get(F_ORDER) or qs.get("order_no") or [""])[0].strip()
        if not order_no:
            body = ("<form method='get' action='/query'>"
                    "<label>巡检单号</label><input name='%s'>"
                    "<button type='submit'>查询</button></form>" % F_ORDER)
            return self._send(200, page("巡检单查询", body))
        with db_connect() as conn:
            rec = conn.execute(
                "SELECT * FROM records WHERE order_no=?", (order_no,)
            ).fetchone()
        if rec is None:
            body = (
                "<div id='query-result' data-found='0'>"
                "未查询到巡检单号 %s 的登记记录</div>"
            ) % html.escape(order_no, quote=True)
            return self._send(200, page("查询结果：未找到", body))
        self._send(200, page("查询结果：%s" % order_no, record_div(rec)))

    def _handle_admin(self):
        with db_connect() as conn:
            recs = conn.execute(
                "SELECT * FROM records ORDER BY created_at"
            ).fetchall()
        with FAULT_LOCK:
            faults = load_faults()
        trs = "".join(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
            % tuple(html.escape(str(rec[k])) for k in
                    ("order_no", "device_no", "inspect_date",
                     "conclusion", "receipt_no", "created_at"))
            for rec in recs
        )
        now = time.time()
        active_pre = [o for o, exp in faults["pre_write_timeout"].items()
                      if exp is None or now < exp]
        active_post = [o for o, exp in faults["post_write_receipt_lost"].items()
                       if exp is None or now < exp]
        body = """
        <h2>已登记记录（共 {n} 条）</h2>
        <table><tr><th>巡检单号</th><th>设备编号</th><th>巡检日期</th>
        <th>结论</th><th>回执编号</th><th>登记时间</th></tr>{trs}</table>
        <h2>当前故障注入（窗口内持续生效，窗口过后自动解除）</h2>
        <p>写入前超时：{pre}</p><p>写入后回执丢失：{post}</p>
        <p class='note'>配置方式：POST /admin/faults，JSON（值为单号列表）：
        {{"pre_write_timeout": ["单号"], "post_write_receipt_lost": ["单号"],
        "fault_delay": 8}}</p>
        <form method='post' action='/admin/reset'>
          <button type='submit'>清空全部登记记录</button>
        </form>
        """.format(n=len(recs), trs=trs or "<tr><td colspan=6>（空）</td></tr>",
                   pre=html.escape(json.dumps(active_pre, ensure_ascii=False)),
                   post=html.escape(json.dumps(active_post, ensure_ascii=False)))
        self._send(200, page("管理后台", body))

    # ------------------------------------------------ POST
    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/submit":
            return self._handle_submit()
        if url.path == "/admin/faults":
            return self._handle_admin_faults()
        if url.path == "/admin/reset":
            with FAULT_LOCK, db_connect() as conn:
                conn.execute("DELETE FROM records")
            self._send(200, page("已重置", "<p>登记记录已清空。</p>"))
            return
        self._send(404, page("页面不存在", "<p>404 Not Found</p>"))

    def _handle_admin_faults(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, page("错误", "<p>请求体必须是 JSON</p>"))
        with FAULT_LOCK:
            cfg = load_faults()
            for key in ("pre_write_timeout", "post_write_receipt_lost"):
                if key in payload:
                    # 外部仍按单号列表配置；None 表示等待首次触发后开窗
                    cfg[key] = {str(x).strip(): None
                                for x in payload[key] if str(x).strip()}
            if "fault_delay" in payload:
                cfg["fault_delay"] = float(payload["fault_delay"])
            save_faults(cfg)
        self._send_json(200, cfg)

    def _handle_submit(self):
        fields = self._read_form()
        order_no = fields.get(F_ORDER, "")

        errs = server_validate(fields)
        if errs:
            reason = "；".join(errs)
            body = (
                "<div id='submit-result' data-status='invalid' "
                "data-reason='%s'><p>字段校验失败：%s</p></div>"
            ) % (html.escape(reason, quote=True), html.escape(reason))
            return self._send(400, page("提交被拒绝", body))

        # 一次性故障：取出后立即解除，保证重跑不会再次触发
        fault, delay = consume_fault(order_no)
        if fault == "pre_write_timeout":
            self.log_message("故障注入：%s 写入前超时，休眠 %.1fs 且不写库",
                             order_no, delay)
            time.sleep(delay)
            body = (
                "<div id='submit-result' data-status='timeout' "
                "data-phase='pre-write' data-order-no='%s'>"
                "网关超时（写入未发生）</div>"
            ) % html.escape(order_no, quote=True)
            return self._send(504, page("提交超时", body))

        # 正常写入（含 post_write 场景：先落库）
        with FAULT_LOCK, db_connect() as conn:
            existing = conn.execute(
                "SELECT * FROM records WHERE order_no=?", (order_no,)
            ).fetchone()
            if existing is not None:
                div = record_div(existing, div_id="submit-result")
                body = (
                    "<p>巡检单号 %s 已登记，门户保留原始记录，本次提交未覆盖。</p>%s"
                    % (html.escape(order_no), div)
                ).replace(
                    "id='submit-result'",
                    "id='submit-result' data-status='duplicate'", 1,
                )
                return self._send(409, page("重复提交", body))

            now = time.strftime("%Y-%m-%d %H:%M:%S")
            receipt = next_receipt(conn, time.localtime())
            conn.execute(
                "INSERT INTO records VALUES (?,?,?,?,?,?,?,?)",
                (order_no, fields.get(F_DEVICE, ""), fields.get(F_DATE, ""),
                 fields.get(F_CONCLUSION, ""), fields.get(F_INSPECTOR, ""),
                 fields.get(F_REMARK, ""), receipt, now),
            )
            conn.commit()
            rec = conn.execute(
                "SELECT * FROM records WHERE order_no=?", (order_no,)
            ).fetchone()

        if fault == "post_write_receipt_lost":
            self.log_message("故障注入：%s 已写库（回执 %s），休眠 %.1fs 后断开连接",
                             order_no, receipt, delay)
            time.sleep(delay)
            # 不发送任何 HTTP 响应，直接断开，模拟回执丢失
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
            return

        body = (
            "<div id='submit-result' data-status='ok' data-order-no='%s' "
            "data-receipt-no='%s'><p>登记成功，回执编号：<b>%s</b></p></div>"
        ) % (html.escape(order_no, quote=True),
             html.escape(receipt, quote=True), html.escape(receipt))
        self._send(200, page("提交成功", body))


# ---------------------------------------------------------------- main

def main():
    global DB_PATH, FAULT_PATH, FAULT_DELAY
    ap = argparse.ArgumentParser(description="本地模拟巡检门户")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765,
                    help="监听端口，0 表示由系统分配")
    ap.add_argument("--data-dir", default="./portal_data")
    ap.add_argument("--seed", help="启动时预置记录的 CSV 文件")
    ap.add_argument("--fault-delay", type=float, default=8.0,
                    help="故障注入时的休眠秒数，应大于客户端超时")
    args = ap.parse_args()

    os.makedirs(args.data_dir, exist_ok=True)
    DB_PATH = os.path.join(args.data_dir, "portal.sqlite3")
    FAULT_PATH = os.path.join(args.data_dir, "faults.json")
    FAULT_DELAY = args.fault_delay
    init_db()
    if not os.path.exists(FAULT_PATH):
        save_faults({"pre_write_timeout": {}, "post_write_receipt_lost": {},
                     "fault_delay": args.fault_delay})
    seeded = seed_from_csv(args.seed)
    if seeded:
        print("已预置 %d 条记录" % seeded, flush=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    actual_port = httpd.server_address[1]
    print("LISTENING %d" % actual_port, flush=True)
    print("门户地址: http://%s:%d" % (args.host, actual_port), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
