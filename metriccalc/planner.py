"""增量重算的计划与执行。

模型
====
* 每个「节点 × 日期」是一个分区，保存计算结果、自身规则签名 `rule_sig`、
  祖先规则（必要时含锚点）的签名 `deps_sig`，以及**计算时实际读取的输入**
  （`partition_inputs`）：
    - 源节点：读取的 (源, 当天, 当时的值)；
    - 汇总节点：读取的每个上游 (节点, 日期, 当时的值)。
* 复用条件 = 分区已算完 + 自身规则未变 + 祖先规则未变 + 上次读取的每个输入
  现在仍然一致（源值相同 / 上游分区仍可用的相同值）+ 本轮没有依赖"将要重算"
  的上游。
* 因此影响范围按"实际读取的日期范围"精确判断：某天源值变化，只会让真正读
  到它的分区失效。滚动窗口只影响窗口覆盖到的日期；周对比、累计指标也只在
  其读取的日期上传播。补录原先缺失的日期同样会被发现（缺失也作为输入记录）。
* 从目标向下推出每个节点需要哪些日期（区间并集），目标范围之外的上游日期
  一并计算并持久化，之后可复用。
"""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from .config import (
    Config,
    InputSpec,
    START,
    _sha256,
    canonical_json,
    config_from_text,
    read_config_text,
)
from .store import (
    PartitionInput,
    PartitionRow,
    Store,
    StoreError,
    fmt_num,
    partition_input,
    source_input,
)


class PlanError(RuntimeError):
    """预览或执行计划无法安全建立。"""


# ---------------------------------------------------------------- 日期工具


Interval = Tuple[dt.date, dt.date]


def date_range(start: dt.date, end: dt.date) -> Iterable[dt.date]:
    day = start
    while day <= end:
        yield day
        day += dt.timedelta(days=1)


def resolve_input_range(
    inp: InputSpec, day: dt.date, anchor: Optional[dt.date]
) -> Tuple[dt.date, dt.date]:
    """输入区间端点；lo > hi 表示空区间（例如累计指标在锚点之前）。"""
    if inp.from_kind == START:
        if anchor is None:
            raise PlanError(
                "节点规则使用 from=start（累计指标），但配置没有 anchor 锚点日期"
            )
        low = anchor
    else:
        low = day + dt.timedelta(days=inp.from_offset)
    high = day + dt.timedelta(days=inp.to_offset)
    return low, high


def _span_text(lo: dt.date, hi: dt.date) -> str:
    if lo > hi:
        return "空"
    return lo.isoformat() if lo == hi else "%s..%s" % (lo.isoformat(), hi.isoformat())


def _dates_brief(dates: Sequence[dt.date], limit: int = 6) -> str:
    if not dates:
        return "—"
    if len(dates) <= limit:
        return "、".join(d.isoformat() for d in dates)
    return "%s … %s（共 %d 天）" % (
        "、".join(d.isoformat() for d in dates[:3]), dates[-1].isoformat(), len(dates)
    )


def _merge_intervals(intervals: Sequence[Interval]) -> List[Interval]:
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged: List[Interval] = [ordered[0]]
    for lo, hi in ordered[1:]:
        last_lo, last_hi = merged[-1]
        if lo <= last_hi + dt.timedelta(days=1):
            merged[-1] = (last_lo, max(last_hi, hi))
        else:
            merged.append((lo, hi))
    return merged


def _intervals_text(intervals: Sequence[Interval]) -> str:
    if not intervals:
        return "无"
    return "、".join(
        lo.isoformat() if lo == hi else "%s..%s" % (lo.isoformat(), hi.isoformat())
        for lo, hi in intervals
    )


def _iter_intervals(intervals: Sequence[Interval]) -> Iterable[dt.date]:
    for lo, hi in intervals:
        yield from date_range(lo, hi)


# ---------------------------------------------------------------- 依赖与窗口


def _ancestors(config: Config, node: str) -> Set[str]:
    result: Set[str] = set()
    stack = [inp.node for inp in config.nodes[node].inputs]
    while stack:
        name = stack.pop()
        if name in result:
            continue
        result.add(name)
        stack.extend(inp.node for inp in config.nodes[name].inputs)
    return result


