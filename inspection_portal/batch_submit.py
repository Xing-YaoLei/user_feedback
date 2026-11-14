#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
巡检单批量填报程序（纯标准库实现）。

处理流程（每张单）：
1. 本地字段校验：不过则直接记“字段校验失败”，不联系门户。
2. POST /submit 通过网页表单录入。
   - 200 成功：从返回页读取回执，记“已登记”。
   - 400 校验失败：记“字段校验失败”。
   - 409 重复登记：读取返回页中的既有登记内容做字段比对。
3. 提交超时 / 连接被断开（写入前超时、写入后回执丢失都表现为这一类）：
   重跑时先按单号查门户（GET /query）：
   - 查到且设备编号、巡检日期、结论三项全部一致 → 取门户回执补进结果表，“已登记”；
   - 查到但任一字段不一致 → 记“内容冲突”，保留门户记录，结果表注明差异；
   - 查不到 → 才重新提交（最多两轮 POST + 查询）；
   - 查询本身也连不上门户、或两轮后仍无法确认 → “仍待确认”。
4. 每处理完一行立即落盘状态与结果表；中途退出（kill / 异常 / 门户宕机）后重跑，
   已终态的行跳过，“仍待确认”的行走同一套“先查询再决定是否重提”的恢复流程。
5. 单行失败不影响后续行。

用法：
  python3 batch_submit.py --csv 维修组巡检单.csv \
      --base-url http://127.0.0.1:8765 --state-dir ./run_data
"""

import argparse
import csv
import hashlib
import io
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

# ---- 业务常量
F_ORDER = "巡检单号"
F_DEVICE = "设备编号"
F_DATE = "巡检日期"
F_CONCLUSION = "结论"
F_INSPECTOR = "巡检员"
F_REMARK = "备注"

VALID_CONCLUSIONS = {"合格", "不合格", "待复检"}
COMPARE_FIELDS = (F_DEVICE, F_DATE, F_CONCLUSION)

ST_REGISTERED = "已登记"
ST_INVALID = "字段校验失败"
ST_CONFLICT = "内容冲突"
ST_PENDING = "仍待确认"
TERMINAL = {ST_REGISTERED, ST_INVALID, ST_CONFLICT}

RESULT_HEADER = ["巡检单号", "状态", "设备编号", "巡检日期", "结论",
                 "回执编号", "说明"]


# ---------------------------------------------------------------- 异常与 HTML

class PortalError(Exception):
    """与门户通信的归一化异常。kind: timeout / connection / http"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


class DivAttrParser(HTMLParser):
    """抽取页面中指定 id 的 div 的全部属性（门户把数据放在 data-* 里）。"""

    def __init__(self, target_id):
        super().__init__()
        self._target = target_id
        self.attrs = None

    def handle_starttag(self, tag, attrs):
        if tag == "div" and self.attrs is None:
            d = dict(attrs)
            if d.get("id") == self._target:
                self.attrs = d


def extract_div(html_text, div_id):
    p = DivAttrParser(div_id)
    p.feed(html_text or "")
    return p.attrs


def record_from_attrs(attrs):
    """把 div 的 data-* 属性整理成登记记录 dict；data-found=0 表示查无记录。"""
    if not attrs or attrs.get("data-found") == "0":
        return None
    return {
        F_ORDER: attrs.get("data-order-no", ""),
        F_DEVICE: attrs.get("data-device-no", ""),
        F_DATE: attrs.get("data-inspect-date", ""),
        F_CONCLUSION: attrs.get("data-conclusion", ""),
        F_INSPECTOR: attrs.get("data-inspector", ""),
        "回执编号": attrs.get("data-receipt-no", ""),
        "登记时间": attrs.get("data-created-at", ""),
    }


# ---------------------------------------------------------------- HTTP 层

