"""命令行入口。

子命令：
  precheck        只做导入前兼容性检查，打印不兼容字段与原因
  ingest          按批次清单导入并发布本批明细与失败记录
  retry-failures  映射修正后只重试待处理清单里的失败记录
  status          查看当前发布状态与台账/清单统计

用法示例：
  python -m ingest precheck --config config
  python -m ingest ingest --config config --state state --manifest batch/batch1.json
  python -m ingest retry-failures --config config --state state
  python -m ingest status --state state
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from .config import PipelineConfig
from .errors import IngestError
from .pipeline import ingest_batch, retry_failures
from .precheck import run_precheck
from .state import StateStore, iter_jsonl


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ingest",
        description="多来源多版本事件的批次接入与统一明细发布工具",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--config", required=True, help="配置目录（含三个 JSON 定义文件）"
        )
        p.add_argument("--state", help="状态目录（ingest/retry 需要）")
        p.add_argument(
            "--json",
            action="store_true",
            help="以 JSON 格式输出，便于程序化调用",
        )

    p_pre = sub.add_parser(
        "precheck", help="导入前检查必填补齐与类型兼容性"
    )
    add_common(p_pre)

    p_in = sub.add_parser("ingest", help="按批次清单导入并原子发布")
    add_common(p_in)
    p_in.add_argument(
        "--manifest", required=True, help="批次清单 JSON（files 数组）"
    )
    p_in.add_argument(
        "--strict",
        action="store_true",
        help="本批存在失败记录时以退出码 2 结束",
    )

    p_retry = sub.add_parser(
        "retry-failures", help="只重试待处理清单中的失败记录"
    )
    add_common(p_retry)
    p_retry.add_argument(
        "--only",
        action="append",
        default=None,
        help="只重试指定幂等键（可多次传入），默认重试全部待处理记录",
    )
    p_retry.add_argument(
        "--strict",
        action="store_true",
        help="重试后仍有失败时以退出码 2 结束",
    )

    p_status = sub.add_parser("status", help="查看当前发布状态")
    p_status.add_argument("--state", required=True, help="状态目录")
    p_status.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "precheck":
            return _cmd_precheck(args)
        if args.command == "ingest":
            return _cmd_ingest(args)
        if args.command == "retry-failures":
            return _cmd_retry(args)
        if args.command == "status":
            return _cmd_status(args)
    except IngestError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 1
    return 0


def _load_config(args: argparse.Namespace) -> PipelineConfig:
    return PipelineConfig.load(args.config)


def _cmd_precheck(args: argparse.Namespace) -> int:
    config = _load_config(args)
    report = run_precheck(config)
    if args.json:
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        _print_precheck(report)
    return 0 if report.ok else 2


def _print_precheck(report: Any) -> None:
    for key in sorted(report.pair_reports):
        pair = report.pair_reports[key]
        banner = "✓" if pair.ok else "✗"
        print(
            f"{banner} 来源 {pair.source!r} 版本 {pair.version!r}"
            f"（错误 {len(pair.errors)}，警告 {len(pair.warnings)}）"
        )
        for issue in pair.issues:
            marker = "  [错误]" if issue.severity == "error" else "  [警告]"
            print(f"{marker} 字段 {issue.field}: {issue.message}")
        print()
    print(
        "预检结论："
        + ("全部通过" if report.ok else "存在不兼容的来源版本，相关记录将被拒绝")
    )


def _cmd_ingest(args: argparse.Namespace) -> int:
    config = _load_config(args)
    if not args.state:
        raise IngestError("ingest 命令需要 --state 状态目录")
    store = StateStore(args.state)
    result = ingest_batch(args.manifest, config, store)
    if args.json:
        print(json.dumps(_result_payload(result), ensure_ascii=False, indent=2))
    else:
        _print_result("导入", result)
    if args.strict and result.stats["failed"] > 0:
        return 2
    return 0


def _cmd_retry(args: argparse.Namespace) -> int:
    config = _load_config(args)
    if not args.state:
        raise IngestError("retry-failures 命令需要 --state 状态目录")
    store = StateStore(args.state)
    only = set(args.only) if args.only else None
    result = retry_failures(config, store, only_keys=only)
    if args.json:
        print(json.dumps(_result_payload(result), ensure_ascii=False, indent=2))
    else:
        _print_result("重试", result)
    if args.strict and result.stats["retry_failed"] > 0:
        return 2
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    store = StateStore(args.state)
    current = store.current_run_dir()
    runs = store.list_run_dirs()
    payload: dict[str, Any] = {
        "state_dir": os.path.abspath(args.state),
        "run_count": len(runs),
        "current_run": os.path.basename(current) if current else None,
    }
    if current is not None:
        manifest_path = os.path.join(current, "manifest.json")
        if os.path.exists(manifest_path):
            with open(manifest_path, encoding="utf-8") as fh:
                payload["current_manifest"] = json.load(fh)
        ledger = list(iter_jsonl(os.path.join(current, "published.jsonl")))
        pending = list(
            iter_jsonl(os.path.join(current, "pending_failures.jsonl"))
        )
        payload["published_total"] = len(ledger)
        payload["pending_failures"] = len(pending)
        payload["pending_by_reason"] = _count_by(pending, "reason_code")
        payload["pending_by_source"] = _count_by(pending, "source")
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"状态目录：{payload['state_dir']}")
        print(f"历史 run 数：{payload['run_count']}")
        print(f"当前发布：{payload['current_run'] or '（尚无成功提交的 run）'}")
        if "published_total" in payload:
            print(f"累计已发布：{payload['published_total']} 条")
            print(f"待处理失败：{payload['pending_failures']} 条")
            if payload["pending_by_reason"]:
                print("按原因分布：")
                for reason, count in sorted(payload["pending_by_reason"].items()):
                    print(f"  - {reason}: {count}")
    return 0


def _count_by(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        value = str(row.get(key, "unknown"))
        counts[value] = counts.get(value, 0) + 1
    return counts


def _result_payload(result: Any) -> dict[str, Any]:
    return {
        "run_id": result.run_id,
        "mode": result.mode,
        "run_dir": result.run_dir,
        "stats": result.stats,
        "precheck": result.precheck,
        "content_drift": result.content_drift,
    }


def _print_result(title: str, result: Any) -> None:
    stats = result.stats
    print(f"== {title}完成：run {result.run_id} ==")
    print(f"run 目录：{result.run_dir}")
    print(f"收到记录：{stats['received']}")
    if result.mode == "retry-failures":
        print(
            f"重试：{stats['retried']}，成功：{stats['retry_succeeded']}，"
            f"仍失败：{stats['retry_failed']}"
        )
    print(f"新发布：{stats['published']}")
    print(f"重复跳过（只发布一次）：{stats['duplicates']}")
    print(f"本批失败：{stats['failed']}")
    print(f"累计已发布：{stats['ledger_total']}")
    print(f"待处理失败剩余：{stats['pending_remaining']}")
    if result.content_drift:
        print(
            f"注意：{len(result.content_drift)} 条重复发送的内容与已发布版本不同，"
            "已保留首次发布内容"
        )
    print()
    print("本批产物（原子发布，下游读取 current 符号链接）：")
    for name in (
        "unified.jsonl",
        "failures.jsonl",
        "published.jsonl",
        "pending_failures.jsonl",
        "manifest.json",
    ):
        print(f"  - {os.path.join(result.run_dir, name)}")


if __name__ == "__main__":
    raise SystemExit(main())
