"""核心分析：按用户对齐、七天窗口判定、分层统计与加权差值。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

WINDOW_DAYS = 7


@dataclass
class Observation:
    """单个用户的一条观察结果。"""

    user_id: str
    layer: str
    group: str
    assigned_at: datetime
    window_end: datetime
    coverage_at: Optional[datetime]
    converted_in_window: Optional[bool]  # None = 待观察
    status: str  # "observed" | "pending"
    conversion_at: Optional[datetime] = None
    note: str = ""


@dataclass
class GroupStats:
    group: str
    observed: int = 0
    pending: int = 0
    conversions: int = 0

    @property
    def rate(self) -> Optional[float]:
        return self.conversions / self.observed if self.observed > 0 else None


@dataclass
class LayerResult:
    layer: str
    weight: Optional[float]  # None 表示该层未提供权重
    groups: dict[str, GroupStats] = field(default_factory=dict)
    diff: Optional[float] = None  # treatment - control，基于已观察用户
    has_valid_diff: bool = False  # 两组都至少有 1 个已观察用户
    insufficient_reason: str = ""

    def group_names(self) -> list[str]:
        return sorted(self.groups)


@dataclass
class OverallResult:
    groups: dict[str, GroupStats] = field(default_factory=dict)
    diff: Optional[float] = None


@dataclass
class AnalysisResult:
    observations: list[Observation]
    layers: dict[str, LayerResult]
    overall: OverallResult
    weighted_diff_raw: Optional[float]
    weighted_diff_renorm: Optional[float]
    weighted_weight_coverage: float  # 参与加权层的权重和 / 全部有权重层的权重和
    weighted_layers_used: list[str]
    weighted_layers_skipped: list[str]
    control: str
    treatment: str
    window_days: int
    warnings: list[str]


def build_observations(
    assignments: list[dict],
    conversions: dict[str, datetime],
    coverage_per_user: dict[str, datetime],
    global_coverage: Optional[datetime],
    control: str,
    treatment: str,
    window_days: int = WINDOW_DAYS,
) -> tuple[list[Observation], list[str]]:
    """按用户对齐两份日志，每人生成一条观察结果。"""
    warnings: list[str] = []
    seen: set[str] = set()
    observations: list[Observation] = []

    assigned_users = {a["user_id"] for a in assignments}
    for uid in conversions:
        if uid not in assigned_users:
            warnings.append(f"转化日志中的用户 {uid} 在分流日志中不存在，已忽略")

    for rec in assignments:
        uid = rec["user_id"]
        if uid in seen:
            warnings.append(f"用户 {uid} 有多条分流记录，保留最早一条")
            continue
        seen.add(uid)

        assigned_at = rec["assigned_at"]
        window_end = assigned_at + timedelta(days=window_days)
        coverage = coverage_per_user.get(uid, global_coverage)
        conv_at = conversions.get(uid)

        note = ""
        if coverage is None:
            # 没有任何覆盖信息：无法判断窗口是否完整，按待观察处理
            status, converted = "pending", None
            note = "缺少日志覆盖时间，默认待观察"
        elif coverage < window_end:
            status, converted = "pending", None
        else:
            status = "observed"
            if conv_at is not None and assigned_at <= conv_at <= window_end:
                converted = True
            else:
                converted = False
                if conv_at is not None and conv_at < assigned_at:
                    note = "转化时间早于分组时间，不计入"

        observations.append(
            Observation(
                user_id=uid,
                layer=rec["layer"],
                group=rec["group"],
                assigned_at=assigned_at,
                window_end=window_end,
                coverage_at=coverage,
                converted_in_window=converted,
                status=status,
                conversion_at=conv_at if (status == "observed" and converted) else None,
                note=note,
            )
        )

    unknown_groups = sorted({o.group for o in observations} - {control, treatment})
    if unknown_groups:
        warnings.append(f"存在未识别的实验组名称: {', '.join(unknown_groups)}")
    return observations, warnings


def _empty_group_stats(group: str) -> GroupStats:
    return GroupStats(group=group)


def aggregate(
    observations: list[Observation],
    weights: dict[str, float],
    control: str,
    treatment: str,
) -> AnalysisResult:
    layers: dict[str, LayerResult] = {}

    def get_layer(name: str) -> LayerResult:
        if name not in layers:
            layers[name] = LayerResult(layer=name, weight=weights.get(name))
        return layers[name]

    def get_stats(layer_res: LayerResult, group: str) -> GroupStats:
        if group not in layer_res.groups:
            layer_res.groups[group] = _empty_group_stats(group)
        return layer_res.groups[group]

    overall = OverallResult(groups={control: _empty_group_stats(control), treatment: _empty_group_stats(treatment)})

    for obs in observations:
        layer_res = get_layer(obs.layer)
        gs = get_stats(layer_res, obs.group)
        ogs = overall.groups.setdefault(obs.group, _empty_group_stats(obs.group))
        if obs.status == "pending":
            gs.pending += 1
            ogs.pending += 1
        else:
            gs.observed += 1
            ogs.observed += 1
            if obs.converted_in_window:
                gs.conversions += 1
                ogs.conversions += 1

    weighted_terms: list[tuple[str, float, float]] = []
    skipped: list[str] = []
    total_weighted_sum = sum(weights.values())

    for name in sorted(layers):
        lr = layers[name]
        c = lr.groups.get(control)
        t = lr.groups.get(treatment)
        if c is None or t is None:
            lr.has_valid_diff = False
            lr.insufficient_reason = "缺少实验组"
        elif c.observed == 0 or t.observed == 0:
            lr.has_valid_diff = False
            lr.insufficient_reason = "存在已观察人数为 0 的组"
        else:
            lr.has_valid_diff = True
            lr.diff = (t.rate or 0.0) - (c.rate or 0.0)
        if lr.weight is not None:
            if lr.has_valid_diff:
                weighted_terms.append((name, lr.weight, lr.diff))  # type: ignore[arg-type]
            else:
                skipped.append(name)

    c_all = overall.groups.get(control)
    t_all = overall.groups.get(treatment)
    if c_all and t_all and c_all.observed > 0 and t_all.observed > 0:
        overall.diff = (t_all.rate or 0.0) - (c_all.rate or 0.0)

    if weighted_terms:
        used_weight = sum(w for _, w, _ in weighted_terms)
        weighted_diff_renorm = sum(w * d for _, w, d in weighted_terms) / used_weight
        weighted_diff_raw = (
            sum(w * d for _, w, d in weighted_terms) if total_weighted_sum > 0 else None
        )
        coverage_ratio = used_weight / total_weighted_sum if total_weighted_sum > 0 else 0.0
    else:
        weighted_diff_renorm = None
        weighted_diff_raw = None
        coverage_ratio = 0.0

    return AnalysisResult(
        observations=observations,
        layers=layers,
        overall=overall,
        weighted_diff_raw=weighted_diff_raw,
        weighted_diff_renorm=weighted_diff_renorm,
        weighted_weight_coverage=coverage_ratio,
        weighted_layers_used=[n for n, _, _ in weighted_terms],
        weighted_layers_skipped=skipped,
        control=control,
        treatment=treatment,
        window_days=WINDOW_DAYS,
        warnings=[],
    )


def run_analysis(
    assignments: list[dict],
    conversions: dict[str, datetime],
    coverage_per_user: dict[str, datetime],
    global_coverage: Optional[datetime],
    weights: dict[str, float],
    control: str,
    treatment: str,
    window_days: int = WINDOW_DAYS,
) -> AnalysisResult:
    observations, warnings = build_observations(
        assignments, conversions, coverage_per_user, global_coverage, control, treatment, window_days
    )
    result = aggregate(observations, weights, control, treatment)
    result.window_days = window_days
    result.warnings = warnings
    return result
