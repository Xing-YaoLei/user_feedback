"""命令行入口。

常用流程：

    # 1. 导入按日期记录的源数值（可重复执行，仅变化的记录会推进版本）
    python -m metriccalc import sources.csv
    python -m metriccalc import sources.json

    # 2. 第一次运行：没有可复用结果，可直接执行
    python -m metriccalc run --config metrics.json --target orders_7d \
        --start 2026-01-01 --end 2026-01-31

    # 3. 之后补录/更正某天：先预览影响，再确认执行
    python -m metriccalc preview --config metrics.json --target orders_7d \
        --start 2026-01-01 --end 2026-01-31
    python -m metriccalc apply <预览ID>

    # 4. 查看结果 / 状态
    python -m metriccalc show --config metrics.json --target orders_7d \
        --start 2026-01-01 --end 2026-01-31
    python -m metriccalc status
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from typing import List, Optional, Sequence, Tuple

from .config import ConfigError, load_config, parse_date
from .planner import (
    PlanError,
    build_plan,
    execute_plan,
    plan_to_json,
    render_plan,
    render_results,
    verify_preview,
)
from .store import Store, StoreError, fmt_num

DEFAULT_DB = "metrics.db"

Record = Tuple[str, str, Optional[float]]


class UsageError(RuntimeError):
    """输入文件格式问题。"""


# ---------------------------------------------------------------- 输入解析


def _coerce(value, where) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UsageError("第 %s 条记录的 value 必须是数字或 null" % (where,))
    return float(value)


def _cell_value(text: str, line_no: int) -> Optional[float]:
    text = (text or "").strip()
    if text.lower() in ("", "null", "none", "na", "nan", "-"):
        return None
    try:
        return float(text)
    except ValueError:
        raise UsageError("第 %d 行的数值无法解析：%r" % (line_no, text)) from None


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return fh.read()
    except OSError as exc:
        raise UsageError("无法读取 %s：%s" % (path, exc)) from None


def _json_records(text: str) -> List[Record]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise UsageError("JSON 解析失败：%s" % exc) from None

    if isinstance(data, dict) and "values" in data:
        source = data.get("source")
        if not isinstance(source, str) or not source.strip():
            raise UsageError("JSON 对象的 source 必须是非空字符串")
        values = data["values"]
        if not isinstance(values, dict):
            raise UsageError("values 必须是「日期 → 数值」映射")
        return [(source, str(d), _coerce(v, d)) for d, v in values.items()]

    items = data.get("records") if isinstance(data, dict) and "records" in data else data
    if not isinstance(items, list):
        raise UsageError("JSON 顶层必须是记录数组，或 {source, values} 对象")
    records: List[Record] = []
    for i, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise UsageError("第 %d 条记录必须是对象" % i)
        source = item.get("source")
        if not isinstance(source, str) or not source.strip():
            raise UsageError("第 %d 条记录缺少 source" % i)
        if "date" not in item:
            raise UsageError("第 %d 条记录缺少 date" % i)
        records.append((source, str(item["date"]), _coerce(item.get("value"), i)))
    return records


def _csv_records(text: str, default_source: Optional[str]) -> List[Record]:
    rows = list(csv.reader(io.StringIO(text)))
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    if not rows:
        return []

    header = [cell.strip().lower() for cell in rows[0]]
    if {"source", "date", "value"} <= set(header):
        si, di, vi = header.index("source"), header.index("date"), header.index("value")
        body, first_line = rows[1:], 2
    elif {"date", "value"} <= set(header):
        # 两列带表头：date,value，源名称由 --source 指定
        if not default_source:
            raise UsageError("该 CSV 只有 date,value 两列，请用 --source 指定源名称")
        si, di, vi = None, header.index("date"), header.index("value")
        body, first_line = rows[1:], 2
    else:
        if len(header) == 2:
            si, di, vi = None, 0, 1
            body, first_line = rows, 1
            if not default_source:
                raise UsageError("该 CSV 只有 date,value 两列，请用 --source 指定源名称")
        elif len(header) >= 3:
            si, di, vi = 0, 1, 2
            body, first_line = rows, 1
        else:
            raise UsageError(
                "无表头 CSV 应为 date,value（配合 --source）或 source,date,value"
            )
    need = max(i for i in (si, di, vi) if i is not None)

    records: List[Record] = []
    for offset, row in enumerate(body):
        line_no = first_line + offset
        if len(row) <= need:
            raise UsageError("第 %d 行字段数不足：%r" % (line_no, ",".join(row)))
        source = row[si].strip() if si is not None else default_source
        if not source:
            raise UsageError("第 %d 行 source 为空" % line_no)
        records.append((source, row[di].strip(), _cell_value(row[vi], line_no)))
    return records


def read_records(path: str, default_source: Optional[str]) -> List[Record]:
    text = _read_text(path)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        return _json_records(text)
    return _csv_records(text, default_source)


# ---------------------------------------------------------------- 输出辅助


def _out(text: str = "") -> None:
    print(text)


def _err(text: str) -> None:
    print(text, file=sys.stderr)


def _make_preview(args, store: Store, config, plan) -> str:
    return store.create_preview(
        config_path=config.path,
        config_sig=config.sig,
        target=args.target,
        start=plan.start.isoformat(),
        end=plan.end.isoformat(),
        inputs_sig=plan.inputs_sig,
        inputs_json=plan.inputs_json,
        plan_sig=plan.plan_sig,
        plan_json=plan_to_json(plan),
    )


def _execute_and_report(store: Store, plan, preview_id: str) -> int:
    row = store.get_preview(preview_id)
    run_id = store.create_run(
        preview_id=preview_id,
        config_sig=row["config_sig"],
        target=row["target"],
        start=row["start_date"],
        end=row["end_date"],
        planned=len(plan.recompute),
        reused=len(plan.reuse),
    )
    result = execute_plan(store, plan, run_id)
    store.mark_preview_applied(preview_id)
    status = "completed" if result.ok else ("interrupted" if result.interrupted else "failed")
    store.finish_run(run_id, status, result.worked, result.blocked, result.reused, result.error)

    _out("运行 %s（预览 %s）：%s" % (run_id, preview_id, status))
    _out(
        "  重算完成 %d 个分区，复用 %d 个分区，阻塞 %d 个。"
        % (result.worked, result.reused, result.blocked)
    )
    if result.per_node:
        _out("  本次重算：" + "、".join("%s %d" % (k, v) for k, v in result.per_node.items()))
    if result.blocked:
        _out("  阻塞：" + "、".join("%s %d" % (k, v) for k, v in result.blocked_nodes.items()))
        for node in result.blocked_nodes:
            for part in store.pending_or_blocked(
                node, plan.start.isoformat(), plan.end.isoformat()
            ):
                _out("    %s  %s  %s" % (part.date, part.node, part.reason or ""))
    _out()
    _out(render_results(store, plan.config, plan.target, plan.start, plan.end))
    if not result.ok:
        _err()
        _err(result.error or "执行未完成。")
        if result.interrupted:
            _err("重新预览后继续即可；已完成且输入未变的分区会被复用。")
        return 1
    return 0


# ---------------------------------------------------------------- 子命令


def cmd_import(args: argparse.Namespace, store: Store) -> int:
    records = read_records(args.file, args.source)
    changed, touched = store.import_source_values(records)
    _out("读取 %d 条记录，%d 条实际发生变化。" % (len(records), changed))
    if touched:
        _out("变化的源：" + "、".join(touched))
        _out("数据已变化。下一步：先预览哪些节点和日期需要重算，确认后再执行。")
    else:
        _out("与现有数据完全一致，无需重算。")
    return 0


def cmd_preview(args: argparse.Namespace, store: Store) -> int:
    config = load_config(args.config)
    plan = build_plan(
        store, config, args.target,
        parse_date(args.start, "start"), parse_date(args.end, "end"),
    )
    preview_id = _make_preview(args, store, config, plan)
    _out(render_plan(plan, preview_id, details=args.details))
    if args.json:
        _out()
        _out(plan_to_json(plan, preview_id))
    return 0


def cmd_apply(args: argparse.Namespace, store: Store) -> int:
    plan = verify_preview(store, args.preview_id)
    return _execute_and_report(store, plan, args.preview_id)


def cmd_run(args: argparse.Namespace, store: Store) -> int:
    config = load_config(args.config)
    plan = build_plan(
        store, config, args.target,
        parse_date(args.start, "start"), parse_date(args.end, "end"),
    )
    preview_id = _make_preview(args, store, config, plan)
    _out(render_plan(plan, preview_id, details=args.details))

    if plan.reuse and not args.force:
        _err()
        _err(
            "存在可复用的历史结果，未自动执行。确认以上影响后执行：apply %s" % preview_id
        )
        _err("（确实无需确认时可用 --force 直接执行。）")
        return 2
    _out()
    return _execute_and_report(store, plan, preview_id)


def cmd_show(args: argparse.Namespace, store: Store) -> int:
    config = load_config(args.config)
    _out(
        render_results(
            store, config, args.target,
            parse_date(args.start, "start"), parse_date(args.end, "end"),
        )
    )
    return 0


def cmd_status(args: argparse.Namespace, store: Store) -> int:
    counts = store.partition_counts()
    _out("存储：%s" % store.path)
    if counts:
        _out("分区：" + "、".join("%s %d" % (k, v) for k, v in sorted(counts.items())))
    else:
        _out("尚无任何分区结果。")
    pending = store.pending_partitions(limit=10)
    if pending:
        _out("未完成的分区（重新预览后，已算完且输入未变的会被复用）：")
        for p in pending:
            _out("  %s  %s" % (p.date, p.node))

    sources = store.list_sources()
    if sources:
        _out()
        _out("源：")
        for s in sources:
            _out(
                "  %-16s 版本 %-4d %d 条  %s .. %s"
                % (s["name"], s["rev"], s["n"], s["min_date"] or "-", s["max_date"] or "-")
            )
    previews = store.recent_previews(limit=5)
    if previews:
        _out()
        _out("最近的预览：")
        for p in previews:
            _out(
                "  %s  %s  %s  %s .. %s  [%s]"
                % (p["id"], p["created_at"], p["target"], p["start_date"],
                   p["end_date"], p["status"])
            )
    runs = store.recent_runs(limit=5)
    if runs:
        _out()
        _out("最近的运行：")
        for r in runs:
            _out(
                "  %s  %s  %-11s 重算 %d 复用 %d 阻塞 %d"
                % (r["id"], r["created_at"], r["status"], r["worked"], r["reused"],
                   r["blocked"])
            )
            if r["error"]:
                _out("      %s" % r["error"])
    return 0


def cmd_sources(args: argparse.Namespace, store: Store) -> int:
    if args.source:
        changes = store.source_changes(args.source, limit=args.limit)
        _out("源「%s」最近 %d 次变更：" % (args.source, len(changes)))
        for c in changes:
            _out(
                "  %s  %s → %s  版本 %d  %s"
                % (c["date"], fmt_num(c["old_value"]), fmt_num(c["new_value"]),
                   c["rev"], c["changed_at"])
            )
        return 0
    sources = store.list_sources()
    if not sources:
        _out("尚无任何源数据。")
        return 0
    for s in sources:
        _out(
            "%-16s 版本 %-4d %d 条  %s .. %s"
            % (s["name"], s["rev"], s["n"], s["min_date"] or "-", s["max_date"] or "-")
        )
    return 0


# ---------------------------------------------------------------- 参数解析


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="metriccalc",
        description="按日期计算指标：定义计算节点、预览增量重算、按计划执行。",
    )
    parser.add_argument(
        "--db", default=os.environ.get("METRICCALC_DB", DEFAULT_DB),
        help="SQLite 存储路径（默认 %s）" % DEFAULT_DB,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_import = sub.add_parser("import", help="导入/更正按日期记录的源数值")
    p_import.add_argument("file", help="CSV（source,date,value）或 JSON")
    p_import.add_argument("--source", help="CSV 无 source 列时统一指定的源名称")
    p_import.set_defaults(func=cmd_import)

    p_preview = sub.add_parser("preview", help="预览需要重算的节点和日期（不修改结果）")
    p_preview.add_argument("--config", required=True, help="节点配置文件（JSON）")
    p_preview.add_argument("--target", required=True, help="目标节点名")
    p_preview.add_argument("--start", required=True, help="开始日期 YYYY-MM-DD")
    p_preview.add_argument("--end", required=True, help="结束日期 YYYY-MM-DD")
    p_preview.add_argument("--details", type=int, default=8, help="逐日示例条数")
    p_preview.add_argument("--json", action="store_true", help="同时输出机读计划")
    p_preview.set_defaults(func=cmd_preview)

    p_run = sub.add_parser("run", help="首次运行；存在可复用结果时要求先确认")
    p_run.add_argument("--config", required=True, help="节点配置文件（JSON）")
    p_run.add_argument("--target", required=True, help="目标节点名")
    p_run.add_argument("--start", required=True, help="开始日期 YYYY-MM-DD")
    p_run.add_argument("--end", required=True, help="结束日期 YYYY-MM-DD")
    p_run.add_argument("--details", type=int, default=8, help="逐日示例条数")
    p_run.add_argument(
        "--force", action="store_true",
        help="即使存在可复用结果也直接执行（不推荐）",
    )
    p_run.set_defaults(func=cmd_run)

    p_apply = sub.add_parser("apply", help="确认并执行一个预览计划")
    p_apply.add_argument("preview_id", help="预览 ID（preview 输出中给出）")
    p_apply.set_defaults(func=cmd_apply)

    p_show = sub.add_parser("show", help="查看指定范围内的计算结果")
    p_show.add_argument("--config", required=True, help="节点配置文件（JSON）")
    p_show.add_argument("--target", required=True, help="目标节点名")
    p_show.add_argument("--start", required=True, help="开始日期 YYYY-MM-DD")
    p_show.add_argument("--end", required=True, help="结束日期 YYYY-MM-DD")
    p_show.set_defaults(func=cmd_show)

    p_status = sub.add_parser("status", help="查看存储、未完成分区、预览与运行记录")
    p_status.set_defaults(func=cmd_status)

    p_src = sub.add_parser("sources", help="列出源序列或某个源的变更历史")
    p_src.add_argument("--source", help="查看该源的变更历史")
    p_src.add_argument("--limit", type=int, default=20)
    p_src.set_defaults(func=cmd_sources)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not os.path.isdir(os.path.dirname(os.path.abspath(args.db))):
        _err("存储目录不存在：%s" % os.path.dirname(os.path.abspath(args.db)))
        return 2
    try:
        with Store(args.db) as store:
            if args.command != "status":
                store.mark_orphan_runs()
            return args.func(args, store)
    except (ConfigError, PlanError, StoreError, UsageError) as exc:
        _err("错误：%s" % exc)
        return 2
    except KeyboardInterrupt:
        _err("已中断。")
        return 130


if __name__ == "__main__":
    sys.exit(main())