def _uses_start(config: Config, node: str) -> bool:
    stack, seen = [node], set()
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.add(name)
        for inp in config.nodes[name].inputs:
            if inp.from_kind == START:
                return True
            stack.append(inp.node)
    return False


def deps_signature(config: Config, node: str) -> str:
    """祖先节点规则 +（自身或祖先用到 from=start 时的）锚点。

    锚点只影响 from=start 读取的日期范围，所以与锚点无关的变化不会白白
    让纯源节点失效。
    """
    payload = {
        "anchor": (
            config.anchor.isoformat()
            if config.anchor is not None and _uses_start(config, node)
            else None
        ),
        "ancestors": sorted(
            (name, config.nodes[name].rule_sig) for name in _ancestors(config, node)
        ),
    }
    return _sha256(canonical_json(payload))


def needed_windows(
    config: Config, target: str, start: dt.date, end: dt.date
) -> Dict[str, List[Interval]]:
    """自目标向下推出每个节点需要计算的日期集合（区间并集）。

    只算出真正需要的日子：周对比只需要当天与 7 天前的两段窗口。区间只会向
    两侧扩张，用不动点迭代收敛。
    """
    windows: Dict[str, List[Interval]] = {target: [(start, end)]}
    pending = [target]
    while pending:
        name = pending.pop()
        for inp in config.nodes[name].inputs:
            extra: List[Interval] = []
            for lo, hi in windows[name]:
                if inp.from_kind == START:
                    if config.anchor is None:
                        raise PlanError(
                            "节点「%s」使用 from=start，但配置没有 anchor" % name
                        )
                    if hi < config.anchor:
                        continue
                    extra.append((config.anchor, hi))
                else:
                    a = lo + dt.timedelta(days=inp.from_offset)
                    b = hi + dt.timedelta(days=inp.to_offset)
                    if a <= b:
                        extra.append((a, b))
            if not extra:
                continue
            before = windows.get(inp.node, [])
            after = _merge_intervals(list(before) + extra)
            if after != before:
                windows[inp.node] = after
                pending.append(inp.node)
    return windows


def closure_nodes(config: Config, target: str) -> List[str]:
    reachable = {target} | _ancestors(config, target)
    return [name for name in config.order if name in reachable]


# ---------------------------------------------------------------- 分区快照


class Snapshot:
    """规划范围内的历史分区与输入，一次性批量装入。"""

    def __init__(self, store: Store, windows: Dict[str, List[Interval]]):
        self.store = store
        self.parts: Dict[Tuple[str, str], PartitionRow] = {}
        self.inputs: Dict[Tuple[str, str], List[PartitionInput]] = {}
        for node, intervals in windows.items():
            for lo, hi in intervals:
                if lo > hi:
                    continue
                for part in store.get_partitions(node, lo.isoformat(), hi.isoformat()):
                    self.parts[(node, part.date)] = part
                grouped = store.get_inputs_range(node, lo.isoformat(), hi.isoformat())
                for key, items in grouped.items():
                    self.inputs[key] = items

    def partition(self, node: str, iso: str) -> Optional[PartitionRow]:
        key = (node, iso)
        if key in self.parts:
            return self.parts[key]
        # 历史记录可能引用了当前窗口之外的上游日期，按需回查并缓存。
        part = self.store.get_partition(node, iso)
        if part is not None:
            self.parts[key] = part
        return part

    def inputs_of(self, node: str, iso: str) -> List[PartitionInput]:
        return self.inputs.get((node, iso), [])


# ---------------------------------------------------------------- 复用判定


@dataclass
class ReuseCheck:
    reusable: bool
    reason: str
    kind: str = "ok"   # ok | new | pending | blocked | rule | deps | input | upstream | abnormal


def _input_problem(
    store: Store, item: PartitionInput, snapshot: "Snapshot"
) -> Optional[str]:
    """检查一个已记录输入是否仍然一致；不一致返回一句可读说明。"""
    if item.ref_kind == "source":
        current = store.get_source_value(item.ref, item.ref_date)
        if current != item.ref_value:
            return "源「%s」@%s：%s → %s" % (
                item.ref, item.ref_date, fmt_num(item.ref_value), fmt_num(current)
            )
        return None
    up = snapshot.partition(item.ref, item.ref_date)
    if up is None:
        return "上游 %s@%s 没有结果" % (item.ref, item.ref_date)
    if up.status != "done":
        return "上游 %s@%s 当前为 %s" % (item.ref, item.ref_date, up.status)
    if up.value != item.ref_value:
        return "上游 %s@%s 的值 %s → %s" % (
            item.ref, item.ref_date, fmt_num(item.ref_value), fmt_num(up.value)
        )
    return None


