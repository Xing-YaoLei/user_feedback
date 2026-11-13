#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""站点观测日报批处理。

输入:
  观测明细 CSV: 站点, 日期, 记录编号, 整数读数 (表头支持中英文列名)
  上报计划 CSV: 站点, 日期, 应报数

输出:
  汇总 CSV:   站点,日期,应报数,实报数,缺报数,读数总和,p50,p95
  计划外 CSV: 站点,日期,记录编号,读数

规则:
  * 同一站点同一天同一记录编号的重传只计一次 (编号不同即使读数相同也分别计入)
  * 计划内当天零明细也输出一行, p50/p95 留空
  * 计划外 (站点+日期不在计划中) 的去重后记录单独列出
  * 明细无法解析时报出文件/行号/字段, 以非零码退出, 不覆盖上一次成功生成的结果
  * 外部排序 + 紧凑数组, 峰值内存与总记录数无关, 200 万条集中在同一组也低于 192 MiB

分位数定义: 最近秩法 (nearest rank), 下标 = ceil(p * n) - 1, 纯整数运算, 无插值。
"""

import argparse
import csv
import datetime
import heapq
import os
import re
import shutil
import sys
import tempfile
from array import array

DETAIL_COLUMNS = ("station", "date", "record_id", "reading")
PLAN_COLUMNS = ("station", "date", "expected")

DETAIL_ALIASES = {
    "station": ("站点", "site", "station"),
    "date": ("日期", "date"),
    "record_id": ("记录编号", "编号", "record_id", "id"),
    "reading": ("读数", "reading", "value"),
}
PLAN_ALIASES = {
    "station": ("站点", "site", "station"),
    "date": ("日期", "date"),
    "expected": ("应报数", "计划数", "expected", "plan_count", "planned"),
}

INT_RE = re.compile(r"^[+-]?\d+$")
DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
INT64_MIN = -(2 ** 63)
INT64_MAX = 2 ** 63 - 1

SUMMARY_HEADER = ["站点", "日期", "应报数", "实报数", "缺报数", "读数总和", "p50", "p95"]
UNPLANNED_HEADER = ["站点", "日期", "记录编号", "读数"]


class InputError(Exception):
    """输入数据错误, 携带文件位置信息。"""

    def __init__(self, path, line_num, message, raw=None, column=None):
        self.path = path
        self.line_num = line_num
        self.message = message
        self.raw = raw
        self.column = column
        loc = f"文件 {path} 第 {line_num} 行"
        if column:
            loc += f" 列[{column}]"
        text = f"{loc}: {message}"
        if raw is not None:
            text += f" | 原始内容: {raw.strip()[:200]}"
        super().__init__(text)


def map_header(header, aliases, expected_cols, kind, path):
    """把表头映射成固定列序号, 列数不符或缺列直接报错 (位置: 第 1 行)。"""
    if header is None:
        raise InputError(path, 1, f"{kind}为空或缺少表头")
    normalized = [h.strip().lstrip("﻿").lower() for h in header]
    if len(normalized) != len(expected_cols):
        raise InputError(
            path, 1, f"{kind}表头列数应为 {len(expected_cols)} 列, 实际为 {len(normalized)} 列",
            raw=",".join(header),
        )
    idx = {}
    for col in expected_cols:
        names = aliases[col]
        for i, name in enumerate(normalized):
            if name in names and i not in idx.values():
                idx[col] = i
                break
        if col not in idx:
            raise InputError(
                path, 1, f"{kind}缺少必需列 {col} (可接受列名: {'/'.join(aliases[col])})",
                raw=",".join(header), column=col,
            )
    return idx


def validate_date(value, path, line_num):
    if not DATE_RE.match(value):
        raise InputError(path, line_num, f"日期格式应为 YYYY-MM-DD, 得到 {value!r}", column="日期")
    y, m, d = (int(x) for x in value.split("-"))
    if not (1 <= m <= 12 and 1 <= d <= 31):
        raise InputError(path, line_num, f"日期超出合法范围: {value!r}", column="日期")
    # 用日历规则兜底 (例如 2 月 30 日)
    try:
        datetime.date(y, m, d)
    except ValueError:
        raise InputError(path, line_num, f"日期不是合法日历日期: {value!r}", column="日期")
    return value


def parse_int(value, path, line_num, column):
    if not INT_RE.match(value):
        raise InputError(path, line_num, f"{column}应为整数, 得到 {value!r}", column=column)
    return int(value)


def is_blank_row(row):
    return len(row) == 0 or all(not cell.strip() for cell in row)


def parse_plan(plan_path):
    """读取上报计划, 返回 {(station, date): expected_count}。"""
    plan = {}
    with open(plan_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            raise InputError(plan_path, 1, "上报计划为空或缺少表头")
        idx = map_header(header, PLAN_ALIASES, PLAN_COLUMNS, "上报计划", plan_path)
        for row in reader:
            if is_blank_row(row):
                continue
            line_num = reader.line_num
            if len(row) != len(PLAN_COLUMNS):
                raise InputError(
                    plan_path, line_num,
                    f"字段数应为 {len(PLAN_COLUMNS)}, 实际为 {len(row)}", raw=",".join(row),
                )
            station = row[idx["station"]].strip()
            day = row[idx["date"]].strip()
            expected_s = row[idx["expected"]].strip()
            if not station:
                raise InputError(plan_path, line_num, "站点不能为空", column="站点")
            validate_date(day, plan_path, line_num)
            expected = parse_int(expected_s, plan_path, line_num, "应报数")
            if expected < 0:
                raise InputError(plan_path, line_num, "应报数不能为负", column="应报数")
            key = (station, day)
            if key in plan:
                raise InputError(
                    plan_path, line_num,
                    f"计划重复: 站点 {station!r} 日期 {day} 在第 {plan[key][1]} 行已出现",
                    raw=",".join(row),
                )
            plan[key] = (expected, line_num)
    return {k: v[0] for k, v in plan.items()}


def write_run(chunk, tmpdir, seq):
    """块内排序后落盘为临时归并段, 字段: 站点,日期,记录编号,读数,源行号。

    源行号参与排序: 同编号记录严格按上报先后归并, 冲突时首次上报的读数权威。
    """
    chunk.sort(key=lambda r: (r[0], r[1], r[2], r[4]))
    path = os.path.join(tmpdir, f"run_{seq:06d}.csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(chunk)
    return path


def build_runs(details_path, chunk_size, tmpdir):
    """流式扫描明细, 校验并分块排序落盘。解析错误在此处抛出 (带准确行号)。"""
    run_paths = []
    total_rows = 0
    with open(details_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            raise InputError(details_path, 1, "观测明细为空或缺少表头")
        idx = map_header(header, DETAIL_ALIASES, DETAIL_COLUMNS, "观测明细", details_path)
        chunk = []
        seq = 0
        for row in reader:
            if is_blank_row(row):
                continue
            line_num = reader.line_num
            if len(row) != len(DETAIL_COLUMNS):
                raise InputError(
                    details_path, line_num,
                    f"字段数应为 {len(DETAIL_COLUMNS)}, 实际为 {len(row)}", raw=",".join(row),
                )
            station = row[idx["station"]].strip()
            day = row[idx["date"]].strip()
            record_id = row[idx["record_id"]].strip()
            reading_s = row[idx["reading"]].strip()
            if not station:
                raise InputError(details_path, line_num, "站点不能为空", column="站点")
            if not record_id:
                raise InputError(details_path, line_num, "记录编号不能为空", column="记录编号")
            validate_date(day, details_path, line_num)
            reading = parse_int(reading_s, details_path, line_num, "读数")
            chunk.append((station, day, record_id, reading, line_num))
            total_rows += 1
            if len(chunk) >= chunk_size:
                run_paths.append(write_run(chunk, tmpdir, seq))
                seq += 1
                chunk = []
        if chunk:
            run_paths.append(write_run(chunk, tmpdir, seq))
    return run_paths, total_rows


def nearest_rank(sorted_values, pct):
    """最近秩法分位数, pct 为百分数 (50/95), 纯整数运算。"""
    n = len(sorted_values)
    rank = (pct * n + 99) // 100  # ceil(pct * n / 100), 1-based
    return sorted_values[rank - 1]


class GroupState:
    __slots__ = ("count", "total", "values", "compact")

    def __init__(self):
        self.count = 0
        self.total = 0
        self.values = array("q")
        self.compact = True  # False 表示已回退为 Python list (读数超 int64)

    def add(self, reading):
        self.count += 1
        self.total += reading
        if self.compact:
            if INT64_MIN <= reading <= INT64_MAX:
                self.values.append(reading)
            else:
                self.values = list(self.values)
                self.values.append(reading)
                self.compact = False
        else:
            self.values.append(reading)

    def finalize(self):
        """返回 (实报数, 总和, p50, p95), 随后释放读数容器。"""
        ordered = sorted(self.values)
        p50 = nearest_rank(ordered, 50)
        p95 = nearest_rank(ordered, 95)
        result = (self.count, self.total, p50, p95)
        self.values = None
        return result


def merge_and_aggregate(run_paths, plan, unplanned_tmp_path):
    """多路归并去重并聚合。

    归并后同 (站点,日期,编号) 记录相邻, 去重只需记住上一个编号, O(1) 额外内存。
    同编号重传读数不一致时以首次为准, 累计冲突数并返回样例用于告警。
    返回 (stats, unplanned_count, conflict_count, conflict_samples)。
    """
    handles = [open(p, "r", encoding="utf-8", newline="") for p in run_paths]
    stats = {}
    conflict_count = 0
    conflict_samples = []
    unplanned_count = 0
    try:
        readers = [csv.reader(h) for h in handles]
        merged = heapq.merge(
            *readers, key=lambda r: (r[0], r[1], r[2], int(r[4]))
        )
        with open(unplanned_tmp_path, "w", encoding="utf-8", newline="") as uf:
            uwriter = csv.writer(uf)
            uwriter.writerow(UNPLANNED_HEADER)

            cur_key = None
            last_id = None
            last_reading = None
            state = None

            def flush():
                if state is not None:
                    stats[cur_key] = state.finalize()

            for row in merged:
                station, day, record_id, reading_s, src_line = row
                reading = int(reading_s)
                key = (station, day)
                if key != cur_key:
                    flush()
                    cur_key = key
                    last_id = None
                    state = GroupState() if key in plan else None
                if record_id == last_id:
                    # 同编号重传: 只计一次
                    if reading != last_reading and conflict_count < 5:
                        conflict_samples.append(
                            (station, day, record_id, last_reading, reading, int(src_line))
                        )
                    if reading != last_reading:
                        conflict_count += 1
                    continue
                last_id = record_id
                last_reading = reading
                if state is None:
                    uwriter.writerow((station, day, record_id, reading))
                    unplanned_count += 1
                else:
                    state.add(reading)
            flush()
    finally:
        for h in handles:
            h.close()
    return stats, unplanned_count, conflict_count, conflict_samples


def write_summary(summary_tmp_path, plan, stats):
    with open(summary_tmp_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(SUMMARY_HEADER)
        for key in sorted(plan):
            station, day = key
            expected = plan[key]
            if key in stats:
                actual, total, p50, p95 = stats[key]
            else:
                actual, total, p50, p95 = 0, 0, None, None
            missing = expected - actual
            if missing < 0:
                missing = 0
            writer.writerow([
                station, day, expected, actual, missing, total,
                "" if p50 is None else p50,
                "" if p95 is None else p95,
            ])


def atomic_publish(tmp_path, final_path):
    out_dir = os.path.dirname(os.path.abspath(final_path))
    os.makedirs(out_dir, exist_ok=True)
    os.replace(tmp_path, final_path)


def run(details_path, plan_path, summary_out, unplanned_out, chunk_size):
    plan = parse_plan(plan_path)
    tmp_dir = tempfile.mkdtemp(prefix="daily_report_")
    summary_tmp = os.path.join(tmp_dir, "summary.csv")
    unplanned_tmp = os.path.join(tmp_dir, "unplanned.csv")
    try:
        run_paths, total_rows = build_runs(details_path, chunk_size, tmp_dir)
        stats, unplanned_count, conflict_count, conflict_samples = merge_and_aggregate(
            run_paths, plan, unplanned_tmp
        )
        write_summary(summary_tmp, plan, stats)
        # 全部成功后才原子替换, 此前任何报错都不会动已有结果
        atomic_publish(summary_tmp, summary_out)
        atomic_publish(unplanned_tmp, unplanned_out)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    planned_groups = len(plan)
    zero_groups = sum(1 for k in plan if k not in stats)
    print(
        f"完成: 明细 {total_rows} 行, 计划站点-日期 {planned_groups} 组 "
        f"(其中零报 {zero_groups} 组), 计划外记录 {unplanned_count} 条",
        file=sys.stderr,
    )
    if conflict_count:
        print(
            f"警告: 发现 {conflict_count} 条同编号重传读数不一致, 已按首次上报取值",
            file=sys.stderr,
        )
        for station, day, rid, first_val, dup_val, src_line in conflict_samples:
            print(
                f"  样例: {details_path} 第 {src_line} 行 站点={station} 日期={day} "
                f"编号={rid} 首次读数={first_val} 重传读数={dup_val}",
                file=sys.stderr,
            )
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="站点观测日报批处理: 去重、缺报核对与精确分位数统计",
    )
    parser.add_argument("--details", required=True, help="观测明细 CSV 路径")
    parser.add_argument("--plan", required=True, help="上报计划 CSV 路径")
    parser.add_argument("--summary-out", required=True, help="汇总 CSV 输出路径")
    parser.add_argument("--unplanned-out", required=True, help="计划外记录 CSV 输出路径")
    parser.add_argument(
        "--chunk-size", type=int, default=150000,
        help="外部排序单块行数, 默认 150000 (越大越快、占用内存越高)",
    )
    args = parser.parse_args(argv)
    if args.chunk_size <= 0:
        parser.error("--chunk-size 必须为正整数")
    for label, path in (("观测明细", args.details), ("上报计划", args.plan)):
        if not os.path.isfile(path):
            print(f"错误: {label}文件不存在: {path}", file=sys.stderr)
            return 2
    try:
        return run(
            args.details, args.plan, args.summary_out,
            args.unplanned_out, args.chunk_size,
        )
    except InputError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        print("已中止, 未修改任何已有输出文件 (保留上一次成功生成的结果)", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
