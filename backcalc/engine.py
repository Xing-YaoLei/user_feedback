"""回算业务语义。

双时态规则
----------
每条校准记录有两个时间轴：
- registered_at：登记时间（什么时候录入系统），决定它在哪个截止时间之后才“可见”；
- [valid_from, valid_to)：生效区间（业务上覆盖哪些测量时刻），左闭右开。

查询截止时间 cutoff 下，对一条测量：
1. 仅考虑 registered_at <= cutoff 且生效区间覆盖 measured_at 的记录；
2. 按 registered_at 分组，从登记最晚的一组开始；
3. 该组只有一条 → 采用它；
4. 该组有多条（同一登记时刻、区间在该时刻重叠）→ 冲突，
   按“保留上次有效结果”回退到上一个登记时刻的组继续判定；
5. 所有候选组都冲突 → status=conflict；没有任何覆盖记录 → status=uncalibrated。

可复现性
--------
每个 cutoff 的查询结果冻结为一份快照（run/result 表）。
再次用同一 cutoff 查询时直接返回旧快照，因此事后补录的记录
（登记时间必然更晚）不会改变历史查询的答案。
"""

from __future__ import annotations

import ast
import json
from dataclasses import dataclass, field
from typing import Optional, Sequence

from .store import Store
from .timeutil import INFINITY

CALIBRATED = "calibrated"
UNCALIBRATED = "uncalibrated"
CONFLICT = "conflict"


@dataclass
class Outcome:
    """一条测量在某个 cutoff 下的回算结论。"""
    status: str
    cal_id: Optional[str] = None
    calibrated: Optional[float] = None
    conflict_cal_ids: list[str] = field(default_factory=list)

    def conflict_cal_ids_json(self) -> Optional[str]:
        return json.dumps(self.conflict_cal_ids,
                          ensure_ascii=False) if self.conflict_cal_ids else None

    @classmethod
    def uncalibrated(cls) -> "Outcome":
        return cls(status=UNCALIBRATED)

    @classmethod
    def conflict(cls, cal_ids: Sequence[str]) -> "Outcome":
        return cls(status=CONFLICT, conflict_cal_ids=sorted(cal_ids))

    @classmethod
    def calibrated_with(cls, cal_row, raw_reading: float) -> "Outcome":
        value = apply_coefficient(cal_row["coefficient"], raw_reading)
        return cls(status=CALIBRATED, cal_id=cal_row["cal_id"], calibrated=value)


def _covers(cal_row, measured_at: str) -> bool:
    """左闭右开区间 [valid_from, valid_to) 是否覆盖测量时刻。"""
    if measured_at < cal_row["valid_from"]:
        return False
    if cal_row["valid_to"] is not None and measured_at >= cal_row["valid_to"]:
        return False
    return True


def select_calibration(cal_rows: Sequence, measured_at: str):
    """按登记时间从晚到早选记录，冲突时回退到上一登记组。

    返回 (cal_row, conflict_ids)：
    - 命中唯一有效记录：(row, [])；
    - 跳过冲突组后回退到更早的唯一记录：(fallback_row, 冲突组编号)
      —— 即“指出冲突并保留上次有效结果”；
    - 没有任何覆盖记录：(None, [])                —— 未校准；
    - 所有候选组都冲突、无上次有效结果：(None, [ids...]) —— 冲突未决。
    """
    eligible = [r for r in cal_rows if _covers(r, measured_at)]
    if not eligible:
        return None, []

    # 按登记时间降序分组（同组内保持 SQL 的 cal_id 次序）
    groups: list[list] = []
    for row in sorted(eligible, key=lambda r: r["registered_at"], reverse=True):
        if groups and groups[-1][0]["registered_at"] == row["registered_at"]:
            groups[-1].append(row)
        else:
            groups.append([row])

    seen_conflicts: list[str] = []
    for grp in groups:
        if len(grp) == 1:
            return grp[0], seen_conflicts
        # 同一登记时刻多条记录同时覆盖该测量时刻 → 冲突，回退上一组
        seen_conflicts.extend(sorted(r["cal_id"] for r in grp))
    return None, seen_conflicts


class _CoefficientEvaluator(ast.NodeVisitor):
    """系数公式的最小安全求值器：仅支持数字、x 与 + - * / ** 括号。"""

    def __init__(self, x: float):
        self._x = x

    def visit_Expression(self, node):
        return self.visit(node.body)

    def visit_BinOp(self, node):
        left, right = self.visit(node.left), self.visit(node.right)
        op = type(node.op)
        if op is ast.Add:
            return left + right
        if op is ast.Sub:
            return left - right
        if op is ast.Mult:
            return left * right
        if op is ast.Div:
            return left / right
        if op is ast.Pow:
            return left ** right
        raise ValueError("系数公式只支持 + - * / ** 运算")

    def visit_UnaryOp(self, node):
        operand = self.visit(node.operand)
        if isinstance(node.op, ast.USub):
            return -operand
        if isinstance(node.op, ast.UAdd):
            return +operand
        raise ValueError("系数公式不支持该一元运算")

    def visit_Name(self, node):
        if node.id == "x":
            return self._x
        raise ValueError(f"系数公式出现未知变量 {node.id}，只允许 x")

    def visit_Constant(self, node):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError("系数公式只允许数字常量")

    def generic_visit(self, node):
        raise ValueError("不支持的系数公式写法")