def check_partition_reuse(
    config: Config,
    node: str,
    day: dt.date,
    part: Optional[PartitionRow],
    deps_sig: str,
    inputs: Sequence[PartitionInput],
    snapshot: "Snapshot",
    store: Store,
) -> ReuseCheck:
    if part is None:
        return ReuseCheck(False, "尚无历史结果（新日期）", "new")
    if part.status == "pending":
        return ReuseCheck(False, "上次运行未算完", "pending")
    if part.status == "blocked":
        why = ("：" + part.reason) if part.reason else ""
        return ReuseCheck(False, "上次计算被阻塞" + why, "blocked")
    if part.status != "done":
        return ReuseCheck(False, "上次状态异常：%s" % part.status, "abnormal")
    if part.rule_sig != config.nodes[node].rule_sig:
        return ReuseCheck(False, "节点「%s」自身的计算规则变了" % node, "rule")
    if part.deps_sig != deps_sig:
        return ReuseCheck(False, "上游节点规则或锚点日期变了", "deps")
    problems = [p for p in (_input_problem(store, item, snapshot) for item in inputs) if p]
    if problems:
        text = "；".join(problems[:3])
        if len(problems) > 3:
            text += "；另有 %d 处" % (len(problems) - 3)
        return ReuseCheck(False, "实际读取的输入变了：" + text, "input")
    return ReuseCheck(True, "规则与读取的输入均未变", "ok")


# ---------------------------------------------------------------- 计划


@dataclass
class PlanRow:
    node: str
    date: dt.date
    action: str                      # reuse | recompute
    reason: str
    kind: str = "ok"
    previous: Optional[PartitionRow] = None
    in_scope: bool = True
    inputs_note: str = ""
    will_block: Optional[str] = None


@dataclass
class Plan:
    target: str
    start: dt.date
    end: dt.date
    config: Config
    windows: Dict[str, List[Interval]]
    rows: Dict[Tuple[str, str], PlanRow]
    inputs_sig: str
    inputs_json: str
    inputs_count: int
    plan_sig: str
    preview_path: Optional[str] = None

    def rows_for(self, node: str) -> List[PlanRow]:
        return sorted((r for r in self.rows.values() if r.node == node), key=lambda r: r.date)

    @property
    def recompute(self) -> List[PlanRow]:
        return sorted(
            (r for r in self.rows.values() if r.action == "recompute"),
            key=lambda r: (r.node, r.date),
        )

    @property
    def reuse(self) -> List[PlanRow]:
        return sorted(
            (r for r in self.rows.values() if r.action == "reuse"),
            key=lambda r: (r.node, r.date),
        )

    def recompute_for(self, node: str) -> List[PlanRow]:
        return [r for r in self.recompute if r.node == node]


def _validate_ranges(
    config: Config, nodes: Sequence[str], windows: Dict[str, List[Interval]]
) -> None:
    for name in nodes:
        spec = config.nodes[name]
        if spec.kind != "sum":
            continue
        for day in _iter_intervals(windows.get(name, [])):
            for inp in spec.inputs:
                resolve_input_range(inp, day, config.anchor)


def _input_note(config: Config, node: str, day: dt.date) -> str:
    spec = config.nodes[node]
    if spec.kind == "source":
        return "读取源「%s」@%s" % (spec.source, day.isoformat())
    parts = []
    for inp in spec.inputs:
        lo, hi = resolve_input_range(inp, day, config.anchor)
        weight = "" if inp.weight == 1.0 else " × %s" % fmt_num(inp.weight)
        parts.append("%s%s（%s）" % (inp.node, weight, _span_text(lo, hi)))
    return "依赖：" + "；".join(parts)


