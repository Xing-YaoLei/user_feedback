"""命令行入口。

示例
----
# 分批导入校准记录与测量明细
python -m backcalc import-cal --db data.db --file cal_batch1.csv
python -m backcalc import-meas --db data.db --file meas_batch1.jsonl

# 按登记截止时间查询（同截止时间重查复用冻结快照）
python -m backcalc query --db data.db --cutoff 2026-06-30T23:59:59Z

# 查看导入数据中同仪器同登记时刻的区间重叠冲突
python -m backcalc conflicts --db data.db

# 列出各次查询与变更统计
python -m backcalc runs --db data.db
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from typing import Optional

from . import engine
from .io_utils import InputError, read_calibrations, read_measurements
from .store import Store
from .timeutil import normalize_ts

_STATUS_TEXT = {
    "calibrated": "已校准",
    "uncalibrated": "未校准",
    "conflict": "冲突",
}


def _print_json(obj) -> None:
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2, default=str)
    sys.stdout.write("\n")


def _open_store(args) -> Store:
    return Store(args.db)


def cmd_import_cal(args) -> int:
    rows = read_calibrations(args.file)
    store = _open_store(args)
    try:
        with store.transaction():
            batch_id = store.add_batch("calibration", args.file, len(rows))
            store.upsert_calibrations(rows, batch_id)
    finally:
        store.close()
    print(f"已导入校准记录 {len(rows)} 条（文件: {args.file}）")
    return 0


def cmd_import_meas(args) -> int:
    rows = read_measurements(args.file)
    store = _open_store(args)
    try:
        with store.transaction():
            batch_id = store.add_batch("measurement", args.file, len(rows))
            store.upsert_measurements(rows, batch_id)
    finally:
        store.close()
    print(f"已导入测量明细 {len(rows)} 条（文件: {args.file}）")
    return 0


def _result_to_dict(row) -> dict:
    return {
        "measurement_id": row["measurement_id"],
        "instrument": row["instrument"],
        "measured_at": row["measured_at"],
        "raw_reading": row["raw_reading"],
        "status": row["status"],
        "status_text": _STATUS_TEXT.get(row["status"], row["status"]),
        "cal_id": row["cal_id"],
        "calibrated": row["calibrated"],
        "conflict_cal_ids": json.loads(row["conflict_cal_ids"])
            if row["conflict_cal_ids"] else [],
    }


def _change_to_dict(row) -> dict:
    return {
        "measurement_id": row["measurement_id"],
        "instrument": row["instrument"],
        "before": {
            "status": row["old_status"],
            "cal_id": row["old_cal_id"],
            "calibrated": row["old_calibrated"],
        },
        "after": {
            "status": row["new_status"],
            "cal_id": row["new_cal_id"],
            "calibrated": row["new_calibrated"],
        },
    }


def cmd_query(args) -> int:
    cutoff = normalize_ts(args.cutoff)
    store = _open_store(args)
    try:
        run = engine.ensure_run(store, cutoff, note=args.note)
        results = [_result_to_dict(r)
                   for r in store.list_results(run.run_id, args.instrument)]
        changes = [_change_to_dict(r)
                   for r in store.list_changes(run.run_id)]
    finally:
        store.close()

    if args.format == "json":
        _print_json({
            "cutoff": cutoff,
            "run_id": run.run_id,
            "snapshot_reused": run.reused,
            "total": run.total,
            "returned": len(results),
            "change_count": len(changes),
            "changes": changes,
            "results": results,
        })
        return 0

    print(f"截止时间: {cutoff}  run_id={run.run_id}  "
          f"快照{'复用（结果为当时冻结版本）' if run.reused else '新建'}  "
          f"测量 {run.total} 条  本次来源变化 {len(changes)} 条")
    if changes:
        print("\n== 受影响测量（校准来源实际变化） ==")
        for ch in changes:
            before = (f"{ch['before']['status']}/{ch['before']['cal_id']}/"
                      f"{_fmt_num(ch['before']['calibrated'])}")
            after = (f"{ch['after']['status']}/{ch['after']['cal_id']}/"
                     f"{_fmt_num(ch['after']['calibrated'])}")
            print(f"  {ch['measurement_id']} ({ch['instrument']}): "
                  f"{before}  ->  {after}")
    print("\n== 回算结果 ==")
    for r in results:
        if r["status"] == "calibrated":
            tail = f"cal={r['cal_id']} 回算值={_fmt_num(r['calibrated'])}"
            if r["conflict_cal_ids"]:
                tail += (f"  ⚠ 同登记时刻冲突 {','.join(r['conflict_cal_ids'])}"
                         f"，已保留上次有效结果 {r['cal_id']}")
        elif r["status"] == "conflict":
            tail = (f"冲突且无上次有效结果，标记未决；"
                    f"冲突校准={','.join(r['conflict_cal_ids'])}")
        else:
            tail = "未校准"
        print(f"  {r['measurement_id']} [{r['instrument']}] "
              f"t={r['measured_at']} 原始={r['raw_reading']}  {tail}")
    return 0


def _fmt_num(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value:.6g}"


def cmd_conflicts(args) -> int:
    cutoff = normalize_ts(args.cutoff) if args.cutoff else None
    store = _open_store(args)
    try:
        conflicts = engine.list_conflicts(store, cutoff)
    finally:
        store.close()
    if args.format == "json":
        _print_json({"cutoff": cutoff, "conflicts": conflicts})
        return 0
    if not conflicts:
        print("未发现同仪器、同登记时刻的生效区间重叠。")
        return 0
    print(f"发现 {len(conflicts)} 组区间重叠冲突：")
    for c in conflicts:
        print(f"  仪器 {c['instrument']}  登记时刻 {c['registered_at']}")
        print(f"    {c['cal_id_a']}: {c['interval_a']}")
        print(f"    {c['cal_id_b']}: {c['interval_b']}")
    return 0


def cmd_runs(args) -> int:
    store = _open_store(args)
    try:
        rows = store.conn.execute(
            "SELECT r.run_id, r.cutoff, r.created_at, r.note, "
            "(SELECT COUNT(*) FROM result x WHERE x.run_id = r.run_id) AS n, "
            "(SELECT COUNT(*) FROM run_change c WHERE c.run_id = r.run_id) AS chg "
            "FROM run r ORDER BY r.cutoff"
        ).fetchall()
    finally:
        store.close()
    if args.format == "json":
        _print_json([dict(r) for r in rows])
        return 0
    if not rows:
        print("尚无查询快照。")
        return 0
    print(f"{'run_id':>6}  {'截止时间':24}  {'结果数':>6}  {'变更数':>6}  备注")
    for r in rows:
        print(f"{r['run_id']:>6}  {r['cutoff']:24}  {r['n']:>6}  "
              f"{r['chg']:>6}  {r['note'] or ''}")
    return 0


def cmd_export(args) -> int:
    cutoff = normalize_ts(args.cutoff)
    store = _open_store(args)
    try:
        run = store.find_run(cutoff)
        if run is None:
            print(f"截止时间 {cutoff} 尚无快照，请先 query。", file=sys.stderr)
            return 2
        rows = store.list_results(run["run_id"], args.instrument)
    finally:
        store.close()
    fieldnames = ["measurement_id", "instrument", "measured_at",
                  "raw_reading", "status", "cal_id", "calibrated",
                  "conflict_cal_ids"]
    writer = csv.DictWriter(sys.stdout, fieldnames=fieldnames)
    writer.writeheader()
    for r in rows:
        d = _result_to_dict(r)
        d["conflict_cal_ids"] = ";".join(d["conflict_cal_ids"])
        writer.writerow({k: d.get(k) for k in fieldnames})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="backcalc",
        description="校准记录双时态回算与增量重算工具")
    parser.add_argument("--db", default="backcalc.db", help="SQLite 数据库路径")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("import-cal", help="导入一个校准记录批次（CSV/JSONL）")
    p.add_argument("--file", required=True)
    p.set_defaults(func=cmd_import_cal)

    p = sub.add_parser("import-meas", help="导入一个测量明细批次（CSV/JSONL）")
    p.add_argument("--file", required=True)
    p.set_defaults(func=cmd_import_meas)

    p = sub.add_parser("query", help="按登记截止时间回算查询")
    p.add_argument("--cutoff", required=True, help="登记截止时间（ISO-8601）")
    p.add_argument("--instrument", help="只看某台仪器")
    p.add_argument("--note", help="给本次查询快照加备注")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("conflicts", help="列出同仪器同登记时刻的区间重叠")
    p.add_argument("--cutoff", help="可选：只统计该截止时间前已登记的记录")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(func=cmd_conflicts)

    p = sub.add_parser("runs", help="列出历次查询快照")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(func=cmd_runs)

    p = sub.add_parser("export", help="导出某次已冻结查询的结果为 CSV")
    p.add_argument("--cutoff", required=True)
    p.add_argument("--instrument")
    p.set_defaults(func=cmd_export)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except InputError as exc:
        print(f"输入错误: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"输入错误: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