def _normalize_network_error(exc):
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return PortalError("timeout", "请求超时：%s" % exc)
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return PortalError("timeout", "请求超时：%s" % reason)
    if isinstance(reason, (ConnectionError, OSError)):
        return PortalError("connection", "连接失败：%s" % reason)
    return PortalError("connection", "网络异常：%s" % exc)


def http_post_form(base_url, fields, timeout):
    """返回 (HTTP 状态码, 响应 HTML)；超时/断连抛 PortalError。"""
    url = base_url.rstrip("/") + "/submit"
    data = urllib.parse.urlencode(fields, encoding="utf-8").encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        raise _normalize_network_error(e)
    except (ConnectionError, OSError) as e:
        raise _normalize_network_error(e)


def http_get_query(base_url, order_no, timeout):
    """查询门户；返回登记记录 dict（查无记录返回 None）；网络问题抛 PortalError。"""
    qs = urllib.parse.urlencode({F_ORDER: order_no}, encoding="utf-8")
    url = base_url.rstrip("/") + "/query?" + qs
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html_text = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        html_text = e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        raise _normalize_network_error(e)
    except (ConnectionError, OSError) as e:
        raise _normalize_network_error(e)
    return record_from_attrs(extract_div(html_text, "query-result"))


# ---------------------------------------------------------------- 校验与比对

def validate_row(row):
    errs = []
    if not row.get(F_ORDER):
        errs.append("巡检单号为空")
    elif len(row[F_ORDER]) > 40:
        errs.append("巡检单号超长")
    if not row.get(F_DEVICE):
        errs.append("设备编号为空")
    date_s = row.get(F_DATE, "")
    if not date_s:
        errs.append("巡检日期为空")
    else:
        try:
            time.strptime(date_s, "%Y-%m-%d")
        except ValueError:
            errs.append("巡检日期不是 YYYY-MM-DD: %r" % date_s)
    if row.get(F_CONCLUSION) not in VALID_CONCLUSIONS:
        errs.append("结论非法: %r（允许：合格/不合格/待复检）"
                    % row.get(F_CONCLUSION, ""))
    return errs


def diff_fields(row, portal_rec):
    """返回不一致字段说明列表；空列表表示三项全部对得上。"""
    diffs = []
    for f in COMPARE_FIELDS:
        local = (row.get(f) or "").strip()
        remote = (portal_rec.get(f) or "").strip()
        if local != remote:
            diffs.append("%s 本地=%r / 门户=%r" % (f, local, remote))
    return diffs


# ---------------------------------------------------------------- 单行处理