def _snapshot_inputs(
    store: Store,
    config: Config,
    nodes: Sequence[str],
    windows: Dict[str, List[Interval]],
    snapshot: "Snapshot",
) -> Tuple[str, str, int]:
    """对"本次执行会读取的源值"做快照，用于发现预览之后的数据变化。

    源值只会被源节点读取，因此快照所有源节点窗口内的日期；另外补上历史分区
    记录的、可能落在当前窗口之外的源输入。集合本身确定，只有源值变化才会
    改变指纹，不会误报。
    """
    points: Dict[Tuple[str, str], Optional[float]] = {}
    for name in nodes:
        spec = config.nodes[name]
        if spec.kind != "source":
            continue
        for day in _iter_intervals(windows.get(name, [])):
            iso = day.isoformat()
            points[(spec.source, iso)] = store.get_source_value(spec.source, iso)
    for items in snapshot.inputs.values():
        for item in items:
            if item.ref_kind == "source":
                points[(item.ref, item.ref_date)] = store.get_source_value(
                    item.ref, item.ref_date
                )
    payload = json.dumps(
        {"points": [[s, d, v] for (s, d), v in sorted(points.items())]},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return _sha256(payload), payload, len(points)


def _plan_signature(
    config: Config,
    target: str,
    start: dt.date,
    end: dt.date,
    rows: Dict[Tuple[str, str], PlanRow],
    windows: Dict[str, List[Interval]],
    inputs_sig: str,
) -> str:
    decisions = []
    for (node, iso), row in sorted(rows.items()):
        prev = row.previous
        decisions.append([
            node, iso, row.action, row.kind,
            prev.value if prev else None,
            prev.status if prev else None,
            prev.rule_sig if prev else None,
            prev.deps_sig if prev else None,
            row.will_block,
        ])
    payload = {
        "config_sig": config.sig,
        "target": target,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "inputs_sig": inputs_sig,
        "windows": sorted(
            (n, [[lo.isoformat(), hi.isoformat()] for lo, hi in iv])
            for n, iv in windows.items()
        ),
        "decisions": decisions,
    }
    return _sha256(canonical_json(payload))


# 计划为"重算"的上游分区可能改变值，也可能变成阻塞；下游即便自己记录的输入
# 现在看着一致，也无法安全复用，因此只要任一上游输入本轮会被重算，就沿依赖
# 继续传播。
def build_plan(store: Store, config: Config, target: str, start: dt.date, end: dt.date) -> Plan:
    if target not in config.nodes:
        raise PlanError("未知目标节点「%s」（可用：%s）" % (target, ", ".join(config.order)))
    if start > end:
        raise PlanError("开始日期不能晚于结束日期")

    nodes = closure_nodes(config, target)
    if any(_uses_start(config, n) for n in nodes):
        if config.anchor is None:
            raise PlanError("计算规则用到 from=start（累计指标），但配置没有 anchor 锚点日期")
        if start < config.anchor:
            raise PlanError(
                "开始日期 %s 早于锚点日期 %s（累计指标从锚点开始）"
                % (start.isoformat(), config.anchor.isoformat())
            )

    windows = needed_windows(config, target, start, end)
    for name in nodes:
        windows.setdefault(name, [])
    _validate_ranges(config, nodes, windows)
    snapshot = Snapshot(store, windows)

    rows: Dict[Tuple[str, str], PlanRow] = {}
    for name in nodes:
        deps_sig = deps_signature(config, name)
        spec = config.nodes[name]
        for day in _iter_intervals(windows[name]):
            iso = day.isoformat()
            part = snapshot.partition(name, iso)
            check = check_partition_reuse(
                config, name, day, part, deps_sig, snapshot.inputs_of(name, iso), snapshot, store
            )
            row = PlanRow(
                node=name,
                date=day,
                action="reuse" if check.reusable else "recompute",
                reason=check.reason,
                kind=check.kind,
                previous=part,
                in_scope=(start <= day <= end),
            )
            if row.action == "reuse" and spec.kind == "sum":
                hit = _first_recomputed_input(spec, day, config, rows)
                if hit is not None:
                    row.action = "recompute"
                    row.kind = "upstream"
                    row.reason = "上游 %s@%s 本轮将重算（%s）" % (
                        hit[0], hit[1], _GROUP_ORDER.get(rows[(hit[0], hit[1])].kind, "状态变化")
                    )
            rows[(name, iso)] = row

    inputs_sig, inputs_json, inputs_count = _snapshot_inputs(
        store, config, nodes, windows, snapshot
    )
    plan_sig = _plan_signature(config, target, start, end, rows, windows, inputs_sig)
    plan = Plan(
        target=target, start=start, end=end, config=config, windows=windows,
        rows=rows, inputs_sig=inputs_sig, inputs_json=inputs_json,
        inputs_count=inputs_count, plan_sig=plan_sig, preview_path=config.path,
    )
    for row in plan.recompute:
        row.inputs_note = _input_note(config, row.node, row.date)
    _predict_blockers(store, plan)
    return plan


def _first_recomputed_input(
    spec, day: dt.date, config: Config, rows: Dict[Tuple[str, str], PlanRow]
) -> Optional[Tuple[str, str]]:
    """若本分区的某个上游输入本轮会被重算，返回该 (节点, 日期)。"""
    for inp in spec.inputs:
        lo, hi = resolve_input_range(inp, day, config.anchor)
        if lo > hi:
            continue
        for sd in date_range(lo, hi):
            iso = sd.isoformat()
            up = rows.get((inp.node, iso))
            if up is not None and up.action == "recompute":
                return (inp.node, iso)
    return None


def _predict_blockers(store: Store, plan: Plan) -> None:
    """预演执行：标出确定会阻塞的重算分区（源缺失、上游预计阻塞）。"""
    for name in closure_nodes(plan.config, plan.target):
        spec = plan.config.nodes[name]
        for row in plan.recompute_for(name):
            if spec.kind == "source":
                if spec.missing == "error":
                    value = store.get_source_value(spec.source, row.date.isoformat())
                    if value is None:
                        row.will_block = "源「%s」@%s 没有数值" % (
                            spec.source, row.date.isoformat()
                        )
                continue
            problems: List[str] = []
            for inp in spec.inputs:
                lo, hi = resolve_input_range(inp, row.date, plan.config.anchor)
                if lo > hi:
                    continue
                for sd in date_range(lo, hi):
                    iso = sd.isoformat()
                    planned = plan.rows.get((inp.node, iso))
                    if planned is None:
                        continue
                    if planned.will_block:
                        problems.append("%s@%s 预计阻塞" % (inp.node, iso))
                        break
            if problems:
                row.will_block = "；".join(problems[:3])


# ---------------------------------------------------------------- 序列化 / 输出


def plan_to_json(plan: Plan, preview_id: Optional[str] = None) -> str:
    rows = sorted(plan.rows.values(), key=lambda r: (r.node, r.date))
    return json.dumps(
        {
            "preview_id": preview_id,
            "target": plan.target,
            "start": plan.start.isoformat(),
            "end": plan.end.isoformat(),
            "config_sig": plan.config.sig,
            "inputs_sig": plan.inputs_sig,
            "plan_sig": plan.plan_sig,
            "recompute": len(plan.recompute),
            "reuse": len(plan.reuse),
            "rows": [
                {
                    "node": r.node,
                    "date": r.date.isoformat(),
                    "action": r.action,
                    "kind": r.kind,
                    "in_target_range": r.in_scope,
                    "reason": r.reason,
                    "inputs": r.inputs_note,
                    "old_value": r.previous.value if r.previous else None,
                    "old_status": r.previous.status if r.previous else None,
                    "predicted_block": r.will_block,
                }
                for r in rows
            ],
        },
        ensure_ascii=False,
        indent=2,
    )


_GROUP_ORDER = {
    "new": "新日期/尚无结果",
    "input": "读取的源值或上游值变了",
    "rule": "节点自身的计算规则变了",
    "deps": "上游规则或锚点变了",
    "pending": "上次未算完",
    "blocked": "上次被阻塞",
    "upstream": "依赖的上游本轮要重算",
    "abnormal": "上次状态异常",
}


def render_plan(plan: Plan, preview_id: Optional[str] = None, details: int = 8) -> str:
    """给人看的预览报告：哪些要重算、哪些能复用、为什么。"""
    lines: List[str] = []
    lines.append("预览%s" % (" %s" % preview_id if preview_id else ""))
    lines.append(
        "目标节点：%s（%s）" % (plan.target, plan.config.nodes[plan.target].rule_description())
    )
    lines.append("日期范围：%s .. %s" % (plan.start.isoformat(), plan.end.isoformat()))
    if plan.config.anchor is not None:
        lines.append(
            "锚点日期：%s%s"
            % (
                plan.config.anchor.isoformat(),
                "（累计指标的起点）"
                if any(_uses_start(plan.config, n) for n in closure_nodes(plan.config, plan.target))
                else "（本次未使用）",
            )
        )
    lines.append("")
    lines.append(
        "结论：需重算 %d 个分区，可复用 %d 个分区" % (len(plan.recompute), len(plan.reuse))
    )

    for name in closure_nodes(plan.config, plan.target):
        rows = plan.rows_for(name)
        n_re = sum(1 for r in rows if r.action == "recompute")
        if n_re == 0:
            detail = "全部复用"
        elif n_re == len(rows):
            detail = "全部重算"
        else:
            detail = "重算 %d、复用 %d" % (n_re, len(rows) - n_re)
        lines.append(
            "  %-16s[%s]  %d 个分区  需要日期 %s  %s"
            % (name, plan.config.nodes[name].kind, len(rows),
               _intervals_text(plan.windows[name]), detail)
        )

    remaining = max(details, 0)
    for name in closure_nodes(plan.config, plan.target):
        re_rows = [r for r in plan.rows_for(name) if r.action == "recompute"]
        if not re_rows:
            continue
        lines.append("")
        lines.append("  ▶ %s 需要重算 %d 个分区" % (name, len(re_rows)))
        groups: Dict[str, List[PlanRow]] = {}
        for row in re_rows:
            groups.setdefault(_GROUP_ORDER.get(row.kind, row.reason), []).append(row)
        for label in sorted(groups, key=lambda k: (-len(groups[k]), k)):
            group = groups[label]
            if label in ("读取的源值或上游值变了", "依赖的上游本轮要重算"):
                for reason, dates in _group_by_reason(group):
                    lines.append(
                        "     • %s  涉及 %d 天：%s" % (reason, len(dates), _dates_brief(dates))
                    )
            else:
                lines.append(
                    "     • %s  涉及 %d 天：%s"
                    % (label, len(group), _dates_brief([r.date for r in group]))
                )
        if remaining > 0:
            shown = re_rows[:remaining]
            lines.append("     逐日示例（实际读取范围）：")
            for row in shown:
                lines.append(
                    "       %s  %s   %s" % (row.date.isoformat(), row.node, row.inputs_note)
                )
            remaining -= len(shown)

    if plan.reuse:
        lines.append("")
        lines.append("  ▶ 可复用的分区（不重新计算），共 %d 个" % len(plan.reuse))
        for row in plan.reuse[:3]:
            lines.append("     • %s  %s：%s" % (row.node, row.date.isoformat(), row.reason))
        if len(plan.reuse) > 3:
            lines.append("     • 其余 %d 个同样满足复用条件" % (len(plan.reuse) - 3))

    predicted = [r for r in plan.recompute if r.will_block]
    if predicted:
        lines.append("")
        lines.append("  ▶ 预计无法完成的分区（执行时记为阻塞，不影响其他日期）")
        by_node: Dict[str, List[PlanRow]] = {}
        for row in predicted:
            by_node.setdefault(row.node, []).append(row)
        for name, items in by_node.items():
            lines.append(
                "     • %s：%d 个，%s（原因：%s）"
                % (name, len(items), _dates_brief([r.date for r in items]), items[0].will_block or "")
            )

    lines.append("")
    lines.append(
        "判定说明：滚动/累计指标按分区实际读取的日期范围判断影响；源值或规则变化"
        "只会波及真正读取了它们的日期。"
    )
    lines.append(
        "本次快照 %d 个源值。确认后执行：apply %s"
        % (plan.inputs_count, preview_id or "<预览ID>")
    )
    lines.append("若预览之后源数据或计算规则再次变化，执行时会拒绝并提示重新预览。")
    return "\n".join(lines)


def _group_by_reason(rows: Sequence[PlanRow]) -> List[Tuple[str, List[dt.date]]]:
    groups: Dict[str, List[dt.date]] = {}
    for row in rows:
        groups.setdefault(row.reason, []).append(row.date)
    return sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))


