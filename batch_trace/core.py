"""核心追溯引擎。

规则要点：
* 每个批号有且只有一个来源（一条采购记录，或某张加工单的一个产出）。
* 加工单把本单全部投入按重量混合，每个产出按 ``产出重量 / 投入重量`` 继承混合比例；
  因此同一加工单的全部产出、产出被部分领用后剩余的部分，每千克的来源构成都相同。
* 从某批号领用 w 千克，按该批号的每千克来源构成带走来源重量。
* 全程 Fraction 精确计算，只在最终输出时四舍五入到 0.001 千克。
* 数据问题独立沿依赖关系向下游传播；受影响批号不参与计算，其余批号照常计算。
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from fractions import Fraction

from .model import InputError, Issue, OrderRecord, PurchaseRecord

TOL_KG = Fraction(1, 1_000_000_000)
KIND_RANK = {
    "missing-batch": 0,
    "duplicate-source": 1,
    "imbalance": 2,
    "cycle": 3,
    "over-withdrawal": 4,
}
REASON = {
    "missing-batch": "缺失批号",
    "duplicate-source": "来源重复",
    "imbalance": "投入产出不平",
    "cycle": "循环引用",
    "over-withdrawal": "累计领用超量",
}


def _scale(value: Fraction, places: int) -> int:
    """把 value 精确四舍五入（half-up）到 10^-places 的整数倍，返回该整数。"""
    scale = 10 ** places
    num = value.numerator * scale
    den = value.denominator
    if num >= 0:
        return (2 * num + den) // (2 * den)
    return -((-2 * num + den) // (2 * den))


def _scaled_str(value: Fraction, places: int) -> str:
    scaled = _scale(value, places)
    sign = "-" if scaled < 0 else ""
    digits = str(abs(scaled)).rjust(places + 1, "0")
    if places == 0:
        return sign + digits
    return f"{sign}{digits[:-places]}.{digits[-places:]}"


def round_kg(value: Fraction) -> float:
    """四舍五入到 0.001 千克，返回 JSON 友好的浮点数。"""
    result = _scale(value, 3) / 1000
    return 0.0 if result == 0 else result


def _num(value: Fraction, places: int = 6) -> float:
    result = _scale(value, places) / 10 ** places
    return 0.0 if result == 0 else result


def _fmt(value: Fraction, places: int = 3) -> str:
    return _scaled_str(value, places)


@dataclass(frozen=True, slots=True)
class _Claim:
    kind: str  # "purchase" | "order"
    ref_id: str
    weight_kg: Fraction
    label: str
    order: OrderRecord | None = None


def _batch_node(batch_id: str, reason: str | None = None) -> dict:
    node: dict = {"type": "batch", "id": batch_id}
    if reason is not None:
        node["reason"] = reason
    return node


def _order_node(order_id: str, reason: str | None = None) -> dict:
    node: dict = {"type": "order", "id": order_id}
    if reason is not None:
        node["reason"] = reason
    return node


def format_chain(chain: list[dict]) -> str:
    parts = []
    for node in chain:
        text = f"批号 {node['id']}" if node["type"] == "batch" else f"加工单 {node['id']}"
        reason = node.get("reason")
        if reason:
            text += f"（{reason}）"
        parts.append(text)
    return " → ".join(parts)


def _strongly_connected(adj: dict[str, set[str]]) -> list[list[str]]:
    """迭代版 Kosaraju，返回按节点排序的强连通分量列表。"""
    nodes = sorted(adj)
    visited: set[str] = set()
    finish: list[str] = []
    for start in nodes:
        if start in visited:
            continue
        visited.add(start)
        stack: list[tuple[str, object]] = [(start, iter(sorted(adj[start])))]
        while stack:
            node, it = stack[-1]
            advanced = False
            for nxt in it:  # type: ignore[union-attr]
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append((nxt, iter(sorted(adj[nxt]))))
                    advanced = True
                    break
            if not advanced:
                finish.append(node)
                stack.pop()

    radj: dict[str, set[str]] = {n: set() for n in nodes}
    for u in nodes:
        for v in adj[u]:
            radj[v].add(u)

    assigned: set[str] = set()
    comps: list[list[str]] = []
    for start in reversed(finish):
        if start in assigned:
            continue
        comp: list[str] = []
        assigned.add(start)
        stack = [start]
        while stack:
            node = stack.pop()
            comp.append(node)
            for nxt in sorted(radj[node]):
                if nxt not in assigned:
                    assigned.add(nxt)
                    stack.append(nxt)
        comps.append(sorted(comp))
    return comps


def _find_cycle_path(comp: list[str], adj: dict[str, set[str]]) -> list[str] | None:
    """在强连通分量内找出一条具体环路，如 M-02 → M-03 → M-02。"""
    comp_set = set(comp)
    start = comp[0]
    path = [start]
    on_path = {start}
    stack: list[tuple[str, object]] = [(start, iter(sorted(adj[start] & comp_set)))]
    while stack:
        node, it = stack[-1]
        for nxt in it:  # type: ignore[union-attr]
            if nxt in on_path:
                return path[path.index(nxt):] + [nxt]
            if nxt not in path:
                path.append(nxt)
                on_path.add(nxt)
                stack.append((nxt, iter(sorted(adj[nxt] & comp_set))))
                break
        else:
            stack.pop()
            path.pop()
            on_path.discard(node)
    return None


class TraceEngine:
    def __init__(
        self,
        purchases: list[PurchaseRecord],
        orders: list[OrderRecord],
        tolerance: Fraction = TOL_KG,
    ) -> None:
        self.purchases = list(purchases)
        self.orders = list(orders)
        self.tol = tolerance
        self._validate()

        self.claims: dict[str, list[_Claim]] = defaultdict(list)
        self.producer: dict[str, _Claim] = {}
        self.consumed: dict[str, Fraction] = defaultdict(Fraction)
        self.consumers: dict[str, list[OrderRecord]] = defaultdict(list)
        self.order_by_id: dict[str, OrderRecord] = {}
        self._perkg: dict[str, dict[str, Fraction]] = {}

        self._index_claims()
        self.issues: list[Issue] = []
        self._detect_duplicates()
        self._detect_missing()
        self._detect_imbalances()
        self._detect_cycles()
        self._detect_over_withdrawal()
        self._finalize_issue_ids()

        self.affected_by: dict[str, list[Issue]] = defaultdict(list)
        self.primary: dict[str, tuple[Issue, list[dict]]] = {}
        self._issue_chains: dict[int, dict[str, list[dict]]] = {}
        self._propagate()
        self._attach_affected_products()

    # ------------------------------------------------------------------ setup

    def _validate(self) -> None:
        seen_orders: set[str] = set()
        for p in self.purchases:
            if not isinstance(p.batch_id, str) or not p.batch_id.strip():
                raise InputError("采购记录缺少批号")
            if p.weight_kg < 0:
                raise InputError(f'采购批次 "{p.batch_id}" 的入库重量不能为负')
        for o in self.orders:
            if not isinstance(o.order_id, str) or not o.order_id.strip():
                raise InputError("加工单缺少加工单号")
            if o.order_id in seen_orders:
                raise InputError(f'加工单号 "{o.order_id}" 重复')
            seen_orders.add(o.order_id)
            if o.loss_kg < 0:
                raise InputError(f'加工单 "{o.order_id}" 的损耗不能为负')
            for flow in o.inputs + o.outputs:
                if not isinstance(flow.batch_id, str) or not flow.batch_id.strip():
                    raise InputError(f'加工单 "{o.order_id}" 中有投入或产出缺少批号')
                if flow.weight_kg < 0:
                    raise InputError(
                        f'加工单 "{o.order_id}" 中批号 "{flow.batch_id}" 的重量不能为负'
                    )

    def _index_claims(self) -> None:
        for i, p in enumerate(self.purchases):
            self.claims[p.batch_id].append(
                _Claim("purchase", p.batch_id, p.weight_kg, f"采购记录 #{i + 1}")
            )
        for o in self.orders:
            self.order_by_id[o.order_id] = o
            for j, flow in enumerate(o.outputs, start=1):
                self.claims[flow.batch_id].append(
                    _Claim(
                        "order",
                        o.order_id,
                        flow.weight_kg,
                        f"加工单 {o.order_id} 的第 {j} 个产出",
                        order=o,
                    )
                )
            for flow in o.inputs:
                self.consumed[flow.batch_id] += flow.weight_kg
                self.consumers[flow.batch_id].append(o)
        for batch_id, claims in self.claims.items():
            if len(claims) == 1:
                self.producer[batch_id] = claims[0]

    def produced_weight(self, batch_id: str) -> Fraction:
        claim = self.producer.get(batch_id)
        return claim.weight_kg if claim is not None else Fraction(0)

    def _remaining(self, batch_id: str) -> Fraction:
        remaining = self.produced_weight(batch_id) - self.consumed.get(batch_id, Fraction(0))
        return max(remaining, Fraction(0))

    # --------------------------------------------------------------- detection

    def _add_issue(
        self,
        kind: str,
        message: str,
        *,
        batch_id: str | None = None,
        order_id: str | None = None,
        details: dict | None = None,
        sort_key: tuple | None = None,
    ) -> Issue:
        issue = Issue(issue_id="", kind=kind, message=message, batch_id=batch_id, order_id=order_id)
        issue.details = details or {}
        issue.details["_sort"] = sort_key or (
            KIND_RANK[kind],
            batch_id or "",
            order_id or "",
        )
        self.issues.append(issue)
        return issue

    def _detect_duplicates(self) -> None:
        for batch_id in sorted(self.claims):
            claims = self.claims[batch_id]
            if len(claims) < 2:
                continue
            ordered = sorted(claims, key=lambda c: c.label)
            self._add_issue(
                "duplicate-source",
                f'批号 "{batch_id}" 有 {len(claims)} 个来源，每个批号只能有一个来源',
                batch_id=batch_id,
                details={
                    "claims": [
                        {
                            "source": c.label,
                            "kind": c.kind,
                            "weight_kg": _num(c.weight_kg),
                        }
                        for c in ordered
                    ]
                },
            )

    def _detect_missing(self) -> None:
        missing: dict[str, dict] = {}
        for o in self.orders:
            for flow in o.inputs:
                if flow.batch_id in self.claims:
                    continue
                entry = missing.setdefault(
                    flow.batch_id, {"orders": set(), "weight_kg": Fraction(0)}
                )
                entry["orders"].add(o.order_id)
                entry["weight_kg"] += flow.weight_kg
        for batch_id in sorted(missing):
            entry = missing[batch_id]
            orders = sorted(entry["orders"])
            self._add_issue(
                "missing-batch",
                (
                    f'批号 "{batch_id}" 既不是采购批次，也不是任何加工单的产出'
                    f"（被加工单 {', '.join(orders)} 投入）"
                ),
                batch_id=batch_id,
                order_id=orders[0],
                details={"weight_kg": _num(entry["weight_kg"]), "orders": orders},
            )

    def _detect_imbalances(self) -> None:
        for o in self.orders:
            diff = o.input_kg - o.output_kg - o.loss_kg
            if abs(diff) <= self.tol:
                continue
            self._add_issue(
                "imbalance",
                (
                    f'加工单 "{o.order_id}" 投入 {_fmt(o.input_kg)} kg，'
                    f"产出 {_fmt(o.output_kg)} kg，损耗 {_fmt(o.loss_kg)} kg，"
                    f"投入不等于产出加损耗（差额 {_fmt(diff)} kg）"
                ),
                order_id=o.order_id,
                details={
                    "input_kg": _num(o.input_kg),
                    "output_kg": _num(o.output_kg),
                    "loss_kg": _num(o.loss_kg),
                    "difference_kg": _num(diff),
                },
            )

    def _order_graph(self) -> dict[str, set[str]]:
        """加工单依赖图：u -> v 表示 v 领用了 u 的某个产出。

        仅在批号来源唯一时建边；来源重复的批号无法确定真正生产方，其问题
        已由 duplicate-source 报告，不再伪造循环边。
        """
        adj: dict[str, set[str]] = {o.order_id: set() for o in self.orders}
        for o in self.orders:
            for flow in o.inputs:
                claim = self.producer.get(flow.batch_id)
                if claim is not None and claim.kind == "order":
                    adj[claim.ref_id].add(o.order_id)
        return adj

    def _detect_cycles(self) -> None:
        adj = self._order_graph()
        for comp in _strongly_connected(adj):
            if len(comp) == 1 and comp[0] not in adj[comp[0]]:
                continue
            path = _find_cycle_path(comp, adj)
            if path is None:
                continue
            produced = {f.batch_id for oid in comp for f in self.order_by_id[oid].outputs}
            consumed = {f.batch_id for oid in comp for f in self.order_by_id[oid].inputs}
            self._add_issue(
                "cycle",
                "加工单存在循环引用：" + " → ".join(path),
                order_id=path[0],
                details={
                    "orders": sorted(comp),
                    "cycle_path": path,
                    "batch_ids": sorted(produced & consumed),
                },
                sort_key=(KIND_RANK["cycle"], "", "|".join(sorted(comp))),
            )

    def _detect_over_withdrawal(self) -> None:
        for batch_id in sorted(self.claims):
            if len(self.claims[batch_id]) != 1:
                continue
            available = self.claims[batch_id][0].weight_kg
            taken = self.consumed.get(batch_id, Fraction(0))
            if taken <= available + self.tol:
                continue
            orders = sorted({o.order_id for o in self.consumers.get(batch_id, ())})
            self._add_issue(
                "over-withdrawal",
                (
                    f'批号 "{batch_id}" 跨加工单累计领用 {_fmt(taken)} kg，'
                    f"超过可领用的 {_fmt(available)} kg（超出 {_fmt(taken - available)} kg）"
                ),
                batch_id=batch_id,
                details={
                    "available_kg": _num(available),
                    "withdrawn_kg": _num(taken),
                    "excess_kg": _num(taken - available),
                    "orders": orders,
                },
            )

    def _finalize_issue_ids(self) -> None:
        self.issues.sort(key=lambda i: i.details.pop("_sort"))
        for n, issue in enumerate(self.issues, start=1):
            issue.issue_id = f"I{n:03d}"

    # -------------------------------------------------------------- taint flow

    def _seeds(self, issue: Issue) -> list[tuple[str, list[dict]]]:
        reason = REASON[issue.kind]
        if issue.kind in ("missing-batch", "duplicate-source", "over-withdrawal"):
            assert issue.batch_id is not None
            return [(issue.batch_id, [_batch_node(issue.batch_id, reason)])]
        if issue.kind == "imbalance":
            order = self.order_by_id[issue.order_id]
            return [
                (out.batch_id, [_order_node(order.order_id, reason), _batch_node(out.batch_id)])
                for out in order.outputs
            ]
        # cycle：环内每张单的产出都受影响，链路给出从它所在加工单出发的完整环路
        path: list[str] = issue.details.get("cycle_path", [])
        seeds = []
        for oid in issue.details.get("orders", []):
            order = self.order_by_id[oid]
            cycle_nodes = path[:-1] if path and path[-1] == path[0] else list(path)
            if oid in cycle_nodes:
                k = cycle_nodes.index(oid)
                rotated = cycle_nodes[k:] + cycle_nodes[:k] + [oid]
            else:
                rotated = list(path)
            base = [_order_node(p) for p in rotated]
            if base:
                base[-1]["reason"] = reason
            seeds.extend(
                (out.batch_id, [dict(node) for node in base] + [_batch_node(out.batch_id)])
                for out in order.outputs
            )
        return seeds

    def _propagate(self) -> None:
        for issue in self.issues:
            chains: dict[str, list[dict]] = {}
            queue: deque[str] = deque()
            for batch_id, chain in self._seeds(issue):
                if batch_id in chains:
                    continue
                chains[batch_id] = chain
                queue.append(batch_id)
            while queue:
                batch_id = queue.popleft()
                chain = chains[batch_id]
                for order in sorted(
                    self.consumers.get(batch_id, ()), key=lambda o: o.order_id
                ):
                    for out in order.outputs:
                        if out.batch_id in chains:
                            continue
                        chains[out.batch_id] = chain + [
                            _order_node(order.order_id),
                            _batch_node(out.batch_id),
                        ]
                        queue.append(out.batch_id)
            self._issue_chains[id(issue)] = chains
            for batch_id, chain in chains.items():
                self.affected_by[batch_id].append(issue)
                if batch_id not in self.primary:
                    self.primary[batch_id] = (issue, chain)

    def _attach_affected_products(self) -> None:
        for issue in self.issues:
            products = []
            chains = self._issue_chains[id(issue)]
            for batch_id in sorted(chains):
                claim = self.producer.get(batch_id)
                if claim is None or claim.kind != "order":
                    continue
                remaining = self._remaining(batch_id)
                if remaining == 0:
                    continue
                products.append(
                    {
                        "batch_id": batch_id,
                        "remaining_kg": round_kg(remaining),
                        "chain": chains[batch_id],
                    }
                )
            issue.affected_products = products

    # -------------------------------------------------------------- calculation

    def _per_kg(self, batch_id: str) -> dict[str, Fraction]:
        """该批号每千克中包含的采购来源重量；迭代实现，避免长链路递归过深。"""
        if batch_id in self._perkg:
            return self._perkg[batch_id]
        stack: list[str] = [batch_id]
        on_stack: set[str] = {batch_id}
        while stack:
            current = stack[-1]
            if current in self._perkg:
                stack.pop()
                on_stack.discard(current)
                continue
            claim = self.producer.get(current)
            if claim is None:
                raise RuntimeError(
                    f'批号 "{current}" 没有唯一来源，不应参与计算（应已被标记为 affected）'
                )
            if claim.kind == "purchase":
                self._perkg[current] = {current: Fraction(1)}
                stack.pop()
                on_stack.discard(current)
                continue
            order = claim.order
            assert order is not None
            pending = next(
                (f.batch_id for f in order.inputs if f.batch_id not in self._perkg), None
            )
            if pending is not None:
                if pending in on_stack:
                    raise RuntimeError(
                        f'批号 "{pending}" 存在循环依赖，不应参与计算（应已被标记为 affected）'
                    )
                stack.append(pending)
                on_stack.add(pending)
                continue
            total_input = order.input_kg
            if total_input == 0:
                self._perkg[current] = {}
            else:
                mixture: dict[str, Fraction] = defaultdict(Fraction)
                for flow in order.inputs:
                    for source, share in self._perkg[flow.batch_id].items():
                        mixture[source] += share * flow.weight_kg
                self._perkg[current] = {
                    s: w / total_input for s, w in mixture.items() if w > 0
                }
            stack.pop()
            on_stack.discard(current)
        return self._perkg[batch_id]

    def _origin(self, batch_id: str, basis: str) -> tuple[dict[str, Fraction], Fraction]:
        per_kg = self._per_kg(batch_id)
        used = self.produced_weight(batch_id) if basis == "produced" else self._remaining(batch_id)
        return {s: w * used for s, w in per_kg.items()}, used

    @staticmethod
    def _contributions(origin: dict[str, Fraction]) -> list[dict]:
        items = [(source, weight) for source, weight in origin.items() if weight > 0]
        items.sort(key=lambda item: (-item[1], item[0]))
        return [
            {"purchase_batch_id": source, "weight_kg": round_kg(weight)}
            for source, weight in items
        ]

    def query(self, batch_id: str, basis: str = "produced") -> dict:
        if basis not in ("remaining", "produced"):
            raise ValueError('basis 只能是 "remaining" 或 "produced"')
        if batch_id in self.primary:
            issue, chain = self.primary[batch_id]
            return {
                "batch_id": batch_id,
                "status": "affected",
                "issue_id": issue.issue_id,
                "issue_type": issue.kind,
                "issue_ids": [i.issue_id for i in self.affected_by[batch_id]],
                "message": issue.message,
                "chain": chain,
                "chain_text": format_chain(chain),
            }
        if batch_id not in self.claims:
            return {
                "batch_id": batch_id,
                "status": "unknown",
                "message": f'批号 "{batch_id}" 不在采购记录或加工单产出中',
            }

        produced = self.produced_weight(batch_id)
        withdrawn = self.consumed.get(batch_id, Fraction(0))
        remaining = self._remaining(batch_id)
        origin, used = self._origin(batch_id, basis)
        result = {
            "batch_id": batch_id,
            "status": "ok",
            "basis": basis,
            "produced_kg": round_kg(produced),
            "withdrawn_kg": round_kg(withdrawn),
            "remaining_kg": round_kg(remaining),
            "accounted_kg": round_kg(used),
            "contributions": self._contributions(origin),
        }
        if basis == "remaining" and remaining == 0:
            result["note"] = "该批号已被下游加工单全部领用，剩余重量为 0"
        return result

    def _computable_products(self) -> list[str]:
        return sorted(
            b for b, c in self.producer.items() if c.kind == "order" and b not in self.primary
        )

    def _all_products(self) -> list[str]:
        return sorted(b for b, c in self.producer.items() if c.kind == "order")

    def product_summaries(self, basis: str = "produced") -> list[dict]:
        return [self.query(b, basis=basis) for b in self._computable_products()]

    def report(self, basis: str = "produced") -> dict:
        return {
            "summary": {
                "purchase_batches": len({p.batch_id for p in self.purchases}),
                "purchase_records": len(self.purchases),
                "orders": len(self.orders),
                "issues": len(self.issues),
                "products_total": len(self._all_products()),
                "computed_products": len(self._computable_products()),
                "affected_batches": len(self.primary),
            },
            "issues": [i.to_dict() for i in self.issues],
            "tainted_batches": [
                {
                    "batch_id": batch_id,
                    "issue_id": self.primary[batch_id][0].issue_id,
                    "issue_ids": [i.issue_id for i in self.affected_by[batch_id]],
                    "chain": self.primary[batch_id][1],
                    "chain_text": format_chain(self.primary[batch_id][1]),
                }
                for batch_id in sorted(self.primary)
            ],
            "products": self.product_summaries(basis),
        }


def build_engine(
    purchases: list[PurchaseRecord],
    orders: list[OrderRecord],
    tolerance: Fraction = TOL_KG,
) -> TraceEngine:
    return TraceEngine(purchases, orders, tolerance)