class BatchClient:
    def __init__(self, base_url, timeout, query_retries=2, retry_interval=1.5):
        self.base_url = base_url
        self.timeout = timeout
        self.query_retries = query_retries
        self.retry_interval = retry_interval

    def query_portal(self, order_no):
        return http_get_query(self.base_url, order_no, self.timeout)

    def query_with_retry(self, order_no):
        """
        恢复查询：网络层失败时有限重试（门户可能正在重启/故障窗口未过）。
        返回 (记录dict或None, 最后一次错误说明或None)。
        """
        last_err = None
        for attempt in range(self.query_retries + 1):
            try:
                return self.query_portal(order_no), None
            except PortalError as e:
                last_err = e.message
                if attempt < self.query_retries:
                    time.sleep(self.retry_interval)
        return None, last_err

    def submit_once(self, row):
        """一次 POST，返回 (状态, 回执或None, 说明)。"""
        fields = {F_ORDER: row.get(F_ORDER, ""),
                  F_DEVICE: row.get(F_DEVICE, ""),
                  F_DATE: row.get(F_DATE, ""),
                  F_CONCLUSION: row.get(F_CONCLUSION, ""),
                  F_INSPECTOR: row.get(F_INSPECTOR, ""),
                  F_REMARK: row.get(F_REMARK, "")}
        code, html_text = http_post_form(self.base_url, fields, self.timeout)
        attrs = extract_div(html_text, "submit-result") or {}
        if code == 200 and attrs.get("data-status") == "ok":
            return ST_REGISTERED, attrs.get("data-receipt-no", ""), "表单提交成功"
        if code == 400 or attrs.get("data-status") == "invalid":
            return ST_INVALID, None, "门户字段校验失败：%s" % attrs.get(
                "data-reason", "未知原因")
        if code == 409 or attrs.get("data-status") == "duplicate":
            rec = record_from_attrs(attrs)
            return self._classify_by_portal_record(row, rec, "门户中已存在该单号")
        # 其他非预期 HTTP 状态，按无法确认处理
        return ST_PENDING, None, "门户返回非预期状态码 %s" % code

    def _classify_by_portal_record(self, row, rec, prefix):
        if rec is None:
            return ST_PENDING, None, prefix + "，但未能解析门户记录"
        diffs = diff_fields(row, rec)
        receipt = rec.get("回执编号", "")
        if not diffs:
            return ST_REGISTERED, receipt, "%s；字段一致，补录门户回执 %s" % (
                prefix, receipt)
        detail = "%s；%s；门户回执 %s（门户记录保留未覆盖）" % (
            prefix, "；".join(diffs), receipt or "无")
        return ST_CONFLICT, receipt, detail

    def handle_row(self, row, resume):
        """
        resume=True 表示该行上次停在“仍待确认”：先查门户，查到即比对收尾，
        查不到才重新提交；resume=False 直接走提交+恢复循环。
        最多两轮 POST，每轮失败后查询一次，仍无法确认则返回“仍待确认”。
        """
        if resume:
            rec, err = self.query_with_retry(row[F_ORDER])
            if err is not None:
                return ST_PENDING, None, "恢复查询失败：%s" % err
            if rec is not None:
                return self._classify_by_portal_record(
                    row, rec, "恢复时在门户查到该单号")
            # 查不到 → 落到下面的重新提交流程

        last_network_msg = ""
        for attempt in (1, 2):
            try:
                status, receipt, detail = self.submit_once(row)
                return status, receipt, detail
            except PortalError as e:
                last_network_msg = e.message
                # 超时/断连后一律先查门户，确认到底写进去没有
                rec, qerr = self.query_with_retry(row[F_ORDER])
                if qerr is not None:
                    return ST_PENDING, None, (
                        "第 %d 次提交%s；随后查询也失败：%s"
                        % (attempt, e.message, qerr))
                if rec is not None:
                    return self._classify_by_portal_record(
                        row, rec, "第 %d 次提交%s后查询门户" % (attempt, e.message))
                if attempt == 1:
                    # 门户查无记录 → 确认未写入，重新提交
                    continue
        return ST_PENDING, None, (
            "两轮提交均失败且门户查无记录（%s），需人工确认后重跑"
            % last_network_msg)


# ---------------------------------------------------------------- 状态与结果表

def atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, path)


def load_state(path):
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_outputs(state_dir, state):
    atomic_write(os.path.join(state_dir, "state.json"),
                 json.dumps(state, ensure_ascii=False, indent=2))

    def render_csv():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(RESULT_HEADER)
        for idx in state["row_order"]:
            item = state["rows"][idx]
            writer.writerow([item.get(F_ORDER, ""), item.get("status", ""),
                             item.get(F_DEVICE, ""), item.get(F_DATE, ""),
                             item.get(F_CONCLUSION, ""),
                             item.get("receipt", ""), item.get("detail", "")])
        return buf.getvalue()

    atomic_write(os.path.join(state_dir, "result.csv"), render_csv())