# ---------------------------------------------------------------- 预览记录


def load_preview_config(preview_row) -> Config:
    path = preview_row["config_path"]
    if not path:
        raise PlanError("预览记录缺少配置文件路径，无法复核规则")
    try:
        text = read_config_text(path)
    except OSError as exc:
        raise PlanError("无法读取配置文件 %s：%s" % (path, exc)) from None
    config = config_from_text(text, path)
    if config.sig != preview_row["config_sig"]:
        raise PlanError(
            "计算规则在预览之后发生了变化，需要重新预览。\n"
            "  配置文件：%s\n  预览 %s 使用的规则已与当前文件不同。" % (path, preview_row["id"])
        )
    return config


def verify_preview(store: Store, preview_id: str) -> Plan:
    """执行前复核：规则、源值、计划都没有变，否则拒绝并要求重新预览。"""
    row = store.get_preview(preview_id)
    if row is None:
        raise PlanError("找不到预览「%s」" % preview_id)
    if row["status"] == "applied":
        raise PlanError("预览 %s 已经执行过；如需按当前数据重算，请重新预览。" % preview_id)

    config = load_preview_config(row)
    plan = build_plan(
        store, config, row["target"],
        dt.date.fromisoformat(row["start_date"]),
        dt.date.fromisoformat(row["end_date"]),
    )
    problems: List[str] = []
    if plan.inputs_sig != row["inputs_sig"]:
        problems.append(_describe_input_drift(row["inputs_json"], plan.inputs_json))
    elif plan.plan_sig != row["plan_sig"]:
        problems.append("相关分区的历史结果发生了变化（可能已有另一次运行改写了它们）")
    if problems:
        raise PlanError(
            "预览 %s 已过期，请重新预览后再执行：\n  - %s"
            % (preview_id, "\n  - ".join(problems))
        )
    return plan


