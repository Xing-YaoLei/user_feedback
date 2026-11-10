"""Round-trip decoder: Arrow/Parquet -> the original nested Python structure.

Reconstruction is driven by the ``__present__`` auxiliary column: a key is
emitted only if its path is in the presence set, so field *absence* is
restored rather than materialised as ``null``. Explicit nulls, empty arrays
and null array elements are all represented distinctly inside Arrow itself
and come back unchanged.

Decimal entries carry a ``#d=<source token>`` suffix in the presence list so
that per-value trailing scale (``1.20`` vs ``1.2``) is restored even though
the typed Arrow column stores one schema-wide scale.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .contract import Contract
from .paths import INDEX, Path, render
from .typesystem import (
    TArray, TBool, TDecimal, TFloat, TInt, TNull, TObject, TString,
    TTimestamp, TypeNode,
)

_DECIMAL_SUFFIX = "#d="


class _PresenceIndex:
    """Maps each structural path to presence + per-occurrence decimal tokens.

    Array elements render to the same path (``$.items[*].q``), so decimal
    tokens are kept in an ordered queue consumed one per decoded occurrence,
    mirroring the order in which the encoder walked the array.
    """

    def __init__(self, entries: list[str]):
        self._present: set[str] = set()
        self._tokens: dict[str, list[str]] = defaultdict(list)
        for entry in entries:
            if _DECIMAL_SUFFIX in entry:
                path, token = entry.split(_DECIMAL_SUFFIX, 1)
                self._present.add(path)
                self._tokens[path].append(token)
            else:
                self._present.add(entry)
        self._cursor: dict[str, int] = defaultdict(int)

    def exists(self, path: str) -> bool:
        return path in self._present

    def next_token(self, path: str) -> str | None:
        queue = self._tokens.get(path)
        if not queue:
            return None
        index = self._cursor[path]
        self._cursor[path] = index + 1
        return queue[index] if index < len(queue) else None


def read_table(source: str | pa.Table) -> pa.Table:
    if isinstance(source, pa.Table):
        return source
    return pq.read_table(source)


def decode_table(table: pa.Table, root: TObject,
                 contract: Contract) -> list[dict[str, Any]]:
    rows = table.to_pylist()
    out: list[dict[str, Any]] = []
    for row in rows:
        present = _PresenceIndex(row[contract.presence_column])
        record = row["record"]
        if record is None:
            out.append({})
            continue
        out.append(_decode_object(record, root, (), present, contract))
    return out


def _decode_object(value: dict[str, Any], node: TObject, path: Path,
                   present: _PresenceIndex,
                   contract: Contract) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, child in node.fields.items():
        sub = path + (name,)
        if not present.exists(render(sub)):
            continue  # field was missing in the source JSON
        result[name] = _decode(value[name], child, sub, present, contract)
    return result


def _decode(value: Any, node: TypeNode, path: Path,
            present: _PresenceIndex, contract: Contract) -> Any:
    if isinstance(node, TNull):
        return None

    if value is None:
        return None  # explicit JSON null

    if isinstance(node, (TBool, TInt, TFloat, TString)):
        return value

    if isinstance(node, TDecimal):
        token = present.next_token(render(path))
        if token is not None:
            return Decimal(token)  # exact source scale restored
        if isinstance(value, Decimal):
            return value
        return Decimal(str(value))

    if isinstance(node, TTimestamp):
        assert isinstance(value, datetime)
        return _format_timestamp(value, contract)

    if isinstance(node, TObject):
        return _decode_object(value, node, path, present, contract)

    if isinstance(node, TArray):
        return _decode_array(value, node, path, present, contract)

    raise TypeError(f"cannot decode node {node!r}")


def _decode_array(values: list[Any], node: TArray, path: Path,
                  present: _PresenceIndex,
                  contract: Contract) -> list[Any]:
    element_path = path + (INDEX,)
    result: list[Any] = []
    for item in values:
        if item is None:
            result.append(None)  # explicit null element
        else:
            result.append(_decode(item, node.element, element_path,
                                  present, contract))
    return result


def _format_timestamp(dt: datetime, contract: Contract) -> str:
    if contract.timestamp.value == "utc":
        dt = dt.astimezone(dt.tzinfo)
        # render with explicit UTC offset
        text = dt.isoformat()
        return text.replace("+00:00", "Z") if text.endswith("+00:00") else text
    return dt.isoformat()