def read_input_csv(path):
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in (F_ORDER, F_DEVICE, F_DATE, F_CONCLUSION)
                   if c not in (reader.fieldnames or [])]
        if missing:
            raise SystemExit("输入 CSV 缺少必需列：%s" % "、".join(missing))
        rows = []
        for raw in reader:
            rows.append({k: (v or "").strip() for k, v in raw.items()})
    return rows


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="巡检单批量填报程序")
    ap.add_argument("--csv", required=True, help="维修组巡检单 CSV")
    ap.add_argument("--base-url", default="http://127.0.0.1:8765")
    ap.add_argument("--state-dir", default="./run_data",
                    help="断点状态与结果表目录")
    ap.add_argument("--timeout", type=float, default=4.0,
                    help="单次 HTTP 超时秒数，需小于门户故障休眠时间")
    ap.add_argument("--row-delay", type=float, default=0.0,
                    help="每行处理后的停顿秒数（便于演示中途 kill）")
    ap.add_argument("--query-retries", type=int, default=2,
                    help="恢复查询失败时的额外重试次数")
    ap.add_argument("--retry-interval", type=float, default=1.5,
                    help="恢复查询重试间隔秒数")
    args = ap.parse_args()

    os.makedirs(args.state_dir, exist_ok=True)
    rows = read_input_csv(args.csv)
    fingerprint = hashlib.sha256(
        open(args.csv, "rb").read()).hexdigest()

    state = load_state(os.path.join(args.state_dir, "state.json"))
    if state is None:
        state = {"csv_path": os.path.abspath(args.csv),
                 "input_fingerprint": fingerprint,
                 "base_url": args.base_url,
                 "rows": {}, "row_order": []}
    elif state.get("input_fingerprint") != fingerprint:
        print("警告：输入 CSV 内容与上次运行时不同，仍按当前文件逐行恢复/处理",
              file=sys.stderr)

    client = BatchClient(args.base_url, args.timeout,
                         query_retries=args.query_retries,
                         retry_interval=args.retry_interval)
    counts = {ST_REGISTERED: 0, ST_INVALID: 0, ST_CONFLICT: 0, ST_PENDING: 0}

    for i, row in enumerate(rows):
        idx = str(i)
        order_no = row.get(F_ORDER) or "（第%d行无单号）" % (i + 1)
        prev = state["rows"].get(idx)

        if prev and prev.get("status") in TERMINAL:
            print("[%d/%d] %s 跳过（上次已终态：%s）"
                  % (i + 1, len(rows), order_no, prev["status"]))
            counts[prev["status"]] += 1
            continue

        resume = bool(prev and prev.get("status") == ST_PENDING)
        try:
            errs = validate_row(row)
            if errs:
                status, receipt, detail = (
                    ST_INVALID, None,
                    "本地字段校验失败：" + "；".join(errs))
            else:
                print("[%d/%d] 处理 %s%s ..."
                      % (i + 1, len(rows), order_no,
                         "（恢复：先查门户）" if resume else ""), flush=True)
                status, receipt, detail = client.handle_row(row, resume)
        except Exception as e:  # 任何意外都不能拖垮整批
            status, receipt, detail = ST_PENDING, None, "程序异常：%r" % e

        state["rows"][idx] = {
            F_ORDER: row.get(F_ORDER, ""), F_DEVICE: row.get(F_DEVICE, ""),
            F_DATE: row.get(F_DATE, ""), F_CONCLUSION: row.get(F_CONCLUSION, ""),
            F_INSPECTOR: row.get(F_INSPECTOR, ""), F_REMARK: row.get(F_REMARK, ""),
            "status": status, "receipt": receipt or "", "detail": detail,
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        if idx not in state["row_order"]:
            state["row_order"].append(idx)
        write_outputs(args.state_dir, state)
        counts[status] += 1
        print("    → %s | %s%s"
              % (status, detail,
                 (" | 回执 " + receipt) if receipt else ""))
        if args.row_delay:
            time.sleep(args.row_delay)

    print("\n汇总：共 %d 行；已登记 %d，字段校验失败 %d，内容冲突 %d，仍待确认 %d"
          % (len(rows), counts[ST_REGISTERED], counts[ST_INVALID],
             counts[ST_CONFLICT], counts[ST_PENDING]))
    print("结果表：%s" % os.path.join(args.state_dir, "result.csv"))
    sys.exit(3 if counts[ST_PENDING] else 0)


if __name__ == "__main__":
    main()