def _describe_input_drift(old_json: str, new_json: str, limit: int = 5) -> str:
    def parse(text: str):
        try:
            data = json.loads(text)
            return {(p[0], p[1]): p[2] for p in data.get("points", [])}
        except Exception:
            return {}

    old, new = parse(old_json), parse(new_json)
    diffs = []
    for key in sorted(set(old) | set(new)):
        if old.get(key) != new.get(key):
            diffs.append(
                "源「%s」@%s：%s → %s"
                % (key[0], key[1], fmt_num(old.get(key)), fmt_num(new.get(key)))
            )
    if not diffs:
        return "源数据有变化（快照指纹不同）"
    text = "；".join(diffs[:limit])
    if len(diffs) > limit:
        text += "；另有 %d 处" % (len(diffs) - limit)
    return "源数据有变化：" + text


# ---------------------------------------------------------------- 执行


@dataclass
class RunResult:
    run_id: str
    worked: int = 0
    blocked: int = 0
    reused: int = 0
    interrupted: bool = False
    error: Optional[str] = None
    per_node: Dict[str, int] = field(default_factory=dict)
    blocked_nodes: Dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.error is None and not self.interrupted


def _dedupe(items: Iterable[PartitionInput]) -> List[PartitionInput]:
    seen: Dict[Tuple[str, str, str], PartitionInput] = {}
    for item in items:
        seen[item.key()] = item
    return [seen[key] for key in sorted(seen)]


