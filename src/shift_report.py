#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按班次日历统计每条产线的运行 / 停机 / 未知时长，并输出可追溯到原始事件的区间明细。

输入
----
1. 设备状态变化事件 JSONL，每行一个 JSON 对象，字段：
   line_id     产线编号
   timestamp   带时区偏移的发生时间（ISO 8601，如 2026-11-12T21:55:00+08:00）
   seq         设备序号（整数）
   status      状态，如 RUNNING / DOWN（大小写不敏感，支持中文别名）
   事件可以乱序、重复；同一产线同一时刻的多条事件以最大 seq 为准。

2. 班次日历 CSV（UTF-8，可带 BOM），字段：
   shift_id, start, end, line_id(可空，空行表示对所有产线生效)
   start / end 为带时区偏移的 ISO 8601 时间；允许 end 跨午夜（end < start 即按次日理解）。

输出
----
- shift_summary.csv  每班每线的运行/停机/未知秒数（三者之和 = 班次实际时长）
- intervals.jsonl    区间明细，每条区间带状态、起止、秒数和来源事件（行号可回溯原始 JSONL）

用法
----
python3 -I src/shift_report.py --events data/events.jsonl --shifts data/shifts.csv \
        --outdir out
python3 -I src/shift_report.py --selftest
"""

from __future__ import annotations

import argparse
import bisect
import csv
import io
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# 状态归一化：左侧为原始状态（小写），右侧为三种规范状态
# ---------------------------------------------------------------------------
RUNNING = "RUNNING"
DOWN = "DOWN"
UNKNOWN = "UNKNOWN"

STATUS_ALIASES = {
    "running": RUNNING,
    "run": RUNNING,
    "up": RUNNING,
    "on": RUNNING,
    "运行": RUNNING,
    "运行中": RUNNING,
    "开机": RUNNING,
    "down": DOWN,
    "stop": DOWN,
    "stopped": DOWN,
    "offline": DOWN,
    "fault": DOWN,
    "停机": DOWN,
    "停止": DOWN,
    "故障": DOWN,
    "关机": DOWN,
    "unknown": UNKNOWN,
    "unk": UNKNOWN,
    "na": UNKNOWN,
    "n/a": UNKNOWN,
    "未知": UNKNOWN,
}


def normalize_status(raw):
    """把原始状态映射到 RUNNING / DOWN / UNKNOWN，无法识别按 UNKNOWN 处理。"""
    if raw is None:
        return UNKNOWN
    key = str(raw).strip().lower()
    return STATUS_ALIASES.get(key, UNKNOWN)


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------
@dataclass
class Event:
    line_id: str
    ts: datetime          # 始终带 tzinfo（UTC 感知）
    seq: int
    status: str           # 归一化后的状态
    raw_status: str
    source_line: int      # 在原始 JSONL 中的行号（从 1 开始）
    raw_timestamp: str


@dataclass
class Shift:
    shift_id: str
    start: datetime       # 感知时区（内部统一为 UTC，便于比较计算）
    end: datetime
    line_id: str | None   # None 表示全局班次，对所有产线生效
    display_tz: timezone = timezone.utc  # 班次日历使用的原始偏移，用于输出渲染


@dataclass
class Segment:
    start: datetime
    end: datetime
    status: str
    source_event: Event | None   # None 表示未知区间（无事件支撑）


# ---------------------------------------------------------------------------
# 时间解析
# ---------------------------------------------------------------------------
_OFFSET_RE = re.compile(r"(.*?)([+-]\d{2})(\d{2})$")


def parse_iso8601(value):
    """解析带时区偏移的 ISO 8601 时间，返回 (UTC 感知 datetime, 原始偏移 tz)；无时区则报错。"""
    text = str(value).strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    # 兼容形如 +0800 / -0500 的无冒号偏移
    m = _OFFSET_RE.match(text)
    if m:
        text = f"{m.group(1)}{m.group(2)}:{m.group(3)}"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"无法解析时间 {value!r}: {exc}") from exc
    if dt.tzinfo is None:
        raise ValueError(f"时间 {value!r} 缺少时区偏移，无法与班次日历对齐")
    original_tz = timezone(dt.utcoffset())
    return dt.astimezone(timezone.utc), original_tz


def format_ts(dt, tz):
    """按指定时区渲染时间字符串（保留偏移，便于人工核对）。"""
    return dt.astimezone(tz).isoformat()


def seconds_between(a, b):
    """时间差转秒：整数秒返回 int，带亚秒精度时保留最多 6 位小数。"""
    micros = (b - a) // timedelta(microseconds=1)
    if micros % 1_000_000 == 0:
        return micros // 1_000_000
    return micros / 1_000_000


# ---------------------------------------------------------------------------
# 读取事件 JSONL
# ---------------------------------------------------------------------------
def _pick(d, *names):
    for n in names:
        if n in d:
            return d[n]
    return None


def load_events(path, warnings):
    events = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                warnings.append(f"第 {lineno} 行 JSON 解析失败，已跳过: {exc}")
                continue
            if not isinstance(obj, dict):
                warnings.append(f"第 {lineno} 行不是 JSON 对象，已跳过")
                continue

            line_id = _pick(obj, "line_id", "line", "lineId")
            ts_raw = _pick(obj, "timestamp", "time", "ts", "event_time")
            seq_raw = _pick(obj, "seq", "sequence", "device_seq", "serial")
            status_raw = _pick(obj, "status", "state", "device_status")

            if line_id is None or ts_raw is None or status_raw is None:
                warnings.append(
                    f"第 {lineno} 行缺少 line_id/timestamp/status 之一，已跳过: {obj!r}"
                )
                continue
            try:
                ts, _ = parse_iso8601(ts_raw)
            except ValueError as exc:
                warnings.append(f"第 {lineno} 行 {exc}，已跳过")
                continue

            if seq_raw is None:
                warnings.append(f"第 {lineno} 行缺少 seq，按 0 处理")
                seq = 0
            else:
                try:
                    seq = int(seq_raw)
                except (TypeError, ValueError):
                    warnings.append(f"第 {lineno} 行 seq={seq_raw!r} 不是整数，按 0 处理")
                    seq = 0

            norm = normalize_status(status_raw)
            if norm == UNKNOWN and str(status_raw).strip().lower() not in STATUS_ALIASES:
                warnings.append(
                    f"第 {lineno} 行状态 {status_raw!r} 无法识别，按 UNKNOWN 处理"
                )

            events.append(
                Event(
                    line_id=str(line_id),
                    ts=ts,
                    seq=seq,
                    status=norm,
                    raw_status=str(status_raw),
                    source_line=lineno,
                    raw_timestamp=str(ts_raw),
                )
            )
    return events


def dedupe_events(events, warnings):
    """
    按产线归并事件：
    - 同一产线同一时刻可能有多条（乱序、重复）；
    - 完全相同的 (ts, seq, status) 视为重复，保留第一条并计数；
    - 同时刻不同记录以最大 seq 为准；seq 相同而状态冲突时告警并以后到者为准。
    返回 {line_id: [Event(按时间升序)]}。
    """
    by_line: dict[str, list[Event]] = {}
    dup_count = 0
    for ev in events:
        by_line.setdefault(ev.line_id, []).append(ev)

    result: dict[str, list[Event]] = {}
    for line_id, evs in by_line.items():
        # 同一时刻分组，保持稳定（依赖原始行号作为次序）
        evs.sort(key=lambda e: (e.ts, e.source_line))
        chosen: list[Event] = []
        i = 0
        while i < len(evs):
            j = i + 1
            while j < len(evs) and evs[j].ts == evs[i].ts:
                j += 1
            group = evs[i:j]
            winner = group[0]
            seen_keys = {(winner.seq, winner.status)}
            for cand in group[1:]:
                key = (cand.seq, cand.status)
                if key in seen_keys:
                    dup_count += 1
                    continue
                seen_keys.add(key)
                if cand.seq > winner.seq:
                    winner = cand
                elif cand.seq == winner.seq and cand.status != winner.status:
                    warnings.append(
                        f"产线 {line_id} 在 {winner.raw_timestamp} 存在同 seq={cand.seq} "
                        f"的状态冲突（{winner.raw_status} / {cand.raw_status}），"
                        f"取后到者 {cand.raw_status}（第 {cand.source_line} 行）"
                    )
                    winner = cand
            chosen.append(winner)
            i = j
        result[line_id] = chosen
    if dup_count:
        warnings.append(f"检测到 {dup_count} 条完全重复事件，已自动去重")
    return result


# ---------------------------------------------------------------------------
# 读取班次日历 CSV
# ---------------------------------------------------------------------------
def load_shifts(path, warnings):
    shifts = []
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise ValueError("班次日历 CSV 为空或缺少表头")
        for rowno, row in enumerate(reader, start=2):  # 表头占第 1 行
            shift_id = (row.get("shift_id") or row.get("shift") or "").strip()
            start_raw = (row.get("start") or row.get("start_time") or "").strip()
            end_raw = (row.get("end") or row.get("end_time") or "").strip()
            line_id = (row.get("line_id") or row.get("line") or "").strip()
            if not shift_id or not start_raw or not end_raw:
                warnings.append(f"班次 CSV 第 {rowno} 行缺少 shift_id/start/end，已跳过")
                continue
            try:
                start, start_tz = parse_iso8601(start_raw)
                end, end_tz = parse_iso8601(end_raw)
            except ValueError as exc:
                warnings.append(f"班次 CSV 第 {rowno} 行 {exc}，已跳过")
                continue
            # 记录日历原始偏移，输出时按该时区渲染时间
            display_tz = start_tz
            # 跨午夜：end 的时钟时间早于 start 时，按 start 的下一天理解，
            # 沿用 end 自带的偏移量。
            if end <= start:
                end_local = end.astimezone(end_tz)
                end = (end_local + timedelta(days=1)).astimezone(timezone.utc)
                warnings.append(
                    f"班次 {shift_id} 的 end 不晚于 start，按跨午夜处理 -> "
                    f"{format_ts(start, display_tz)} ~ {format_ts(end, end_tz)}"
                )
            shifts.append(
                Shift(
                    shift_id=shift_id,
                    start=start,
                    end=end,
                    line_id=line_id or None,
                    display_tz=display_tz,
                )
            )
    shifts.sort(key=lambda s: (s.line_id or "", s.start))
    return shifts


def shifts_for_line(line_id, all_shifts):
    """产线专属班次优先；没有专属行时，使用全局（line_id 为空）班次。"""
    specific = [s for s in all_shifts if s.line_id == line_id]
    if specific:
        return sorted(specific, key=lambda s: s.start)
    return sorted((s for s in all_shifts if s.line_id is None), key=lambda s: s.start)


# ---------------------------------------------------------------------------
# 核心：把事件时间线裁进某个班次
# ---------------------------------------------------------------------------
def build_segments(line_events, shift):
    """
    生成班次 [shift.start, shift.end) 内的状态区间。

    规则：
    - 班次开头带入此前最后一条事件的状态（无论事件距班次多早）；
    - 此前没有任何事件时，班次开头到首条事件之间记为 UNKNOWN；
    - 状态持续到下一次变化；事件落在班次边界上时，end 处的事件不产生零长区间。
    """
    times = [e.ts for e in line_events]
    # 严格位于班次结束之前的事件（end 上的事件属于下一个区间，本时段不产生长度）
    idx_end = bisect.bisect_left(times, shift.end)

    segments: list[Segment] = []

    # 1) 班次开头的状态：取 start 之前（不含 start 时刻）最后一条事件
    prior_idx = bisect.bisect_left(times, shift.start) - 1
    if prior_idx >= 0:
        current = line_events[prior_idx]
        cursor = shift.start
    else:
        current = None
        cursor = shift.start

    # 2) 依次处理 [start, end) 内的变化事件
    idx = prior_idx + 1
    while idx < idx_end:
        ev = line_events[idx]
        if ev.ts > cursor:
            segments.append(
                Segment(cursor, ev.ts, current.status if current else UNKNOWN, current)
            )
        current = ev
        cursor = ev.ts
        idx += 1

    # 3) 收尾到班次结束
    if cursor < shift.end:
        segments.append(
            Segment(cursor, shift.end, current.status if current else UNKNOWN, current)
        )
    return segments


def summarize(segments):
    totals = {RUNNING: 0, DOWN: 0, UNKNOWN: 0}
    for seg in segments:
        totals[seg.status] += seconds_between(seg.start, seg.end)
    # 整型归一化（浮点累加可能产生 28500.0）
    for k, v in totals.items():
        if isinstance(v, float) and v.is_integer():
            totals[k] = int(v)
    return totals


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
def run(events_path, shifts_path, outdir):
    warnings: list[str] = []
    raw_events = load_events(events_path, warnings)
    events_by_line = dedupe_events(raw_events, warnings)
    shifts = load_shifts(shifts_path, warnings)

    line_ids = sorted(events_by_line.keys())
    # 仅在专属班次中出现、但没有任何事件的产线也要进报告
    for s in shifts:
        if s.line_id and s.line_id not in line_ids:
            line_ids.append(s.line_id)
    line_ids = sorted(set(line_ids))

    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    summary_path = outdir / "shift_summary.csv"
    interval_path = outdir / "intervals.jsonl"

    summary_rows = []
    interval_records = []
    invariant_errors = []

    for line_id in line_ids:
        line_events = events_by_line.get(line_id, [])
        line_shifts = shifts_for_line(line_id, shifts)
        if not line_shifts:
            warnings.append(f"产线 {line_id} 有事件但班次日历中没有匹配班次，未统计")
            continue

        for shift in line_shifts:
            segs = build_segments(line_events, shift)
            totals = summarize(segs)
            shift_len = seconds_between(shift.start, shift.end)
            total_three = totals[RUNNING] + totals[DOWN] + totals[UNKNOWN]
            if total_three != shift_len:
                invariant_errors.append(
                    f"{line_id}/{shift.shift_id}: 三种时长之和 {total_three}s "
                    f"!= 班次时长 {shift_len}s"
                )

            # 按班次日历的原始偏移渲染，便于班组按本地时间核对
            render_tz = shift.display_tz
            summary_rows.append(
                {
                    "line_id": line_id,
                    "shift_id": shift.shift_id,
                    "shift_start": format_ts(shift.start, render_tz),
                    "shift_end": format_ts(shift.end, render_tz),
                    "shift_seconds": shift_len,
                    "running_seconds": totals[RUNNING],
                    "down_seconds": totals[DOWN],
                    "unknown_seconds": totals[UNKNOWN],
                }
            )

            for n, seg in enumerate(segs, start=1):
                rec = {
                    "line_id": line_id,
                    "shift_id": shift.shift_id,
                    "segment_no": n,
                    "start": format_ts(seg.start, render_tz),
                    "end": format_ts(seg.end, render_tz),
                    "duration_seconds": seconds_between(seg.start, seg.end),
                    "status": seg.status,
                    "source_line": seg.source_event.source_line if seg.source_event else None,
                    "source_event": (
                        {
                            "timestamp": seg.source_event.raw_timestamp,
                            "seq": seg.source_event.seq,
                            "status": seg.source_event.raw_status,
                        }
                        if seg.source_event
                        else None
                    ),
                }
                interval_records.append(rec)

    with open(summary_path, "w", encoding="utf-8", newline="") as fh:
        fields = [
            "line_id", "shift_id", "shift_start", "shift_end", "shift_seconds",
            "running_seconds", "down_seconds", "unknown_seconds",
        ]
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(summary_rows)

    with open(interval_path, "w", encoding="utf-8") as fh:
        for rec in interval_records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    return {
        "summary_path": summary_path,
        "interval_path": interval_path,
        "warnings": warnings,
        "invariant_errors": invariant_errors,
        "rows": summary_rows,
        "intervals": interval_records,
    }


# ---------------------------------------------------------------------------
# 自测：用内存中的临时文件覆盖关键边界
# ---------------------------------------------------------------------------
def _selftest():
    import tempfile

    events_jsonl = "\n".join([
        # L1：乱序 + 重复 + 同时刻不同 seq；07:00 的事件给白班提供前置状态
        json.dumps({"line_id": "L1", "timestamp": "2026-11-12T07:00:00+08:00",
                    "seq": 1, "status": "RUNNING"}),                 # 行1
        json.dumps({"line_id": "L1", "timestamp": "2026-11-12T20:00:00+08:00",
                    "seq": 1, "status": "RUNNING"}),                 # 行2
        json.dumps({"line_id": "L1", "timestamp": "2026-11-12T21:55:00+08:00",
                    "seq": 1, "status": "DOWN"}),                    # 行2
        json.dumps({"line_id": "L1", "timestamp": "2026-11-12T22:10:00+08:00",
                    "seq": 1, "status": "RUNNING"}),                 # 行3
        json.dumps({"line_id": "L1", "timestamp": "2026-11-12T21:55:00+08:00",
                    "seq": 2, "status": "DOWN"}),                    # 行4 seq 更大，胜出
        json.dumps({"line_id": "L1", "timestamp": "2026-11-12T21:55:00+08:00",
                    "seq": 2, "status": "DOWN"}),                    # 行5 完全重复
        json.dumps({"line_id": "L1", "timestamp": "2026-11-12T22:10:00+08:00",
                    "seq": 1, "status": "RUNNING"}),                 # 行6 完全重复
        # L2：首条事件晚于班次开头 -> 前段 UNKNOWN
        json.dumps({"line_id": "L2", "timestamp": "2026-11-12T09:30:00+08:00",
                    "seq": 3, "status": "运行"}),                    # 行7
        json.dumps({"line_id": "L2", "timestamp": "2026-11-12T15:00:00+08:00",
                    "seq": 3, "status": "停机"}),                    # 行8
        # L3：全天无事件，两个班次都应是 UNKNOWN
        # L4：不同 UTC 偏移表示同一时刻，验证时区换算（01:55Z == 09:55+08）
        json.dumps({"line_id": "L4", "timestamp": "2026-11-12T01:55:00Z",
                    "seq": 1, "status": "RUNNING"}),                # 行9
        json.dumps({"line_id": "L4", "timestamp": "2026-11-12T10:00:00+08:00",
                    "seq": 1, "status": "DOWN"}),                   # 行10
    ]) + "\n"

    shifts_csv = "\n".join([
        "shift_id,start,end,line_id",
        # 白班 08:00-22:00（14h）/ 夜班 22:00-次日 08:00（10h），22:00 换班
        "DAY,2026-11-12T08:00:00+08:00,2026-11-12T22:00:00+08:00,",
        "NIGHT,2026-11-12T22:00:00+08:00,2026-11-13T08:00:00+08:00,",
        # L3 专属班次（无事件）
        "D3,2026-11-12T08:00:00+08:00,2026-11-12T22:00:00+08:00,L3",
    ]) + "\n"

    with tempfile.TemporaryDirectory() as tmp:
        ep = Path(tmp) / "events.jsonl"
        sp = Path(tmp) / "shifts.csv"
        ep.write_text(events_jsonl, encoding="utf-8")
        sp.write_text(shifts_csv, encoding="utf-8")
        result = run(ep, sp, Path(tmp) / "out")

    if result["invariant_errors"]:
        raise AssertionError("秒数守恒失败: " + "; ".join(result["invariant_errors"]))

    rows = {(r["line_id"], r["shift_id"]): r for r in result["rows"]}

    def check(cond, msg):
        if not cond:
            raise AssertionError(msg)

    # L1 白班（08:00-22:00，50400s）：带入 20:00 的 RUNNING；
    # 21:55 DOWN -> 5 分钟计入白班，与用户场景一致
    r = rows[("L1", "DAY")]
    check(r["down_seconds"] == 300, f"L1/DAY down={r['down_seconds']}")
    check(r["running_seconds"] == 50400 - 300, f"L1/DAY running={r['running_seconds']}")
    check(r["unknown_seconds"] == 0, f"L1/DAY unknown={r['unknown_seconds']}")

    # L1 夜班（22:00-次日08:00，36000s）：带入 DOWN，22:10 恢复 -> DOWN 10 分钟
    r = rows[("L1", "NIGHT")]
    check(r["down_seconds"] == 600, f"L1/NIGHT down={r['down_seconds']}")
    check(r["running_seconds"] == 36000 - 600, f"L1/NIGHT running={r['running_seconds']}")
    check(r["unknown_seconds"] == 0, f"L1/NIGHT unknown={r['unknown_seconds']}")

    # L2 白班：08:00-09:30 UNKNOWN(5400s)，运行到 15:00，之后停机
    r = rows[("L2", "DAY")]
    check(r["unknown_seconds"] == 5400, f"L2/DAY unknown={r['unknown_seconds']}")
    check(r["running_seconds"] == 5.5 * 3600, f"L2/DAY running={r['running_seconds']}")
    check(r["down_seconds"] == 50400 - 5400 - 5.5 * 3600, f"L2/DAY down={r['down_seconds']}")
    # L2 夜班：带入 15:00 的停机状态，整班 DOWN
    r = rows[("L2", "NIGHT")]
    check(r["down_seconds"] == 36000 and r["unknown_seconds"] == 0,
          f"L2/NIGHT {r}")

    # L3：无事件，专属班次整段 UNKNOWN
    r = rows[("L3", "D3")]
    check(r["unknown_seconds"] == 50400, f"L3/D3 {r}")

    # L4：时区换算后 09:55 变化，白班前 1h55m 未知，之后运行 5 分钟到 10:00 停机
    r = rows[("L4", "DAY")]
    check(r["unknown_seconds"] == (1 * 3600 + 55 * 60), f"L4/DAY {r}")
    check(r["running_seconds"] == 300, f"L4/DAY running={r['running_seconds']}")
    check(r["down_seconds"] == 50400 - 6900 - 300, f"L4/DAY down={r['down_seconds']}")

    # 追溯：L1/DAY 的停机区间必须指向原始第 2/4 行中的胜出事件（第 4 行 seq=2）
    down_seg = next(
        x for x in result["intervals"]
        if x["line_id"] == "L1" and x["shift_id"] == "DAY" and x["status"] == "DOWN"
    )
    check(down_seg["source_line"] == 5, f"追溯行号错误: {down_seg}")
    check(down_seg["duration_seconds"] == 300, f"停机区间秒数错误: {down_seg}")

    # 未知区间没有来源事件
    unk_seg = next(
        x for x in result["intervals"]
        if x["line_id"] == "L2" and x["status"] == "UNKNOWN"
    )
    check(unk_seg["source_event"] is None and unk_seg["source_line"] is None,
          f"未知区间不应有来源: {unk_seg}")

    print("selftest OK: 全部断言通过（乱序/去重/同时刻取最大 seq/带入前置状态/"
          "未知开头/跨午夜/时区换算/秒数守恒/事件追溯）")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="按班次统计产线运行/停机/未知时长并输出区间明细"
    )
    parser.add_argument("--events", help="设备状态事件 JSONL 路径")
    parser.add_argument("--shifts", help="班次日历 CSV 路径")
    parser.add_argument("--outdir", default="out", help="输出目录（默认 out）")
    parser.add_argument("--selftest", action="store_true", help="运行内置自测")
    args = parser.parse_args(argv)

    if args.selftest:
        _selftest()
        return 0

    if not args.events or not args.shifts:
        parser.error("非自测模式必须提供 --events 和 --shifts")

    result = run(args.events, args.shifts, args.outdir)

    print(f"汇总输出: {result['summary_path']}")
    print(f"区间明细: {result['interval_path']}")
    print()
    print(f"{'产线':<8}{'班次':<8}{'班次时长':>10}{'运行':>10}{'停机':>10}{'未知':>10}")
    for r in result["rows"]:
        print(f"{r['line_id']:<8}{r['shift_id']:<8}{r['shift_seconds']:>10}"
              f"{r['running_seconds']:>10}{r['down_seconds']:>10}{r['unknown_seconds']:>10}")

    if result["warnings"]:
        print("\n告警:")
        for w in result["warnings"]:
            print(f"  - {w}")
    if result["invariant_errors"]:
        print("\n错误: 秒数守恒校验未通过", file=sys.stderr)
        for e in result["invariant_errors"]:
            print(f"  - {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
