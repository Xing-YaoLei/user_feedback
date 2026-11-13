"""结果输出：控制台文本报告与 CSV 导出。"""

from __future__ import annotations

import csv
from io import StringIO

from .analysis import AnalysisResult, GroupStats, LayerResult
from .permutation import PermutationResult

INSUFFICIENT = "数据不足"


def _fmt_rate(rate: float | None) -> str:
    return "-" if rate is None else f"{rate:.2%}"


def _fmt_num(v: float | None, digits: 4) -> str:
    return "-" if v is None else f"{v:.{digits}f}"


def _group_line(gs: GroupStats) -> str:
    return (
        f"    {gs.group:<10} 已观察 {gs.observed:>4}  待观察 {gs.pending:>4}  "
        f"转化 {gs.conversions:>4}  转化率 {_fmt_rate(gs.rate)}"
    )


def render_text(
    result: AnalysisResult,
    perm: PermutationResult | None = None,
) -> str:
    out = StringIO()
    w = out.write
    w("=" * 72 + "\n")
    w("实验分析报告\n")
    w("=" * 72 + "\n")
    w(f"对照组: {result.control}    处理组: {result.treatment}    "
      f"转化窗口: 分组后 {result.window_days} 天\n\n")

    if result.warnings:
        w("数据告警:\n")
        for msg in result.warnings:
            w(f"  - {msg}\n")
        w("\n")

    w("分层结果\n")
    w("-" * 72 + "\n")
    for name in sorted(result.layers):
        lr: LayerResult = result.layers[name]
        weight_label = "无权重" if lr.weight is None else f"权重 {lr.weight:g}"
        w(f"层 {name}（{weight_label}）\n")
        for gname in lr.group_names():
            w(_group_line(lr.groups[gname]) + "\n")
        if lr.has_valid_diff:
            w(f"  分层差值（处理-对照）: {lr.diff:+.4f}\n")
        else:
            w(f"  分层差值（处理-对照）: {INSUFFICIENT}（{lr.insufficient_reason}）\n")
        w("\n")

    w("总体结果（跨层合并，仅已观察用户）\n")
    w("-" * 72 + "\n")
    for gname in sorted(result.overall.groups):
        w(_group_line(result.overall.groups[gname]) + "\n")
    w(f"总体差值（处理-对照）: {_fmt_num(result.overall.diff, 4)}")
    if result.overall.diff is None:
        w(f"（{INSUFFICIENT}）")
    w("\n\n")

    w("按固定权重的分层差值\n")
    w("-" * 72 + "\n")
    w(f"参与加权的层: {', '.join(result.weighted_layers_used) or '无'}\n")
    if result.weighted_layers_skipped:
        w(f"跳过（{INSUFFICIENT}）的有权重层: {', '.join(result.weighted_layers_skipped)}\n")
    w(f"权重覆盖率: {result.weighted_weight_coverage:.2%}\n")
    if result.weighted_diff_renorm is None:
        w(f"加权分层差值: {INSUFFICIENT}\n")
    else:
        w(f"加权分层差值（按参与层权重重归一化）: {result.weighted_diff_renorm:+.4f}\n")
        if result.weighted_weight_coverage < 1.0:
            w(f"加权分层差值（原始权重口径，未覆盖层按 0 贡献）: "
              f"{_fmt_num(result.weighted_diff_raw, 4)}\n")
    w("\n")

    if perm is not None:
        w("分层精确置换检验（双侧）\n")
        w("-" * 72 + "\n")
        w("每层保持原分组人数，层内随机重排标签，统计量为加权分层差值\n")
        w(f"参与检验的层: {', '.join(perm.eligible_layers) or '无'}\n")
        if perm.excluded_layers:
            for layer_name, reason in perm.excluded_layers.items():
                w(f"  排除层 {layer_name}: {reason}\n")
        if perm.method == "insufficient":
            w("检验结果: 数据不足（没有可检验的层）\n")
        else:
            method_label = "精确枚举" if perm.method == "exact" else "蒙特卡洛抽样"
            w(f"方法: {method_label}，排列数 {perm.n_arrangements:,}，"
              f"观测统计量 {perm.observed_stat:+.4f}\n")
            w(f"双侧 p 值: {perm.p_value:.4f}\n")
            if perm.method == "monte_carlo":
                w(f"（随机种子 {perm.seed}；枚举超过 {perm.exact_limit:,} 时自动回退抽样）\n")
        w("\n")

    return out.getvalue()


def observations_csv(result: AnalysisResult) -> str:
    out = StringIO()
    writer = csv.writer(out)
    writer.writerow(
        ["user_id", "layer", "group", "assigned_at", "window_end",
         "coverage_at", "status", "converted_in_window", "conversion_at", "note"]
    )
    for o in sorted(result.observations, key=lambda x: (x.layer, x.group, x.user_id)):
        writer.writerow(
            [
                o.user_id,
                o.layer,
                o.group,
                o.assigned_at.isoformat(),
                o.window_end.isoformat(),
                o.coverage_at.isoformat() if o.coverage_at else "",
                o.status,
                "" if o.converted_in_window is None else int(o.converted_in_window),
                o.conversion_at.isoformat() if o.conversion_at else "",
                o.note,
            ]
        )
    return out.getvalue()


def summary_csv(result: AnalysisResult) -> str:
    out = StringIO()
    writer = csv.writer(out)
    writer.writerow(
        ["scope", "layer", "weight", "group", "observed", "pending",
         "conversions", "conversion_rate", "diff_treatment_minus_control", "status"]
    )
    for name in sorted(result.layers):
        lr = result.layers[name]
        for gname in lr.group_names():
            gs = lr.groups[gname]
            writer.writerow(
                [
                    "layer",
                    name,
                    "" if lr.weight is None else lr.weight,
                    gname,
                    gs.observed,
                    gs.pending,
                    gs.conversions,
                    "" if gs.rate is None else round(gs.rate, 6),
                    "" if not lr.has_valid_diff else round(lr.diff, 6),
                    "ok" if lr.has_valid_diff else INSUFFICIENT,
                ]
            )
    for gname in sorted(result.overall.groups):
        gs = result.overall.groups[gname]
        writer.writerow(
            [
                "overall",
                "",
                "",
                gname,
                gs.observed,
                gs.pending,
                gs.conversions,
                "" if gs.rate is None else round(gs.rate, 6),
                "" if result.overall.diff is None else round(result.overall.diff, 6),
                "ok" if result.overall.diff is not None else INSUFFICIENT,
            ]
        )
    return out.getvalue()