def compute_partition(
    store: Store, config: Config, node: str, day: dt.date
) -> Tuple[Optional[float], Optional[str], List[PartitionInput]]:
    """计算一个分区，返回 (值, 阻塞原因, 实际读取的输入)。"""
    spec = config.nodes[node]

    if spec.kind == "source":
        value = store.get_source_value(spec.source, day.isoformat())
        item = source_input(spec.source, day.isoformat(), value)
        if value is None:
            if spec.missing == "error":
                return None, "源「%s」在 %s 没有数值" % (spec.source, day.isoformat()), [item]
            return 0.0, None, [item]
        return value, None, [item]

    value = 0.0
    inputs: List[PartitionInput] = []
    problems: List[str] = []
    for inp in spec.inputs:
        lo, hi = resolve_input_range(inp, day, config.anchor)
        if lo > hi:
            continue
        for sd in date_range(lo, hi):
            got = store.get_partition(inp.node, sd.isoformat())
            if got is None:
                problems.append("%s@%s 未计算" % (inp.node, sd.isoformat()))
                continue
            if got.status != "done":
                problems.append("%s@%s 不可用（%s）" % (inp.node, sd.isoformat(), got.status))
                continue
            value += inp.weight * (got.value or 0.0)
            inputs.append(partition_input(inp.node, sd.isoformat(), got.value))
    if problems:
        text = "；".join(problems[:4])
        if len(problems) > 4:
            text += "；另有 %d 处" % (len(problems) - 4)
        return None, "上游结果不可用：" + text, _dedupe(inputs)
    return value, None, _dedupe(inputs)


