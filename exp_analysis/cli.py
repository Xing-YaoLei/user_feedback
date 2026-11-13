"""命令行入口。

示例:
python -m exp_analysis.cli \
    --assignments data/assignments.csv \
    --conversions data/conversions.csv \
    --weights data/weights.csv \
    --coverage "2026-11-01 00:00:00" \
    --control control --treatment treatment
"""

from __future__ import annotations

import argparse
import sys

from .analysis import run_analysis
from .io_utils import load_assignments, load_conversions, load_coverage, load_weights
from .permutation import DEFAULT_EXACT_LIMIT, DEFAULT_MC_REPLICATIONS, stratified_permutation_test
from .report import observations_csv, render_text, summary_csv


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="exp_analysis",
        description="对齐分流/转化日志，输出分层转化率、加权差值与精确置换检验",
    )
    p.add_argument("--assignments", required=True, help="分流日志 CSV: user_id,layer,group,assigned_at")
    p.add_argument("--conversions", required=True,
                   help="转化日志 CSV: user_id,converted_at[,coverage_at]")
    p.add_argument("--weights", help="层固定权重 CSV: layer,weight（可选）")
    p.add_argument("--coverage",
                   help="日志已完整覆盖到的时间（时间戳，或只含一个时间戳的文件路径）；"
                        "转化日志自带 coverage_at 列时可省略")
    p.add_argument("--control", default="control", help="对照组名称，默认 control")
    p.add_argument("--treatment", default="treatment", help="处理组名称，默认 treatment")
    p.add_argument("--window-days", type=int, default=7, help="转化窗口天数，默认 7")
    p.add_argument("--no-permutation", action="store_true", help="跳过置换检验")
    p.add_argument("--exact-limit", type=int, default=DEFAULT_EXACT_LIMIT,
                   help=f"精确枚举排列数上限，超过则蒙特卡洛抽样，默认 {DEFAULT_EXACT_LIMIT:,}")
    p.add_argument("--mc-reps", type=int, default=DEFAULT_MC_REPLICATIONS,
                   help=f"蒙特卡洛抽样次数，默认 {DEFAULT_MC_REPLICATIONS:,}")
    p.add_argument("--seed", type=int, default=42, help="蒙特卡洛随机种子，默认 42")
    p.add_argument("--out-observations", help="每用户观察结果导出 CSV 路径")
    p.add_argument("--out-summary", help="分层/总体汇总导出 CSV 路径")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    assignments = load_assignments(args.assignments)
    conversions, coverage_per_user = load_conversions(args.conversions)
    weights = load_weights(args.weights) if args.weights else {}
    global_coverage = load_coverage(args.coverage) if args.coverage else None

    if global_coverage is None and not coverage_per_user:
        print("错误: 未提供覆盖时间（--coverage 或转化日志中的 coverage_at 列）", file=sys.stderr)
        return 2

    result = run_analysis(
        assignments=assignments,
        conversions=conversions,
        coverage_per_user=coverage_per_user,
        global_coverage=global_coverage,
        weights=weights,
        control=args.control,
        treatment=args.treatment,
        window_days=args.window_days,
    )

    perm = None
    if not args.no_permutation:
        perm = stratified_permutation_test(
            result,
            exact_limit=args.exact_limit,
            mc_replications=args.mc_reps,
            seed=args.seed,
        )

    print(render_text(result, perm))

    if args.out_observations:
        with open(args.out_observations, "w", encoding="utf-8", newline="") as f:
            f.write(observations_csv(result))
        print(f"已导出每用户观察结果: {args.out_observations}")
    if args.out_summary:
        with open(args.out_summary, "w", encoding="utf-8", newline="") as f:
            f.write(summary_csv(result))
        print(f"已导出汇总结果: {args.out_summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
