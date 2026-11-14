"""命令行入口：python -m batch_trace --purchases ... --orders ... [批号 ...]"""

from __future__ import annotations

import argparse
import json
import sys

from .core import build_engine
from .io import load_orders, load_purchases
from .model import InputError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="batch_trace",
        description="按采购批次追溯成品批号的来源贡献重量",
    )
    parser.add_argument("batch_ids", nargs="*", metavar="批号", help="要查询的成品批号（可多个）")
    parser.add_argument("--purchases", required=True, metavar="CSV", help="采购批次 CSV 路径")
    parser.add_argument("--orders", required=True, metavar="JSONL", help="加工单 JSONL 路径")
    parser.add_argument(
        "--basis",
        choices=("produced", "remaining"),
        default="produced",
        help="计算基准：produced=产出时的完整重量（默认，贡献合计等于该批重量），"
        "remaining=当前剩余重量",
    )
    parser.add_argument(
        "--report",
        action="store_true",
        help="输出完整报告：问题清单、受影响批次与全部成品追溯",
    )
    parser.add_argument(
        "--indent", type=int, default=2, help="JSON 缩进空格数（默认 2，0 表示单行输出）"
    )
    return parser


def _emit(payload: dict, indent: int) -> None:
    if indent <= 0:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=indent))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        purchases = load_purchases(args.purchases)
        orders = load_orders(args.orders)
        engine = build_engine(purchases, orders)
    except InputError as exc:
        print(f"输入错误：{exc}", file=sys.stderr)
        return 2

    if args.report:
        payload = engine.report(basis=args.basis)
        incomplete = bool(engine.issues)
    elif args.batch_ids:
        results = [engine.query(b, basis=args.basis) for b in args.batch_ids]
        payload = {"results": results, "issues": [i.to_dict() for i in engine.issues]}
        incomplete = any(item.get("status") != "ok" for item in results)
    else:
        results = engine.product_summaries(basis=args.basis)
        payload = {"products": results, "issues": [i.to_dict() for i in engine.issues]}
        # 列出全部成品时，有问题意味着有成品被排除，退出码标为不完整
        incomplete = bool(engine.issues)

    _emit(payload, args.indent)
    return 1 if incomplete else 0


if __name__ == "__main__":
    raise SystemExit(main())