def execute_plan(
    store: Store, plan: Plan, run_id: str, stop_after: Optional[int] = None
) -> RunResult:
    """按计划执行。

    pending 标记在即将计算某个分区前才写入：进程中途退出时，已算完的分区
    保持 done，重新预览即可复用；最多一个分区停在 pending，但它的输入快照
    已被清空，重新规划时会当作"未算完"重算。stop_after 仅用于测试中断。
    """
    result = RunResult(run_id=run_id, reused=len(plan.reuse))
    done = 0
    try:
        for name in closure_nodes(plan.config, plan.target):
            deps_sig = deps_signature(plan.config, name)
            spec = plan.config.nodes[name]
            anchor = plan.config.anchor.isoformat() if plan.config.anchor else None
            for row in plan.recompute_for(name):
                if stop_after is not None and done >= stop_after:
                    raise KeyboardInterrupt
                iso = row.date.isoformat()
                store.insert_pending([(name, iso, spec.rule_sig, deps_sig, anchor)], run_id)
                value, reason, inputs = compute_partition(store, plan.config, name, row.date)
                if value is None:
                    store.finish_partition(
                        name, iso, "blocked", None, spec.rule_sig, deps_sig, anchor,
                        reason, inputs, run_id,
                    )
                    result.blocked += 1
                    result.blocked_nodes[name] = result.blocked_nodes.get(name, 0) + 1
                else:
                    store.finish_partition(
                        name, iso, "done", value, spec.rule_sig, deps_sig, anchor,
                        None, inputs, run_id,
                    )
                    result.worked += 1
                    result.per_node[name] = result.per_node.get(name, 0) + 1
                done += 1
    except KeyboardInterrupt:
        result.interrupted = True
        result.error = "执行被中断；已完成的分区已保存，重新预览时可复用输入未变的分区。"
    except (PlanError, StoreError) as exc:
        result.error = str(exc)
    except Exception as exc:  # 兜底：记录失败但保留已完成分区
        result.error = "执行失败：%s" % exc
    return result


# ---------------------------------------------------------------- 结果展示


def render_results(
    store: Store, config: Config, target: str, start: dt.date, end: dt.date
) -> str:
    if target not in config.nodes:
        raise PlanError("未知节点「%s」" % target)
    windows = needed_windows(config, target, start, end)
    for name in closure_nodes(config, target):
        windows.setdefault(name, [])
    lines = ["节点 %s 在 %s .. %s 的结果：" % (target, start.isoformat(), end.isoformat())]
    rows = store.get_partitions(target, start.isoformat(), end.isoformat())
    if not rows:
        lines.append("  （范围内没有已计算的分区）")
    for row in rows:
        if row.status == "done":
            detail = fmt_num(row.value)
        elif row.status == "blocked":
            detail = "阻塞：%s" % (row.reason or "上游不可用")
        else:
            detail = "未完成"
        lines.append("  %s  %-8s %s" % (row.date, row.status, detail))
    lines.append("")
    lines.append("各节点的状态（目标范围之外的上游分区也会被算出来）：")
    for name in closure_nodes(config, target):
        counts: Dict[str, int] = {}
        for lo, hi in windows[name]:
            for row in store.get_partitions(name, lo.isoformat(), hi.isoformat()):
                counts[row.status] = counts.get(row.status, 0) + 1
        text = "、".join("%s %d" % (k, v) for k, v in sorted(counts.items())) or "无"
        lines.append(
            "  %-16s[%s]  需要日期 %s  %s"
            % (name, config.nodes[name].kind, _intervals_text(windows[name]), text)
        )
    return "\n".join(lines)
