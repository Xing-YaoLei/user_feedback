"""Structural type lattice and the explicit merge/promotion matrix.

Every JSON value maps to a :class:`TypeNode`. Two nodes observed on the same
path across batches are combined with :func:`merge`, which never silently
stringifies or truncates: a combination is either an exact/promotable widening
or a *conflict* resolved by the configured :class:`ConflictPolicy`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Union

import pyarrow as pa

from .contract import ConflictPolicy, MergePolicy
from .paths import Path

# ---------------------------------------------------------------------------
# Type nodes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TNull:
    """Only explicit JSON nulls were seen (field presence tracked separately)."""

    kind: str = "null"


@dataclass(frozen=True)
class TBool:
    kind: str = "bool"


@dataclass(frozen=True)
class TInt:
    """Integer family; width is the smallest that fits every observed value."""

    width: int = 64  # 8, 16, 32, 64
    kind: str = "int"


@dataclass(frozen=True)
class TDecimal:
    """Exact decimal; (precision, scale) widen but never narrow."""

    precision: int = 1
    scale: int = 0
    kind: str = "decimal"


@dataclass(frozen=True)
class TFloat:
    width: int = 64  # 32, 64
    kind: str = "float"


@dataclass(frozen=True)
class TString:
    kind: str = "string"


@dataclass(frozen=True)
class TTimestamp:
    """Timezone-aware instant, microsecond resolution, Arrow timestamp[us,tz]."""

    tz: str = "UTC"
    kind: str = "timestamp"


@dataclass(frozen=True)
class TObject:
    # insertion order preserved; field name -> node
    fields: dict[str, "TypeNode"] = field(default_factory=dict)
    kind: str = "object"


@dataclass(frozen=True)
class TArray:
    element: "TypeNode" = field(default_factory=TNull)
    kind: str = "array"


TypeNode = Union[
    TNull, TBool, TInt, TDecimal, TFloat,
    TString, TTimestamp, TObject, TArray,
]

# ---------------------------------------------------------------------------
# Merge outcomes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MergeEvent:
    path: Path
    action: str          # widened | promoted | conflict
    detail: str
    old: TypeNode
    new: TypeNode
    policy: ConflictPolicy

    @property
    def is_conflict(self) -> bool:
        return self.action == "conflict"


@dataclass(frozen=True)
class MergeResult:
    node: TypeNode
    events: tuple[MergeEvent, ...]


_INT_BOUNDS = {
    8: (-(2**7), 2**7 - 1),
    16: (-(2**15), 2**15 - 1),
    32: (-(2**31), 2**31 - 1),
    64: (-(2**63), 2**63 - 1),
}


def int_width_for(value: int) -> int:
    for width in (8, 16, 32, 64):
        lo, hi = _INT_BOUNDS[width]
        if lo <= value <= hi:
            return width
    raise ValueError("integer exceeds signed 64-bit range")


def _widen_int(a: TInt, b: TInt) -> TInt:
    return TInt(width=max(a.width, b.width))


def decimal_for(text: str) -> TDecimal:
    """Infer (precision, scale) from the exact decimal text via Decimal."""
    d = Decimal(text)
    sign, digits, exp = d.as_tuple()
    scale = max(0, -exp)
    precision = max(1, len(digits))
    return TDecimal(precision=precision, scale=scale)


def widen_decimal(a: TDecimal, b: TDecimal) -> TDecimal:
    scale = max(a.scale, b.scale)
    # integer digits each type can represent
    int_a = a.precision - a.scale
    int_b = b.precision - b.scale
    precision = max(int_a, int_b) + scale
    return TDecimal(precision=precision, scale=scale)


def int_to_decimal(node: TInt) -> TDecimal:
    # largest observed magnitude drives precision; scale stays 0
    magnitude = len(str(_INT_BOUNDS[node.width][1]))
    return TDecimal(precision=magnitude, scale=0)


def _conflict(
    path: Path, old: TypeNode, new: TypeNode, policy: ConflictPolicy, why: str
) -> MergeEvent:
    return MergeEvent(
        path=path, action="conflict", detail=why,
        old=old, new=new, policy=policy,
    )


def merge(
    old: TypeNode,
    new: TypeNode,
    path: Path,
    policy: MergePolicy,
    *,
    allow_new_fields: bool,
    precision_ceiling: int,
) -> MergeResult:
    """Combine two nodes observed at ``path`` under the given contract."""

    # null absorbs into anything (explicit nulls are already represented by
    # Arrow nullability); the concrete structural type always wins.
    if isinstance(old, TNull):
        return MergeResult(new, ())
    if isinstance(new, TNull):
        return MergeResult(old, ())
    # int / int -> wider int
    if isinstance(old, TInt) and isinstance(new, TInt):
        widened = _widen_int(old, new)
        if widened == old:
            return MergeResult(old, ())
        return _decide(policy.int_to_int, path, old, new, widened,
                       "integer width promotion")

    # decimal / decimal -> widen precision & scale
    if isinstance(old, TDecimal) and isinstance(new, TDecimal):
        widened = widen_decimal(old, new)
        if widened == old:
            return MergeResult(old, ())
        if widened.precision > precision_ceiling:
            return MergeResult(old, (_conflict(
                path, old, new, policy.decimal_widen,
                f"decimal precision {widened.precision} exceeds ceiling "
                f"{precision_ceiling}",
            ),))
        return _decide(policy.decimal_widen, path, old, new, widened,
                       "decimal precision/scale widening")

    # int <-> decimal: always exact, decimal precision/scale widen
    if isinstance(old, TInt) and isinstance(new, TDecimal):
        widened = widen_decimal(int_to_decimal(old), new)
        return _decide(policy.int_to_decimal, path, old, new, widened,
                       "integer promoted to exact decimal")
    if isinstance(old, TDecimal) and isinstance(new, TInt):
        widened = widen_decimal(old, int_to_decimal(new))
        return _decide(policy.int_to_decimal, path, old, new, widened,
                       "integer promoted to exact decimal")

    # float family
    if isinstance(old, TFloat) and isinstance(new, TFloat):
        return MergeResult(TFloat(width=max(old.width, new.width)), ())
    if isinstance(old, TInt) and isinstance(new, TFloat):
        return _decide(policy.int_to_float, path, old, new, TFloat(),
                       "integer to float loses exactness")
    if isinstance(old, TFloat) and isinstance(new, TInt):
        return _decide(policy.int_to_float, path, old, new, old,
                       "integer mixed into float column")
    if isinstance(old, TDecimal) and isinstance(new, TFloat):
        return _decide(policy.decimal_to_float, path, old, new, TFloat(),
                       "decimal to float loses precision")
    if isinstance(old, TFloat) and isinstance(new, TDecimal):
        return _decide(policy.float_to_decimal, path, old, new,
                       widen_decimal(TDecimal(15, 0), new),
                       "float cannot be represented exactly as decimal")

    # booleans never mix with numbers or strings
    if isinstance(old, TBool) and isinstance(new, TBool):
        return MergeResult(old, ())
    if isinstance(old, TBool) or isinstance(new, TBool):
        return MergeResult(old, (_conflict(
            path, old, new, policy.bool_number,
            "boolean cannot share a path with another scalar type",
        ),))

    # timestamps: same physical type; tz differences are a documented widening
    if isinstance(old, TTimestamp) and isinstance(new, TTimestamp):
        if old.tz == new.tz:
            return MergeResult(old, ())
        return _decide(policy.timestamp_offset, path, old, new,
                       TTimestamp(tz=old.tz),
                       f"timezone offset differs ({old.tz} vs {new.tz}); "
                       "instants are normalized per contract")

    # strings vs other scalars / containers -> hard shape conflict
    if isinstance(old, TString) and isinstance(new, TString):
        return MergeResult(old, ())
    if isinstance(old, TString) or isinstance(new, TString):
        if isinstance(old, TTimestamp) or isinstance(new, TTimestamp):
            return MergeResult(old, (_conflict(
                path, old, new, policy.string_timestamp,
                "timestamp-typed path received a non-timestamp string",
            ),))
        return MergeResult(old, (_conflict(
            path, old, new, policy.scalar_string,
            "string cannot share a path with a non-string type",
        ),))

    # objects: merge field by field; missing fields are normal (nullability),
    # genuinely new fields after batch 0 are governed by the contract.
    if isinstance(old, TObject) and isinstance(new, TObject):
        fields = dict(old.fields)
        events: list[MergeEvent] = []
        for name, node in new.fields.items():
            sub = path + (name,)
            if name not in fields:
                if allow_new_fields:
                    fields[name] = node
                else:
                    events.append(_conflict(
                        sub, TNull(), node,
                        policy.new_field_after_first_batch,
                        "new object field appears after the first batch",
                    ))
                continue
            result = merge(fields[name], node, sub, policy,
                           allow_new_fields=allow_new_fields,
                           precision_ceiling=precision_ceiling)
            fields[name] = result.node
            events.extend(result.events)
        return MergeResult(TObject(fields=fields), tuple(events))

    # arrays: merge element types
    if isinstance(old, TArray) and isinstance(new, TArray):
        result = merge(old.element, new.element, path + ("[*]",), policy,
                       allow_new_fields=allow_new_fields,
                       precision_ceiling=precision_ceiling)
        return MergeResult(TArray(element=result.node), result.events)

    # object <-> array and any remaining container mismatch
    return MergeResult(old, (_conflict(
        path, old, new, policy.struct_shape,
        f"structural shape conflict: {describe(old)} vs {describe(new)}",
    ),))


def _decide(
    rule: ConflictPolicy,
    path: Path,
    old: TypeNode,
    new: TypeNode,
    promoted: TypeNode,
    why: str,
) -> MergeResult:
    event = MergeEvent(
        path=path,
        action="widened" if rule is ConflictPolicy.PROMOTE else "conflict",
        detail=why,
        old=old,
        new=new,
        policy=rule,
    )
    if rule is ConflictPolicy.PROMOTE:
        return MergeResult(promoted, (event,))
    return MergeResult(old, (event,))


# ---------------------------------------------------------------------------
# Rendering and Arrow mapping
# ---------------------------------------------------------------------------


def describe(node: TypeNode) -> str:
    if isinstance(node, TNull):
        return "null"
    if isinstance(node, TBool):
        return "bool"
    if isinstance(node, TInt):
        return f"int{node.width}"
    if isinstance(node, TDecimal):
        return f"decimal({node.precision},{node.scale})"
    if isinstance(node, TFloat):
        return f"float{node.width}"
    if isinstance(node, TString):
        return "string"
    if isinstance(node, TTimestamp):
        return f"timestamp[us,{node.tz}]"
    if isinstance(node, TArray):
        return f"array<{describe(node.element)}>"
    return "object<" + ", ".join(
        f"{k}: {describe(v)}" for k, v in node.fields.items()
    ) + ">"


def to_arrow(node: TypeNode) -> pa.DataType:
    """Map a finalized node to a fully nullable Arrow data type."""
    if isinstance(node, TNull):
        return pa.null()
    if isinstance(node, TBool):
        return pa.bool_()
    if isinstance(node, TInt):
        return {8: pa.int8(), 16: pa.int16(),
                32: pa.int32(), 64: pa.int64()}[node.width]
    if isinstance(node, TDecimal):
        if node.precision <= 38:
            return pa.decimal128(node.precision, node.scale)
        return pa.decimal256(node.precision, node.scale)
    if isinstance(node, TFloat):
        return pa.float32() if node.width == 32 else pa.float64()
    if isinstance(node, TString):
        return pa.string()
    if isinstance(node, TTimestamp):
        return pa.timestamp("us", tz=node.tz)
    if isinstance(node, TArray):
        return pa.list_(pa.field("element", to_arrow(node.element), nullable=True))
    return pa.struct([
        pa.field(name, to_arrow(child), nullable=True)
        for name, child in node.fields.items()
    ])


def schema_tree(node: TypeNode) -> object:
    """JSON-serialisable view for the contract report."""
    if isinstance(node, TObject):
        return {name: schema_tree(child) for name, child in node.fields.items()}
    if isinstance(node, TArray):
        return {"type": "array", "element": schema_tree(node.element)}
    return describe(node)
