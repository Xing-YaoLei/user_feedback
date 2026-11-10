"""Deterministic, repeatable sample inputs for demos and tests.

Five NDJSON batches exercise every semantic distinction the converter must
preserve: missing fields vs explicit nulls, empty arrays vs null-element
arrays, exact decimals with trailing scale, timezone-aware timestamps with
different offsets, integer width promotions, decimal scale changes and an
injectable type conflict. A separate corrupt file contains parse failures.

Decimals are written as raw JSON number tokens (never quoted strings) using a
small exact encoder, so the wire format stays standard JSON while trailing
zeros (``19.90``) survive byte-for-byte.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any


def _encode(value: Any) -> str:
    """JSON encoding that emits Decimal as an exact, unquoted number token."""
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _encode(child)
            for key, child in value.items()
        ) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_encode(item) for item in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    return json.dumps(value, ensure_ascii=False)


def dumps_ndjson(records: list[dict[str, Any]]) -> bytes:
    return b"\n".join(_encode(record).encode("utf-8") for record in records) + b"\n"


@dataclass
class SampleSet:
    dir: str
    files: list[str]
    corrupt_file: str
    contract_file: str


def generate_samples(base_dir: str | Path,
                     *, include_conflict: bool = False) -> SampleSet:
    base = Path(base_dir)
    base.mkdir(parents=True, exist_ok=True)
    files: list[str] = []

    batches = [
        # batch 0: baseline, all semantic distinctions present
        [
            {
                "id": 1,
                "name": "alpha",
                "price": Decimal("19.90"),       # trailing scale preserved
                "tax": Decimal("1.200"),
                "event_time": "2026-11-11T08:00:00+08:00",
                "tags": [],                       # empty array
                "score": None,                    # explicit null
                "meta": {"region": "cn", "ref": None},
            },
            {
                "id": 2,
                # "name" MISSING — distinct from explicit null
                "price": Decimal("8.00"),
                "tax": Decimal("0.050"),
                "event_time": "2026-11-11T00:00:00Z",  # different offset
                "tags": [None, "x"],              # null element + value
                # "score" missing here
                "meta": {"region": "eu"},         # nested null/missing mix
            },
        ],
        # batch 1: integer widening (id grows), decimal scale stable
        [
            {
                "id": 300,
                "name": "gamma",
                "price": Decimal("100.25"),
                "tax": Decimal("7.000"),
                "event_time": "2026-11-11T12:30:45.123456+00:00",
                "tags": ["a", "b", "c"],
                "score": 12,
                "meta": {"region": "us", "ref": "r-9"},
            },
        ],
        # batch 2: decimal precision/scale widening (price gains a digit)
        [
            {
                "id": 40000,
                "name": "delta",
                "price": Decimal("1234.5678"),
                "tax": Decimal("99.99999"),
                "event_time": "2026-11-11T09:00:00-05:00",
                "tags": [],
                "score": None,
                "meta": {"region": "jp", "ref": None},
            },
        ],
        # batch 3: integer grows past int32 -> int64 promotion
        [
            {
                "id": 5_000_000_000,
                "name": "epsilon",
                "price": Decimal("0.1"),
                "tax": Decimal("0.001"),
                "event_time": "2026-11-11T18:45:00+05:30",
                "tags": [None],
                "score": -3,
                "meta": {"region": "in"},
            },
        ],
        # batch 4: optional injected type conflict (string where id is int)
        [
            {
                "id": ("not-an-int" if include_conflict else 99),
                "name": "zeta",
                "price": Decimal("55.55"),
                "tax": Decimal("3.330"),
                "event_time": "2026-11-11T23:59:59Z",
                "tags": ["z"],
                "score": 7,
                "meta": {"region": "kr", "ref": "r-1"},
            },
        ],
    ]

    for index, records in enumerate(batches):
        path = base / f"batch_{index}.ndjson"
        path.write_bytes(dumps_ndjson(records))
        files.append(str(path))

    corrupt = base / "corrupt.ndjson"
    corrupt.write_bytes(
        b'{"id": 700, "name": "ok-before"}\n'
        b'{"id": 701, "name": }\n'               # invalid JSON
        b'not-an-object-at-all\n'                # top-level non-object
        b'{"id": 702, "name": "ok-after"}\n'
    )

    contract_path = base / "contract.json"
    contract_path.write_text(
        json.dumps({
            "merge": {
                "int_to_int": "promote",
                "int_to_decimal": "promote",
                "decimal_widen": "promote",
                "int_to_float": "fail",
                "decimal_to_float": "fail",
                "float_to_decimal": "fail",
                "bool_number": "fail",
                "scalar_string": "fail",
                "string_timestamp": "fail",
                "struct_shape": "fail",
                "new_field_after_first_batch": "fail",
                "timestamp_offset": "promote",
            },
            "default_policy": "fail",
            "timestamp": "utc",
            "type_overrides": {},
            "batch_max_records": 2,
            "max_decimal_precision": 38,
            "use_decimal256": False,
            "allow_naive_datetime": False,
            "naive_datetime_tz": "UTC",
            "presence_column": "__present__",
            "fail_on_error": True,
        }, indent=2),
        encoding="utf-8",
    )

    return SampleSet(
        dir=str(base),
        files=files,
        corrupt_file=str(corrupt),
        contract_file=str(contract_path),
    )
