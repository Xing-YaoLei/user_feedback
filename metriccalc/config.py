"""节点配置的加载、校验与签名计算。

配置为 JSON（示例见 examples/metrics.json）：

    {
      "anchor": "2026-01-01",              // 可选；from=start 的累计指标起点
      "nodes": [
        {"name": "orders", "type": "source", "source": "orders", "missing": "zero"},
        {"name": "orders_7d", "type": "sum",
         "inputs": [{"node": "orders", "from": -6, "to": 0}]}
      ]
    }

* source 节点：直接读取名为 `source` 的源序列，某天没有数值时按 missing
  （zero 当 0，error 报错）处理。
* sum 节点：把 inputs 列表中每个输入的日期区间内上游节点的值加权求和。
  `offset: -1` 等价于 `from: -1, to: -1`（相对当天偏移，单位天，不能是未来）；
  `from: "start"` 表示从锚点日期开始、到当天为止（累计指标）。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


class ConfigError(ValueError):
    """配置不合法。"""


START = "start"

_ALLOWED_TOP = {"nodes", "anchor"}
_ALLOWED_SOURCE = {"name", "type", "source", "missing"}
_ALLOWED_SUM = {"name", "type", "inputs"}
_ALLOWED_INPUT = {"node", "offset", "from", "to", "weight"}


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_date(value, field: str) -> dt.date:
    if not isinstance(value, str):
        raise ConfigError("%s 必须是 YYYY-MM-DD 字符串" % field)
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        raise ConfigError("%s 不是合法日期（应为 YYYY-MM-DD）：%r" % (field, value)) from None


def _finite_number(value, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError("%s 必须是数字，收到 %r" % (field, value))
    value = float(value)
    if not math.isfinite(value):
        raise ConfigError("%s 必须是有限数字" % field)
    return value


def _require_int(value, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError("%s 必须是整数（单位：天），收到 %r" % (field, value))
    return value


def _fmt_num(value: float) -> str:
    value = float(value)
    if value.is_integer():
        return str(int(value))
    return ("%.6f" % value).rstrip("0").rstrip(".")


@dataclass(frozen=True)
class InputSpec:
    node: str
    from_kind: str   # "offset" 或 "start"
    from_offset: int
    to_offset: int
    weight: float

    def describe(self) -> str:
        if self.from_kind == START:
            span = "锚点..当天"
        elif self.from_offset == self.to_offset:
            span = "%+d 天" % self.from_offset
        else:
            span = "%+d..%+d 天" % (self.from_offset, self.to_offset)
        weight = "" if self.weight == 1.0 else " × %s" % _fmt_num(self.weight)
        return "%s（%s%s）" % (self.node, span, weight)


@dataclass(frozen=True)
class NodeSpec:
    name: str
    kind: str                       # "source" | "sum"
    source: Optional[str]
    inputs: Tuple[InputSpec, ...]
    missing: str                    # "zero" | "error"
    raw: dict
    rule_sig: str

    def rule_description(self) -> str:
        if self.kind == "source":
            return "源节点，读取源「%s」（缺失时按 %s）" % (
                self.source, "0" if self.missing == "zero" else "报错",
            )
        return "汇总节点 = " + " + ".join(inp.describe() for inp in self.inputs)


def _parse_input(obj, index: int, node_name: str) -> InputSpec:
    if not isinstance(obj, dict):
        raise ConfigError("节点「%s」的 inputs[%d] 必须是对象" % (node_name, index))
    unknown = set(obj) - _ALLOWED_INPUT
    if unknown:
        raise ConfigError(
            "节点「%s」的 inputs[%d] 含未知字段：%s"
            % (node_name, index, ", ".join(sorted(unknown)))
        )
    ref = obj.get("node")
    if not isinstance(ref, str) or not ref.strip():
        raise ConfigError("节点「%s」的 inputs[%d] 缺少合法的 node" % (node_name, index))

    has_offset = "offset" in obj
    has_range = "from" in obj or "to" in obj
    if has_offset and has_range:
        raise ConfigError(
            "节点「%s」的 inputs[%d] 不能同时使用 offset 和 from/to" % (node_name, index)
        )
    if not has_offset and not has_range:
        # {"node": X} 简写表示取同一个日期（offset 0）。
        from_kind, from_offset, to_offset = "offset", 0, 0
    elif has_offset:
        offset = _require_int(obj["offset"], "节点「%s」inputs[%d].offset" % (node_name, index))
        if offset > 0:
            raise ConfigError(
                "节点「%s」inputs[%d].offset 不能指向未来日期（应 ≤ 0）" % (node_name, index)
            )
        from_kind, from_offset, to_offset = "offset", offset, offset
    else:
        if "from" not in obj or "to" not in obj:
            raise ConfigError(
                "节点「%s」inputs[%d] 的 from 与 to 必须同时出现" % (node_name, index)
            )
        to_offset = _require_int(obj["to"], "节点「%s」inputs[%d].to" % (node_name, index))
        if to_offset > 0:
            raise ConfigError(
                "节点「%s」inputs[%d].to 不能指向未来日期（应 ≤ 0）" % (node_name, index)
            )
        raw_from = obj["from"]
        if raw_from == START:
            from_kind, from_offset = START, 0
        else:
            from_offset = _require_int(
                raw_from, "节点「%s」inputs[%d].from" % (node_name, index)
            )
            if from_offset > 0:
                raise ConfigError(
                    "节点「%s」inputs[%d].from 不能指向未来日期（应 ≤ 0）"
                    % (node_name, index)
                )
            if from_offset > to_offset:
                raise ConfigError(
                    "节点「%s」inputs[%d] 的 from 必须 ≤ to" % (node_name, index)
                )
            from_kind = "offset"

    weight = _finite_number(
        obj.get("weight", 1.0), "节点「%s」inputs[%d].weight" % (node_name, index)
    )
    return InputSpec(
        node=ref, from_kind=from_kind, from_offset=from_offset, to_offset=to_offset, weight=weight
    )


def _canonical_node(spec: "NodeSpec", inputs: Tuple["InputSpec", ...]) -> dict:
    """用于规则签名的规范化节点描述。

    只保留语义：补齐默认值、把 offset 展开成 from/to、按语义排序输入。
    这样仅调整书写顺序、显式写出默认值，不会被误判成"规则变了"。
    """
    if spec.kind == "source":
        return {"name": spec.name, "type": "source", "source": spec.source,
                "missing": spec.missing}
    canonical_inputs = sorted(
        (
            {
                "node": inp.node,
                "from": START if inp.from_kind == START else inp.from_offset,
                "to": inp.to_offset,
                "weight": inp.weight,
            }
            for inp in inputs
        ),
        key=lambda item: (item["node"], str(item["from"]), item["to"], item["weight"]),
    )
    return {"name": spec.name, "type": "sum", "inputs": canonical_inputs}


def _parse_node(obj, index: int) -> NodeSpec:
    if not isinstance(obj, dict):
        raise ConfigError("nodes[%d] 必须是对象" % index)
    name = obj.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ConfigError("nodes[%d] 缺少合法的 name" % index)
    kind = obj.get("type")
    if kind not in ("source", "sum"):
        raise ConfigError("节点「%s」的 type 必须是 source 或 sum" % name)

    if kind == "source":
        unknown = set(obj) - _ALLOWED_SOURCE
        if unknown:
            raise ConfigError(
                "源节点「%s」含未知字段：%s" % (name, ", ".join(sorted(unknown)))
            )
        source = obj.get("source")
        if not isinstance(source, str) or not source.strip():
            raise ConfigError("源节点「%s」缺少 source（源序列名）" % name)
        missing = obj.get("missing", "zero")
        if missing not in ("zero", "error"):
            raise ConfigError("源节点「%s」的 missing 只能是 zero 或 error" % name)
        inputs: Tuple[InputSpec, ...] = ()
    else:
        unknown = set(obj) - _ALLOWED_SUM
        if unknown:
            raise ConfigError(
                "汇总节点「%s」含未知字段：%s" % (name, ", ".join(sorted(unknown)))
            )
        source = None
        missing = "zero"
        raw_inputs = obj.get("inputs")
        if not isinstance(raw_inputs, list) or not raw_inputs:
            raise ConfigError("汇总节点「%s」至少需要一个 inputs 输入" % name)
        inputs = tuple(_parse_input(item, i, name) for i, item in enumerate(raw_inputs))

    raw = json.loads(json.dumps(obj, ensure_ascii=False))
    spec = NodeSpec(
        name=name, kind=kind, source=source, inputs=inputs, missing=missing,
        raw=raw, rule_sig="",
    )
    rule_sig = _sha256(canonical_json(_canonical_node(spec, inputs)))
    return NodeSpec(
        name=name, kind=kind, source=source, inputs=inputs, missing=missing,
        raw=raw, rule_sig=rule_sig,
    )


@dataclass(frozen=True)
class Config:
    nodes: Dict[str, NodeSpec]
    order: Tuple[str, ...]
    anchor: Optional[dt.date]
    raw: dict
    sig: str
    path: Optional[str]

    def node(self, name: str) -> NodeSpec:
        try:
            return self.nodes[name]
        except KeyError:
            raise ConfigError("未知节点「%s」" % name) from None


def _topological_order(nodes: Dict[str, NodeSpec]) -> Tuple[str, ...]:
    names = list(nodes)
    deps: Dict[str, List[str]] = {name: [] for name in names}
    children: Dict[str, List[str]] = {name: [] for name in names}
    for name in names:
        for inp in nodes[name].inputs:
            if inp.node not in nodes:
                raise ConfigError("节点「%s」引用了不存在的上游节点「%s」" % (name, inp.node))
            deps[name].append(inp.node)
            children[inp.node].append(name)
    indegree = {name: len(deps[name]) for name in names}
    ready = [name for name in names if indegree[name] == 0]
    order: List[str] = []
    while ready:
        name = ready.pop(0)
        order.append(name)
        for child in children[name]:
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
    if len(order) != len(names):
        cyclic = [name for name in names if indegree[name] > 0]
        raise ConfigError("计算节点存在循环依赖，涉及：%s" % ", ".join(cyclic))
    return tuple(order)


def config_from_text(text: str, path: Optional[str] = None) -> Config:
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigError("配置文件不是合法 JSON：%s" % exc) from None
    if not isinstance(obj, dict):
        raise ConfigError("配置文件顶层必须是对象")
    unknown = set(obj) - _ALLOWED_TOP
    if unknown:
        raise ConfigError("配置含未知顶层字段：%s" % ", ".join(sorted(unknown)))

    anchor = None
    if "anchor" in obj:
        anchor = parse_date(obj["anchor"], "anchor")

    raw_nodes = obj.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise ConfigError("配置必须包含非空的 nodes 数组")

    nodes: Dict[str, NodeSpec] = {}
    for index, item in enumerate(raw_nodes):
        spec = _parse_node(item, index)
        if spec.name in nodes:
            raise ConfigError("节点名重复：「%s」" % spec.name)
        nodes[spec.name] = spec

    order = _topological_order(nodes)

    # 配置签名只看语义：节点按名字排序，调整书写顺序不算规则变化。
    sig_payload = {
        "anchor": anchor.isoformat() if anchor else None,
        "nodes": [_canonical_node(nodes[name], nodes[name].inputs) for name in sorted(nodes)],
    }
    sig = _sha256(canonical_json(sig_payload))
    return Config(nodes=nodes, order=order, anchor=anchor, raw=obj, sig=sig, path=path)


def load_config(path: str) -> Config:
    abs_path = os.path.abspath(path)
    try:
        text = read_config_text(abs_path)
    except OSError as exc:
        raise ConfigError("无法读取配置文件 %s：%s" % (path, exc)) from None
    return config_from_text(text, abs_path)


def read_config_text(path: str) -> str:
    with open(os.path.abspath(path), "r", encoding="utf-8") as fh:
        return fh.read()
