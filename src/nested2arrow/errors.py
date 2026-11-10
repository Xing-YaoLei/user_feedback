"""Error records with original bytes and field-path provenance.

Quarantined / failed rows never disappear silently. Every rejected record is
persisted with its *raw source bytes* (so nothing is lost and the failure is
reproducible), the exact structural path where the problem occurred, the
batch and line position, and a machine-readable reason. Outputs are Parquet
(the canonical store) plus a JSONL sidecar for human inspection.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


@dataclass(frozen=True)
class ErrorRecord:
    source: str
    line_number: int          # 1-based line in the source NDJSON
    batch_id: int
    record_index: int         # index inside the batch
    error_kind: str           # parse | type_conflict | encode
    field_path: str           # JSONPath, "$" for whole-record parse errors
    reason: str
    raw_bytes: bytes


_ERROR_SCHEMA = pa.schema([
    pa.field("source", pa.string(), nullable=False),
    pa.field("line_number", pa.int64(), nullable=False),
    pa.field("batch_id", pa.int64(), nullable=False),
    pa.field("record_index", pa.int64(), nullable=False),
    pa.field("error_kind", pa.string(), nullable=False),
    pa.field("field_path", pa.string(), nullable=False),
    pa.field("reason", pa.string(), nullable=False),
    pa.field("raw_bytes", pa.binary(), nullable=False),
])


class ErrorSink:
    def __init__(self) -> None:
        self._records: list[ErrorRecord] = []

    def add(self, record: ErrorRecord) -> None:
        self._records.append(record)

    def __len__(self) -> int:
        return len(self._records)

    def __iter__(self):
        return iter(self._records)

    def write(self, parquet_path: str | Path,
              jsonl_path: str | Path | None = None) -> None:
        if not self._records:
            return
        table = pa.table({
            "source": [r.source for r in self._records],
            "line_number": [r.line_number for r in self._records],
            "batch_id": [r.batch_id for r in self._records],
            "record_index": [r.record_index for r in self._records],
            "error_kind": [r.error_kind for r in self._records],
            "field_path": [r.field_path for r in self._records],
            "reason": [r.reason for r in self._records],
            "raw_bytes": [r.raw_bytes for r in self._records],
        }, schema=_ERROR_SCHEMA)
        pq.write_table(table, parquet_path, compression="zstd")

        if jsonl_path is not None:
            with open(jsonl_path, "w", encoding="utf-8") as fh:
                for record in self._records:
                    payload = asdict(record)
                    payload["raw_text"] = _safe_decode(record.raw_bytes)
                    payload.pop("raw_bytes")
                    fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _safe_decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")
