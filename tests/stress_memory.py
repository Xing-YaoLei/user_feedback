#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""200 万条集中在同一站点同一天的内存压力与正确性测试。

运行: python3 -I tests/stress_memory.py
约束: 批处理子进程峰值 RSS 必须 < 192 MiB。
"""

import csv
import math
import os
import resource
import subprocess
import sys
import tempfile
import time

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "daily_report.py")
LIMIT_BYTES = 192 * 1024 * 1024
N_UNIQUE = 1_000_000          # 100 万个不同编号
N_DUP = 1_000_000             # 100 万条重传 -> 合计 200 万行
STATION = "S1"
DAY = "2026-11-10"


def reading_of(i):
    return (i * 7919) % 100_000


def generate(details_path):
    with open(details_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["站点", "日期", "记录编号", "读数"])
        # 第一阶段: 100 万条原始上报 (每个编号首次出现, 按到达顺序它们就是权威值)
        for i in range(N_UNIQUE):
            w.writerow((STATION, DAY, f"r{i}", reading_of(i)))
        # 第二阶段: 100 万条重传, 全局乱序穿插, 考验外部排序与去重
        #   偶数 -> 完全相同的重传; 奇数 -> 读数冲突的重传 (必须被忽略并告警)
        for i in range(N_DUP):
            rid = f"r{i % N_UNIQUE}"
            if i % 2 == 0:
                w.writerow((STATION, DAY, rid, reading_of(i % N_UNIQUE)))
            else:
                w.writerow((STATION, DAY, rid, reading_of(i % N_UNIQUE) + 1))
        # 少量计划外记录
        for j in range(3):
            w.writerow(("S9", DAY, f"x{j}", 100 + j))


def expected_stats():
    values = sorted(reading_of(i) for i in range(N_UNIQUE))
    total = sum(values)
    n = len(values)
    p50 = values[math.ceil(0.50 * n) - 1]
    p95 = values[math.ceil(0.95 * n) - 1]
    return n, total, p50, p95


def peak_rss_bytes():
    ru = resource.getrusage(resource.RUSAGE_CHILDREN)
    # macOS: 字节; Linux: KiB
    if sys.platform == "darwin":
        return ru.ru_maxrss
    return ru.ru_maxrss * 1024


def main():
    work = tempfile.mkdtemp(prefix="drt_stress_")
    details = os.path.join(work, "details.csv")
    plan = os.path.join(work, "plan.csv")
    summary = os.path.join(work, "summary.csv")
    unplanned = os.path.join(work, "unplanned.csv")

    print(f"工作目录: {work}")
    t0 = time.time()
    print(f"生成 {N_UNIQUE + N_DUP} 行明细 (全部集中于 {STATION}/{DAY}) ...")
    generate(details)
    with open(plan, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["站点", "日期", "应报数"])
        w.writerow((STATION, DAY, N_UNIQUE + 50_000))   # 故意制造缺报
        w.writerow(("S0", "2026-11-11", 3))             # 零报组
    print(f"数据准备耗时 {time.time() - t0:.1f}s, "
          f"明细大小 {os.path.getsize(details) / 1e6:.1f} MB")

    exp_n, exp_total, exp_p50, exp_p95 = expected_stats()

    failures = []
    for chunk_size in (150_000, 50_000):
        t0 = time.time()
        proc = subprocess.run(
            [sys.executable, "-I", SCRIPT,
             "--details", details, "--plan", plan,
             "--summary-out", summary, "--unplanned-out", unplanned,
             "--chunk-size", str(chunk_size)],
            capture_output=True, text=True,
        )
        elapsed = time.time() - t0
        if proc.returncode != 0:
            print(proc.stderr)
            failures.append(f"chunk={chunk_size}: 进程失败 rc={proc.returncode}")
            continue

        peak = peak_rss_bytes()
        mib = peak / 1024 / 1024
        print(f"chunk={chunk_size:>7}: 耗时 {elapsed:5.1f}s  峰值RSS {mib:6.1f} MiB "
              f"(上限 192 MiB, 余量 {192 - mib:6.1f})")
        if peak >= LIMIT_BYTES:
            failures.append(f"chunk={chunk_size}: 峰值内存 {mib:.1f} MiB 超过 192 MiB")

        with open(summary, "r", encoding="utf-8", newline="") as f:
            rows = list(csv.reader(f))
        data = {(r[0], r[1]): r for r in rows[1:]}
        got = data[(STATION, DAY)]
        checks = [
            ("实报数", got[3], str(exp_n)),
            ("缺报数", got[4], "50000"),
            ("读数总和", got[5], str(exp_total)),
            ("p50", got[6], str(exp_p50)),
            ("p95", got[7], str(exp_p95)),
        ]
        for name, actual, expected in checks:
            if actual != expected:
                failures.append(f"chunk={chunk_size}: {name} 期望 {expected}, 实际 {actual}")
        zero = data[("S0", "2026-11-11")]
        if zero[3:] != ["0", "3", "0", "", ""]:
            failures.append(f"chunk={chunk_size}: 零报组输出错误: {zero}")

        with open(unplanned, "r", encoding="utf-8", newline="") as f:
            urows = list(csv.reader(f))
        if len(urows) != 4 or {r[2] for r in urows[1:]} != {"x0", "x1", "x2"}:
            failures.append(f"chunk={chunk_size}: 计划外文件内容错误: {urows}")

        if "同编号重传读数不一致" not in proc.stderr:
            failures.append(f"chunk={chunk_size}: 缺少冲突重传告警")

    if failures:
        print("\n失败项:")
        for msg in failures:
            print(" -", msg)
        sys.exit(1)
    print("\n全部通过: 内存达标, 去重/总和/分位数/缺报/计划外结果均与独立计算一致。")


if __name__ == "__main__":
    main()
