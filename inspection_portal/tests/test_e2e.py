#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
端到端测试：启动真实的模拟门户子进程 + 调用批量程序，
覆盖已登记 / 字段校验失败 / 内容冲突 / 仍待确认 四种状态与恢复流程。

运行：python3 -m unittest -v tests.test_e2e
（在 inspection_portal 目录下执行；纯标准库，无第三方依赖）
"""

import csv
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORTAL = os.path.join(ROOT, "portal_server.py")
BATCH = os.path.join(ROOT, "batch_submit.py")

F_ORDER = "巡检单号"
F_DEVICE = "设备编号"
F_DATE = "巡检日期"
F_CONCLUSION = "结论"

ST_REGISTERED = "已登记"
ST_INVALID = "字段校验失败"
ST_CONFLICT = "内容冲突"
ST_PENDING = "仍待确认"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def write_csv(path, rows, header=("巡检单号", "设备编号", "巡检日期",
                                  "结论", "巡检员", "备注")):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


class PortalProcess:
    def __init__(self, data_dir, seed=None, fault_delay=1.0):
        self.port = free_port()
        self.base = "http://127.0.0.1:%d" % self.port
        cmd = [sys.executable, "-I", PORTAL,
               "--port", str(self.port), "--data-dir", data_dir,
               "--fault-delay", str(fault_delay)]
        if seed:
            cmd += ["--seed", seed]
        self.proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.proc.poll() is not None:
                err = self.proc.stderr.read()
                raise RuntimeError("门户进程提前退出：\n" + err)
            try:
                urllib.request.urlopen(self.base + "/query", timeout=0.5).read()
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("门户启动超时")

    def set_faults(self, payload):
        req = urllib.request.Request(
            self.base + "/admin/faults",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=5).read()

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        # 回收管道，避免 ResourceWarning
        self.proc.stdout.close()
        self.proc.stderr.close()

    def start_again(self, data_dir, seed=None, fault_delay=1.0):
        """用同一端口、同一数据目录重启，验证 SQLite 持久化后的恢复。"""
        self.stop()
        self.__init__(data_dir, seed=seed, fault_delay=fault_delay)


def run_batch(csv_path, base, state_dir, timeout=0.6):
    proc = subprocess.run(
        [sys.executable, "-I", BATCH, "--csv", csv_path,
         "--base-url", base, "--state-dir", state_dir,
         "--timeout", str(timeout),
         "--query-retries", "1", "--retry-interval", "0.2"],
        capture_output=True, text=True)
    return proc


def read_result(state_dir):
    with open(os.path.join(state_dir, "result.csv"),
              encoding="utf-8") as f:
        return {r[F_ORDER]: r for r in csv.DictReader(f)}


class EndToEndTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="portal_test_")
        self.data_dir = os.path.join(self.tmp, "portal_data")
        self.state_dir = os.path.join(self.tmp, "run_data")
        os.makedirs(self.data_dir)
        self.csv_path = os.path.join(self.tmp, "orders.csv")
        self.portal = PortalProcess(self.data_dir)

    def tearDown(self):
        self.portal.stop()

    # 1. 正常登记 + 重复提交（409，字段一致，直接按已登记处理）
    def test_01_normal_and_duplicate(self):
        write_csv(self.csv_path, [
            ["XJ-T1", "SB-1", "2026-11-10", "合格", "甲", ""],
            ["XJ-T2", "SB-2", "2026-11-10", "不合格", "乙", ""],
        ])
        p = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        res = read_result(self.state_dir)
        self.assertEqual(res["XJ-T1"]["状态"], ST_REGISTERED)
        self.assertTrue(res["XJ-T1"]["回执编号"].startswith("HZ-"))
        self.assertEqual(res["XJ-T2"]["状态"], ST_REGISTERED)

        # 整批重跑：门户中已存在，409 后字段比对一致，仍为已登记且单号只登记一次
        p2 = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p2.returncode, 0, p2.stderr + p2.stdout)
        res2 = read_result(self.state_dir)
        self.assertEqual(res2["XJ-T1"]["状态"], ST_REGISTERED)
        self.assertEqual(res2["XJ-T1"]["回执编号"], res["XJ-T1"]["回执编号"])

        admin = urllib.request.urlopen(
            self.portal.base + "/admin/faults", timeout=5).read()
        # 后台记录条数仍是 2（在 /admin 页面人工可查；这里直接查库验证）
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.data_dir, "portal.sqlite3"))
        try:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM records").fetchone()[0], 2)
        finally:
            conn.close()

    # 2. 本地字段校验失败，不联系门户
    def test_02_invalid_fields(self):
        write_csv(self.csv_path, [
            ["XJ-BAD-1", "SB-3", "2026-11-10", "需维修", "甲", "结论非法"],
            ["XJ-BAD-2", "", "2026-11-10", "合格", "甲", "设备编号为空"],
            ["XJ-BAD-3", "SB-5", "2026/11/10", "合格", "甲", "日期格式错"],
            ["XJ-OK-1", "SB-6", "2026-11-10", "待复检", "甲", "对照正常行"],
        ])
        p = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        res = read_result(self.state_dir)
        for k in ("XJ-BAD-1", "XJ-BAD-2", "XJ-BAD-3"):
            self.assertEqual(res[k]["状态"], ST_INVALID, k)
        self.assertEqual(res["XJ-OK-1"]["状态"], ST_REGISTERED)

    # 3. 内容冲突：门户预置记录与 CSV 字段不一致，保留门户记录
    def test_03_content_conflict(self):
        seed = os.path.join(self.tmp, "seed.csv")
        write_csv(seed, [
            ["XJ-CF", "SB-9", "2026-11-01", "不合格", "门户登记人", "原始"],
        ])
        self.portal.stop()
        self.portal = PortalProcess(self.data_dir, seed=seed)

        write_csv(self.csv_path, [
            ["XJ-CF", "SB-9", "2026-11-10", "合格", "甲", "结论与日期都不同"],
        ])
        p = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        res = read_result(self.state_dir)
        self.assertEqual(res["XJ-CF"]["状态"], ST_CONFLICT)
        self.assertIn("结论", res["XJ-CF"]["说明"])
        self.assertIn("巡检日期", res["XJ-CF"]["说明"])

        import sqlite3
        conn = sqlite3.connect(os.path.join(self.data_dir, "portal.sqlite3"))
        try:
            row = conn.execute(
                "SELECT conclusion, inspect_date FROM records WHERE order_no=?",
                ("XJ-CF",)).fetchone()
            self.assertEqual(row, ("不合格", "2026-11-01"))  # 门户记录原样保留
        finally:
            conn.close()

    # 4. 写入前超时：首轮仍待确认，重跑先查询（查不到）→ 重新提交成功
    def test_04_pre_write_timeout_recovery(self):
        write_csv(self.csv_path, [
            ["XJ-PRE", "SB-7", "2026-11-10", "合格", "甲", ""],
        ])
        self.portal.set_faults({"pre_write_timeout": ["XJ-PRE"],
                                "fault_delay": 1.0})
        p = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p.returncode, 3, p.stdout)  # 有待确认项 → 退出码 3
        res = read_result(self.state_dir)
        self.assertEqual(res["XJ-PRE"]["状态"], ST_PENDING)

        # 故障窗口内未写库，此时库里确实没有该单号
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.data_dir, "portal.sqlite3"))
        try:
            self.assertIsNone(conn.execute(
                "SELECT 1 FROM records WHERE order_no=?", ("XJ-PRE",)).fetchone())
        finally:
            conn.close()

        # 重跑：恢复流程先查门户（查不到）→ 重新提交 → 已登记
        p2 = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p2.returncode, 0, p2.stderr + p2.stdout)
        res2 = read_result(self.state_dir)
        self.assertEqual(res2["XJ-PRE"]["状态"], ST_REGISTERED)
        self.assertTrue(res2["XJ-PRE"]["回执编号"])

    # 5. 写入后回执丢失：记录已落库，客户端超时后查询命中且字段一致 → 同轮补回执
    def test_05_post_write_receipt_lost_recovery(self):
        write_csv(self.csv_path, [
            ["XJ-POST", "SB-8", "2026-11-10", "合格", "甲", ""],
        ])
        self.portal.set_faults({"post_write_receipt_lost": ["XJ-POST"],
                                "fault_delay": 1.0})
        p = run_batch(self.csv_path, self.portal.base, self.state_dir)
        # 记录已在门户，提交超时后的查询恢复在同一次运行内即可完成
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        res = read_result(self.state_dir)
        self.assertEqual(res["XJ-POST"]["状态"], ST_REGISTERED)

        import sqlite3
        conn = sqlite3.connect(os.path.join(self.data_dir, "portal.sqlite3"))
        try:
            row = conn.execute(
                "SELECT device_no, inspect_date, conclusion, receipt_no "
                "FROM records WHERE order_no=?", ("XJ-POST",)).fetchone()
            self.assertEqual(row[:3], ("SB-8", "2026-11-10", "合格"))
            receipt = row[3]
            self.assertEqual(res["XJ-POST"]["回执编号"], receipt)
            # 只登记一次，没有产生第二条记录
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM records WHERE order_no=?",
                ("XJ-POST",)).fetchone()[0], 1)

            # 重跑：门户 409 重复登记，字段一致，仍按已登记处理且回执不变
            p2 = run_batch(self.csv_path, self.portal.base, self.state_dir)
            self.assertEqual(p2.returncode, 0, p2.stderr + p2.stdout)
            res2 = read_result(self.state_dir)
            self.assertEqual(res2["XJ-POST"]["状态"], ST_REGISTERED)
            self.assertEqual(res2["XJ-POST"]["回执编号"], receipt)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM records WHERE order_no=?",
                ("XJ-POST",)).fetchone()[0], 1)
        finally:
            conn.close()

    # 5b. 提交与查询均无法到达门户 → 仍待确认（含重试）；门户恢复后重跑，
    #     先查门户（查无记录）→ 重新提交成功，全程单号只登记一次
    def test_05b_pending_then_query_recovery_on_rerun(self):
        write_csv(self.csv_path, [
            ["XJ-DOWN-R", "SB-8B", "2026-11-10", "合格", "甲", ""],
        ])
        self.portal.stop()  # 门户直接不可达
        p = run_batch(self.csv_path, self.portal.base, self.state_dir,
                      timeout=0.6)
        self.assertEqual(p.returncode, 3, p.stdout)
        res = read_result(self.state_dir)
        self.assertEqual(res["XJ-DOWN-R"]["状态"], ST_PENDING)
        self.assertIn("查询也失败", res["XJ-DOWN-R"]["说明"])

        # 门户恢复后重跑：恢复查询查无记录 → 重新提交 → 已登记
        self.portal = PortalProcess(self.data_dir)
        p2 = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p2.returncode, 0, p2.stderr + p2.stdout)
        res2 = read_result(self.state_dir)
        self.assertEqual(res2["XJ-DOWN-R"]["状态"], ST_REGISTERED)
        self.assertTrue(res2["XJ-DOWN-R"]["回执编号"])
        import sqlite3
        conn = sqlite3.connect(os.path.join(self.data_dir, "portal.sqlite3"))
        try:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM records WHERE order_no=?",
                ("XJ-DOWN-R",)).fetchone()[0], 1)
        finally:
            conn.close()

    # 6. 填报中途门户不可达 → 仍待确认；门户重启后重跑恢复
    def test_06_portal_down_then_restart(self):
        write_csv(self.csv_path, [
            ["XJ-DOWN-1", "SB-D1", "2026-11-10", "合格", "甲", ""],
            ["XJ-DOWN-2", "SB-D2", "2026-11-10", "合格", "甲", ""],
        ])
        self.portal.stop()  # 模拟门户宕机 / 填报程序在无门户时启动
        p = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p.returncode, 3, p.stdout)
        res = read_result(self.state_dir)
        self.assertEqual(res["XJ-DOWN-1"]["状态"], ST_PENDING)
        self.assertEqual(res["XJ-DOWN-2"]["状态"], ST_PENDING)

        # 门户用同一数据目录重启（SQLite 持久化），重跑同一批
        self.portal = PortalProcess(self.data_dir)
        p2 = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p2.returncode, 0, p2.stderr + p2.stdout)
        res2 = read_result(self.state_dir)
        self.assertEqual(res2["XJ-DOWN-1"]["状态"], ST_REGISTERED)
        self.assertEqual(res2["XJ-DOWN-2"]["状态"], ST_REGISTERED)

    # 7. 模拟填报进程被 kill：部分行已终态，重跑只处理待确认行
    def test_07_kill_midrun_and_resume(self):
        write_csv(self.csv_path, [
            ["XJ-K-1", "SB-K1", "2026-11-10", "合格", "甲", ""],
            ["XJ-K-2", "SB-K2", "2026-11-10", "合格", "甲", ""],
            ["XJ-K-3", "SB-K3", "2026-11-10", "合格", "甲", ""],
        ])
        proc = subprocess.Popen(
            [sys.executable, "-I", BATCH, "--csv", self.csv_path,
             "--base-url", self.portal.base, "--state-dir", self.state_dir,
             "--timeout", "0.6", "--row-delay", "0.7"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(1.0)  # 第一行处理完、停顿期间杀掉
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)
        proc.stdout.close()
        proc.stderr.close()

        with open(os.path.join(self.state_dir, "state.json"),
                  encoding="utf-8") as sf:
            state = json.load(sf)
        self.assertEqual(state["rows"]["0"]["status"], ST_REGISTERED)

        p2 = run_batch(self.csv_path, self.portal.base, self.state_dir)
        self.assertEqual(p2.returncode, 0, p2.stderr + p2.stdout)
        res2 = read_result(self.state_dir)
        for k in ("XJ-K-1", "XJ-K-2", "XJ-K-3"):
            self.assertEqual(res2[k]["状态"], ST_REGISTERED, k)
        self.assertIn("跳过", p2.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
