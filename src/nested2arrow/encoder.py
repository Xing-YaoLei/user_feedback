"""Second-pass encoding: parsed JSON records -> Arrow record batches.

Each record produces two parallel structures:

* the typed Arrow struct/list/scalar tree (with real Arrow nulls for explicit
  JSON nulls);
* a ``__present__`` list containing every path that physically exists in the
  JSON, including paths whose value is null. Missing keys are simply absent
  from this list, which is what lets the reader distinguish
  *missing* from *explicit null* after round-trip.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timezone
from decimal import Decimal
from typing import Any

import pyarrow as pa

from .contract import Contract
from .inference import parse_timestamp
from .paths import INDEX, Path, render
from .typesystem import (
    TArray, TBool, TDecimal, TFloat, TInt, TNull, TObject, TString,
    TTimestamp, TypeNode, to_arrow,
)


class EncodeError(ValueError):
    def __init__(self, path: Path, message: str):
        super().__init__(f"{render(path)}: {message}")
        self.path = path
        self.message = message


@dataclass
class EncodedRecord:
    value: Any               # python object matching the Arrow struct type
    presence: list[str]      # rendered paths that physically exist


def encode_record(
    record: dict[str, Any], root: TObject, contract: Contract
) -> EncodedRecord:
    presence: list[str] = []
    value = _encode_value(record, root, (), contract, presence)
    return EncodedRecord(value=value, presence=presence)


def _encode_value(value, node: TypeNode, path: Path,
                  contract: Contract, presence: list[str]):
    presence.append(render(path))

    if isinstance(node, TNull):
        if value is not None:
            raise EncodeError(path, "schema says null but value is non-null")
        return None

    if value is None:
        # explicit null inside any nullable node type
        return None

    if isinstance(node, TBool):
        if not isinstance(value, bool):
            raise EncodeError(path, f"expected bool, got {type(value).__name__}")
        return value

    if isinstance(node, TInt):
        if isinstance(value, bool) or not isinstance(value, int):
            raise EncodeError(path, f"expected int, got {type(value).__name__}")
        lo = -(2 ** (node.width - 1))
        hi = 2 ** (node.width - 1) - 1
        if not lo <= value <= hi:
            raise EncodeError(
                path, f"integer {value} does not fit int{node.width}")
        return value

    if isinstance(node, TDecimal):
        if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
            raise EncodeError(path,
                              f"expected exact decimal/int, got {type(value).__name__}")
        decimal_value = Decimal(value) if isinstance(value, int) else value
        if not decimal_value.is_finite():
            raise EncodeError(path, "non-finite decimal")
        # remember the source token so per-value trailing scale is restored on
        # read; the typed column itself keeps the schema-wide uniform scale
        presence[-1] = render(path) + "#d=" + format(decimal_value, "f")
        quantized = decimal_value.scaleb(node.scale)  # shift to stored scale
        if quantized != quantized.to_integral_value():
            raise EncodeError(
                path,
                f"decimal {decimal_value} has more than {node.scale} "
                "fractional digits; precision would be lost",
            )
        if len(quantized.as_tuple().digits) > node.precision:
            raise EncodeError(
                path,
                f"decimal {decimal_value} exceeds decimal({node.precision},"
                f"{node.scale})",
            )
        return decimal_value

    if isinstance(node, TFloat):
        if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
            raise EncodeError(path, f"expected float, got {type(value).__name__}")
        return float(value)

    if isinstance(node, TString):
        if not isinstance(value, str):
            raise EncodeError(path, f"expected string, got {type(value).__name__}")
        return value

    if isinstance(node, TTimestamp):
        if not isinstance(value, str):
            raise EncodeError(path,
                              f"expected ISO-8601 string, got {type(value).__name__}")
        dt = parse_timestamp(value, contract)
        if contract.timestamp.value == "utc":
            return dt.astimezone(timezone.utc)
        return dt

    if isinstance(node, TObject):
        if not isinstance(value, dict):
            raise EncodeError(path, f"expected object, got {type(value).__name__}")
        out: dict[str, Any] = {}
        unknown = set(value) - set(node.fields)
        if unknown:
            raise EncodeError(path, f"undeclared fields: {sorted(unknown)}")
        for name, child in node.fields.items():
            sub = path + (name,)
            if name in value:
                out[name] = _encode_value(value[name], child, sub,
                                          contract, presence)
            # missing key: omit from the struct entirely (Arrow null + absent
            # from presence list) — distinct from an explicit null
        return out

    if isinstance(node, TArray):
        if not isinstance(value, list):
            raise EncodeError(path, f"expected array, got {type(value).__name__}")
        out_list: list[Any] = []
        for index, item in enumerate(value):
            sub = path + (INDEX,)
            # every element slot physically exists, including null elements;
            # an empty list naturally contributes no element paths
            if item is None:
                presence.append(render(sub))
                out_list.append(None)
            else:
                out_list.append(_encode_value(item, node.element, sub,
                                              contract, presence))
        return out_list

    raise EncodeError(path, f"unsupported node {node!r}")


def build_table(
    records: list[EncodedRecord], root: TObject, contract: Contract
) -> pa.Table:
    struct_type = pa.struct([
        pa.field(name, to_arrow(child), nullable=True)
        for name, child in root.fields.items()
    ])
    presence_type = pa.list_(pa.field("path", pa.string(), nullable=False))
    rows = [r.value for r in records]
    presence_rows = [r.presence for r in records]

    struct_array = pa.array(rows, type=struct_type)
    presence_array = pa.array(presence_rows, type=presence_type)
    return pa.table({
        "record": struct_array,
        contract.presence_column: presence_array,
    })
