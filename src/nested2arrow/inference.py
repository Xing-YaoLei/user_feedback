"""Streaming NDJSON reading and first-pass type inference.

JSON is parsed with ``parse_float=Decimal`` / ``parse_int=int`` so numeric
text keeps its exact scale (``1.20`` stays a two-scale decimal and is never
rounded through a binary float).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, BinaryIO, Iterator

from .contract import Contract
from .paths import INDEX, Path, render
from .typesystem import (
    TArray, TBool, TDecimal, TFloat, TInt, TNull, TObject, TString,
    TTimestamp, TypeNode, decimal_for, int_width_for, merge,
)

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


class JsonParseError(ValueError):
    """Raised when one NDJSON line is not a valid JSON object."""


def parse_line(raw: bytes) -> dict[str, Any]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise JsonParseError(f"invalid utf-8: {exc}") from exc
    try:
        value = json.loads(text, parse_float=Decimal, parse_int=int)
    except json.JSONDecodeError as exc:
        raise JsonParseError(f"invalid json: {exc.msg} at line col {exc.colno}") from exc
    if not isinstance(value, dict):
        raise JsonParseError("top-level JSON value must be an object")
    return value


# ---------------------------------------------------------------------------
# Timestamp recognition
# ---------------------------------------------------------------------------

_ISO_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}"
    r"(?:\.\d{1,9})?"
    r"(?:Z|[+-]\d{2}:?\d{2})?$"
)


def parse_timestamp(text: str, contract: Contract) -> datetime:
    if not _ISO_RE.match(text):
        raise ValueError("not an ISO-8601 timestamp")
    normalized = text.replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        if not contract.allow_naive_datetime:
            raise ValueError("naive datetime (no timezone offset) rejected by contract")
        from zoneinfo import ZoneInfo
        dt = dt.replace(tzinfo=ZoneInfo(contract.naive_datetime_tz))
    # Arrow timestamp[us] resolution; fail loudly rather than silently truncate
    if _has_nanoseconds(text):
        raise ValueError("nanosecond precision exceeds timestamp[us] resolution")
    return dt


def _has_nanoseconds(text: str) -> bool:
    match = re.search(r"\.(\d+)", text)
    return bool(match and len(match.group(1)) > 6)

# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------


@dataclass
class BatchSnapshot:
    batch_id: int
    node: TypeNode
    record_count: int


@dataclass
class InferenceResult:
    root: TObject
    snapshots: list[BatchSnapshot]
    record_count: int
    batch_count: int


def infer_scalar(value: Any, path: Path, contract: Contract) -> TypeNode:
    override = contract.type_overrides.get(render(path))
    if override is not None:
        node = _override_node(override, path)
        # overrides still validate the value instead of blindly trusting it
        if isinstance(node, TTimestamp) and isinstance(value, str):
            parse_timestamp(value, contract)
        return node

    if value is None:
        return TNull()
    if isinstance(value, bool):
        return TBool()
    if isinstance(value, int):
        return TInt(width=int_width_for(value))
    if isinstance(value, Decimal):
        if not _is_finite_decimal(value):
            raise ValueError("non-finite decimal")
        return decimal_for(format(value, "f"))
    if isinstance(value, float):
        # Only reachable via explicit override; plain JSON floats parse as Decimal.
        return TFloat()
    if isinstance(value, str):
        if _ISO_RE.match(value):
            try:
                parse_timestamp(value, contract)
            except ValueError as exc:
                # A naive ISO string under the default contract is stored as a
                # plain string rather than assumed UTC. Genuine resolution
                # problems (e.g. nanoseconds) still surface as hard errors.
                if "naive datetime" in str(exc):
                    return TString()
                raise
            return TTimestamp()
        return TString()
    raise TypeError(f"unsupported scalar at {render(path)}: {type(value).__name__}")


def _override_node(name: str, path: Path) -> TypeNode:
    if name == "bool":
        return TBool()
    if name == "int":
        return TInt(64)
    if name == "decimal":
        return TDecimal(38, 18)
    if name == "float":
        return TFloat()
    if name == "string":
        return TString()
    if name == "timestamp":
        return TTimestamp()
    if name == "json":
        # Stored as canonical JSON text; round-trip still restores structure.
        return TString()
    raise ValueError(f"unknown type override {name!r} at {render(path)}")


def _is_finite_decimal(d: Decimal) -> bool:
    return d.is_finite()


def infer_node(value: Any, path: Path, contract: Contract) -> TypeNode:
    if value is None:
        return TNull()
    if isinstance(value, dict):
        fields = {
            key: infer_node(child, path + (key,), contract)
            for key, child in value.items()
        }
        return TObject(fields=fields)
    if isinstance(value, list):
        element = TNull()
        for item in value:
            item_node = infer_node(item, path + (INDEX,), contract)
            result = merge(element, item_node, path + (INDEX,), contract.merge,
                           allow_new_fields=True,
                           precision_ceiling=contract.decimal_precision_ceiling)
            element = result.node
        return TArray(element=element)
    return infer_scalar(value, path, contract)


def merge_into(
    current: TypeNode,
    observed: TypeNode,
    path: Path,
    contract: Contract,
    *,
    allow_new_fields: bool,
):
    return merge(current, observed, path, contract.merge,
                 allow_new_fields=allow_new_fields,
                 precision_ceiling=contract.decimal_precision_ceiling)


def infer_batches(
    batches: Iterator[list[bytes]],
    contract: Contract,
) -> InferenceResult:
    """Consume raw batches and produce the merged schema plus per-batch snapshots."""
    root = TObject()
    snapshots: list[BatchSnapshot] = []
    total = 0
    batch_id = 0

    for raw_batch in batches:
        batch_node = TObject()
        for raw in raw_batch:
            record = parse_line(raw)
            observed = infer_node(record, (), contract)
            result = merge_into(batch_node, observed, (), contract,
                                allow_new_fields=True)
            batch_node = result.node  # type: ignore[assignment]
        # merge the batch's own view into the global schema:
        # fields appearing after batch 0 are contract-governed.
        result = merge_into(root, batch_node, (), contract,
                            allow_new_fields=(batch_id == 0))
        root = result.node  # type: ignore[assignment]
        total += len(raw_batch)
        snapshots.append(BatchSnapshot(batch_id, root, len(raw_batch)))
        batch_id += 1

    return InferenceResult(root=root, snapshots=snapshots,
                           record_count=total, batch_count=batch_id)


def find_precision_violations(node: TypeNode, path: Path,
                              ceiling: int) -> list[tuple[Path, TDecimal]]:
    """Return every decimal node whose precision exceeds the contract ceiling."""
    violations: list[tuple[Path, TDecimal]] = []
    if isinstance(node, TDecimal) and node.precision > ceiling:
        violations.append((path, node))
    elif isinstance(node, TObject):
        for name, child in node.fields.items():
            violations.extend(
                find_precision_violations(child, path + (name,), ceiling))
    elif isinstance(node, TArray):
        violations.extend(
            find_precision_violations(node.element, path + (INDEX,), ceiling))
    return violations


def read_batches(
    stream: BinaryIO, batch_size: int
) -> Iterator[list[bytes]]:
    """Yield bounded raw-line batches from an NDJSON byte stream."""
    batch: list[bytes] = []
    for line in stream:
        raw = line.rstrip(b"\r\n")
        if not raw:
            continue
        batch.append(raw)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch
