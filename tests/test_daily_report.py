#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""daily_report.py 功能测试。

运行: python3 -I tests/test_daily_report.py
"""

import csv
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "daily_report.py")
LIMIT_MIB = 192


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def read_csv(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return list(csv.reader(f))


def run_cli(details, plan, summary_out, unplanned_out, chunk_size=2, expect_rc=0):
    """chunk_size 默认 2, 强制多归并段路径。"""
    proc = subprocess.run(
        [
            sys.executable, "-I", SCRIPT,
            "--details", details, "--plan", plan,
            "--summary-out", summary_out, "--unplanned-out", unplanned_out,
            "--chunk-size", str(chunk_size),
        ],
        capture_output=True, text=True,
    )
    if expect_rc is not None:
        assert proc.returncode == expect_rc, (
            f"rc={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}"
        )
    return proc


class DailyReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="drt_test_")
        self.details = os.path.join(self.tmp, "details.csv")
        self.plan = os.path.join(self.tmp, "plan.csv")
        self.summary = os.path.join(self.tmp, "out", "summary.csv")
        self.unplanned = os.path.join(self.tmp, "out", "unplanned.csv")

    def go(self, expect_rc=0, chunk_size=2):
        return run_cli(
            self.details, self.plan, self.summary, self.unplanned,
            chunk_size=chunk_size, expect_rc=expect_rc,
        )

    def test_dedup_quantiles_and_missing(self):
        # A 站: 编号 r1 重传 3 次 (含相同/不同读数), r2/r3 与 r1 读数相同但编号不同 -> 都计入
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-11-10", "r1", 10),
            ("A", "2026-11-10", "r1", 10),   # 完全重传, 丢弃
            ("A", "2026-11-10", "r1", 99),   # 同编号冲突重传, 丢弃并告警
            ("A", "2026-11-10", "r2", 10),   # 同值不同编号, 计入
            ("A", "2026-11-10", "r3", 30),   # 计入
        ])
        write_csv(self.plan, ["站点", "日期", "应报数"], [
            ("A", "2026-11-10", 5),
            ("A", "2026-11-11", 2),           # 零报组
            ("B", "2026-11-10", 1),           # 零报组
        ])
        proc = self.go()
        rows = read_csv(self.summary)
        self.assertEqual(rows[0], ["站点", "日期", "应报数", "实报数", "缺报数", "读数总和", "p50", "p95"])
        data = {(r[0], r[1]): r for r in rows[1:]}
        # 去重后 3 条: 10, 10, 30; 总和 50; p50=10, p95=30 (最近秩: ceil(.95*3)=3)
        self.assertEqual(data[("A", "2026-11-10")],
                         ["A", "2026-11-10", "5", "3", "2", "50", "10", "30"])
        # 零报组: 分位数留空
        self.assertEqual(data[("A", "2026-11-11")],
                         ["A", "2026-11-11", "2", "0", "2", "0", "", ""])
        self.assertEqual(data[("B", "2026-11-10")],
                         ["B", "2026-11-10", "1", "0", "1", "0", "", ""])
        # 冲突重传有告警
        self.assertIn("同编号重传读数不一致", proc.stderr)
        self.assertIn("第 4 行", proc.stderr)

    def test_unplanned_records_listed_separately(self):
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("X", "2026-11-10", "u1", 7),
            ("X", "2026-11-10", "u1", 7),       # 重传只留一条
            ("X", "2026-11-10", "u2", 8),
            ("A", "2026-11-10", "r1", 5),       # 计划内, 不应出现在计划外文件
        ])
        write_csv(self.plan, ["站点", "日期", "应报数"], [("A", "2026-11-10", 2)])
        self.go()
        rows = read_csv(self.unplanned)
        self.assertEqual(rows[0], ["站点", "日期", "记录编号", "读数"])
        self.assertEqual(sorted(rows[1:]), [
            ["X", "2026-11-10", "u1", "7"],
            ["X", "2026-11-10", "u2", "8"],
        ])
        # 汇总里不出现 X
        summary = read_csv(self.summary)
        self.assertEqual(len(summary), 2)
        self.assertEqual(summary[1][0], "A")

    def test_actual_exceeds_expected_missing_not_negative(self):
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-11-10", f"r{i}", i) for i in range(1, 7)
        ])
        write_csv(self.plan, ["站点", "日期", "应报数"], [("A", "2026-11-10", 3)])
        self.go()
        row = read_csv(self.summary)[1]
        self.assertEqual(row[2:5], ["3", "6", "0"])  # 应报3 实报6 缺报0
        self.assertEqual(row[5], str(sum(range(1, 7))))
        # n=6: p50 秩=3 -> 3; p95 秩=ceil(5.7)=6 -> 6
        self.assertEqual(row[6], "3")
        self.assertEqual(row[7], "6")

    def test_parse_error_reports_position_and_keeps_old_result(self):
        # 先跑一次成功的, 生成旧结果
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-11-10", "r1", 5),
        ])
        write_csv(self.plan, ["站点", "日期", "应报数"], [("A", "2026-11-10", 1)])
        self.go()
        with open(self.summary, "rb") as fh:
            old_summary = fh.read()
        with open(self.unplanned, "rb") as fh:
            old_unplanned = fh.read()

        # 坏数据: 第 3 行读数不是整数
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-11-10", "r1", 5),
            ("A", "2026-11-10", "r2", "abc"),
        ])
        proc = self.go(expect_rc=2)
        self.assertIn("第 3 行", proc.stderr)
        self.assertIn("读数", proc.stderr)
        self.assertIn("保留上一次成功生成的结果", proc.stderr)
        # 旧文件原样保留
        with open(self.summary, "rb") as fh:
            self.assertEqual(fh.read(), old_summary)
        with open(self.unplanned, "rb") as fh:
            self.assertEqual(fh.read(), old_unplanned)

    def test_bad_field_count_and_bad_date(self):
        write_csv(self.plan, ["站点", "日期", "应报数"], [("A", "2026-11-10", 1)])
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-11-10", "r1", 5, "extra"),
        ])
        proc = self.go(expect_rc=2)
        self.assertIn("第 2 行", proc.stderr)
        self.assertIn("字段数", proc.stderr)

        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-02-30", "r1", 5),
        ])
        proc = self.go(expect_rc=2)
        self.assertIn("第 2 行", proc.stderr)

    def test_negative_and_zero_readings_supported(self):
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-11-10", "r1", -10),
            ("A", "2026-11-10", "r2", 0),
            ("A", "2026-11-10", "r3", -5),
        ])
        write_csv(self.plan, ["站点", "日期", "应报数"], [("A", "2026-11-10", 3)])
        self.go()
        row = read_csv(self.summary)[1]
        self.assertEqual(row[5], "-15")          # 总和
        vals = sorted([-10, 0, -5])
        self.assertEqual(row[6], str(vals[1]))   # p50 = -5
        self.assertEqual(row[7], str(vals[2]))   # p95 = 0

    def test_english_headers_and_bom(self):
        with open(self.details, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["station", "date", "record_id", "reading"])
            w.writerow(["A", "2026-11-10", "r1", 42])
        with open(self.plan, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["station", "date", "expected"])
            w.writerow(["A", "2026-11-10", 1])
        self.go()
        self.assertEqual(read_csv(self.summary)[1][3], "1")

    def test_blank_lines_ignored(self):
        with open(self.details, "w", encoding="utf-8", newline="") as f:
            f.write("站点,日期,记录编号,读数\n")
            f.write("A,2026-11-10,r1,5\n")
            f.write("\n,,,\n")
            f.write("A,2026-11-10,r2,7\n")
        write_csv(self.plan, ["站点", "日期", "应报数"], [("A", "2026-11-10", 2)])
        self.go()
        row = read_csv(self.summary)[1]
        self.assertEqual(row[3], "2")
        self.assertEqual(row[5], "12")

    def test_duplicate_plan_entry_rejected(self):
        write_csv(self.details, ["站点", "日期", "记录编号", "读数"], [
            ("A", "2026-11-10", "r1", 5),
        ])
        write_csv(self.plan, ["站点", "日期", "应报数"], [
            ("A", "2026-11-10", 1),
            ("A", "2026-11-10", 2),
        ])
        proc = self.go(expect_rc=2)
        self.assertIn("计划重复", proc.stderr)
        self.assertIn("第 3 行", proc.stderr)

    def test_missing_input_file(self):
        write_csv(self.plan, ["站点", "日期", "应报数"], [("A", "2026-11-10", 1)])
        proc = run_cli(
            os.path.join(self.tmp, "nope.csv"), self.plan,
            self.summary, self.unplanned, expect_rc=2,
        )
        self.assertIn("不存在", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