def apply_coefficient(coefficient: str, raw_reading: float) -> float:
    """计算回算值。

    - 纯数字（如 ``1.05``）：回算值 = 原始读数 × 系数；
    - 含 x 的公式（如 ``x*1.05+0.2``、``x/1000``）：按公式求值。
    """
    text = coefficient.strip()
    try:
        return raw_reading * float(text)
    except ValueError:
        pass
    tree = ast.parse(text, mode="eval")
    return _CoefficientEvaluator(raw_reading).visit(tree)


# ---------------- 快照构建与增量重算 ----------------

@dataclass
class RunResult:
    run_id: int
    cutoff: str
    reused: bool
    total: int
    changes: list[dict]


def _source_key(result_row, outcome: Outcome) -> tuple:
    """校准来源是否变化的比较键。"""
    return (outcome.status, outcome.cal_id,
            tuple(outcome.conflict_cal_ids))


def _outcome_for(store: Store, instrument: str, measured_at: str,
                 raw_reading: float, cutoff: str, cache: dict) -> Outcome:
    if instrument not in cache:
        cache[instrument] = store.calibrations_for_instrument(instrument, cutoff)
    cal_row, conflict_ids = select_calibration(cache[instrument], measured_at)
    if cal_row is not None:
        outcome = Outcome.calibrated_with(cal_row, raw_reading)
        # 回退命中：沿用更早的唯一记录，同时保留冲突编号以便指出冲突
        outcome.conflict_cal_ids = conflict_ids
        return outcome
    if conflict_ids:
        return Outcome.conflict(conflict_ids)
    return Outcome.uncalibrated()


def ensure_run(store: Store, cutoff: str, note: Optional[str] = None) -> RunResult:
    """按 cutoff 查询：已有快照则复用，否则基于上一快照增量构建。"""
    existing = store.find_run(cutoff)
    if existing is not None:
        total = len(store.list_results(existing["run_id"]))
        return RunResult(existing["run_id"], cutoff, reused=True,
                         total=total, changes=[])

    prev = store.latest_run_before(cutoff)
    run_id = store.create_run(cutoff, note)
    changes: list[dict] = []
    cache: dict = {}

    with store.transaction():
        if prev is None:
            # 首个 run：全量基线，不产生“变更前后”清单
            candidates = [r["measurement_id"] for r in store.conn.execute(
                "SELECT measurement_id FROM measurement ORDER BY measurement_id"
            ).fetchall()]
        else:
            store.copy_snapshot(prev["run_id"], run_id)
            touched_instruments = store.instruments_with_new_calibrations(
                prev["cutoff"], cutoff)
            candidates = set(
                store.measurement_ids_for_instruments(touched_instruments))
            # 补录的测量明细本身也是新候选
            candidates.update(store.measurement_ids_not_in_run(run_id))
            candidates = sorted(candidates)

        # 分批取出测量，避免历史明细量大时一次性载入
        batch_size = 1000
        for start in range(0, len(candidates), batch_size):
            chunk = candidates[start:start + batch_size]
            for meas in store.get_measurements(chunk):
                outcome = _outcome_for(
                    store, meas["instrument"], meas["measured_at"],
                    meas["raw_reading"], cutoff, cache)

                old = store.get_result(run_id, meas["measurement_id"])
                store.upsert_result(run_id, meas, outcome)

                if prev is None or old is None:
                    if old is None and prev is not None:
                        # 增量 run 中首次进入快照的测量
                        changes.append(_change_row(meas, None, outcome))
                    continue

                old_key = (old["status"], old["cal_id"],
                           tuple(_load_conflict_ids(old["conflict_cal_ids"])))
                if old_key != _source_key(old, outcome):
                    changes.append(_change_row(meas, old, outcome))

        store.record_changes(run_id, changes)

    total = store.count_measurements()
    return RunResult(run_id, cutoff, reused=False, total=total, changes=changes)


def _load_conflict_ids(raw: Optional[str]) -> list[str]:
    if not raw:
        return []
    return json.loads(raw)


def _change_row(meas, old: Optional, outcome: Outcome) -> dict:
    return {
        "measurement_id": meas["measurement_id"],
        "instrument": meas["instrument"],
        "old_status": None if old is None else old["status"],
        "old_cal_id": None if old is None else old["cal_id"],
        "old_calibrated": None if old is None else old["calibrated"],
        "new_status": outcome.status,
        "new_cal_id": outcome.cal_id,
        "new_calibrated": outcome.calibrated,
    }


def list_conflicts(store: Store, cutoff: Optional[str] = None) -> list[dict]:
    """导入层面的区间重叠冲突清单（同仪器、同登记时刻、区间相交）。"""
    out = []
    for row in store.overlapping_groups(cutoff):
        out.append({
            "instrument": row["instrument"],
            "registered_at": row["registered_at"],
            "cal_id_a": row["cal_id_a"],
            "cal_id_b": row["cal_id_b"],
            "interval_a": f"[{row['a_from']}, {row['a_to'] or INFINITY})",
            "interval_b": f"[{row['b_from']}, {row['b_to'] or INFINITY})",
        })
    return out
