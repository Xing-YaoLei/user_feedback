"""Two-pass streaming conversion pipeline.

Pass 1 streams bounded batches of raw lines and infers the merged schema,
recording every merge event (integer promotion, decimal widening, conflict)
with its batch id and JSON path. Parse failures are captured with their raw
bytes but do not poison schema inference.

Pass 2 encodes the successfully parsed records against the finalized schema,
writing one Parquet row group per batch; records the contract rejects are
quarantined *with their original bytes* into ``errors.parquet`` /
``errors.jsonl``.

Memory is bounded by ``batch_max_records`` per batch; parsed records are kept
between the two passes so each byte stream is only parsed once.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import pyarrow.parquet as pq

from .contract import ConflictPolicy, Contract
from .encoder import EncodeError, EncodedRecord, build_table, encode_record
from .errors import ErrorRecord, ErrorSink
from .inference import (
    JsonParseError,
    find_precision_violations,
    infer_node,
    merge_into,
    parse_line,
    read_batches,
)
from .paths import render
from .typesystem import TObject, describe, schema_tree, to_arrow


@dataclass
class InputFile:
    path: str
    stream: BinaryIO


@dataclass
class _Parsed:
    raw: bytes
    source: str
    line_number: int
    batch_id: int
    record_index: int
    value: dict | None       # None when parsing failed


@dataclass
class ConversionResult:
    output_parquet: str
    error_parquet: str | None
    error_jsonl: str | None
    record_written: int
    record_quarantined: int
    parse_errors: int
    conflict_events: list[dict]
    merge_events: list[dict]
    batch_snapshots: list[dict]
    final_schema: dict
    arrow_schema: str
    contract: Contract


class ConflictError(RuntimeError):
    def __init__(self, conflicts: list[dict]):
        super().__init__(
            f"{len(conflicts)} unresolvable type conflict(s): "
            + "; ".join(f"{c['path']} ({c['detail']})" for c in conflicts[:5])
        )
        self.conflicts = conflicts


def convert(
    inputs: list[InputFile],
    output_dir: str | Path,
    contract: Contract,
) -> ConversionResult:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_parquet = output_dir / "data.parquet"
    error_parquet = output_dir / "errors.parquet"
    error_jsonl = output_dir / "errors.jsonl"

    error_sink = ErrorSink()
    merge_events: list[dict] = []
    conflict_events: list[dict] = []

    # ------------------------------------------------ pass 1: parse + infer
    parsed_batches: list[list[_Parsed]] = []
    root = TObject()
    batch_id = 0

    for input_file in inputs:
        input_file.stream.seek(0)
        for raw_batch in read_batches(
            input_file.stream, contract.batch_max_records
        ):
            parsed_batch: list[_Parsed] = []
            allow_new_fields = batch_id == 0
            for record_index, raw in enumerate(raw_batch):
                try:
                    value = parse_line(raw)
                except JsonParseError as exc:
                    error_sink.add(ErrorRecord(
                        source=input_file.path,
                        line_number=record_index + 1,
                        batch_id=batch_id,
                        record_index=record_index,
                        error_kind="parse",
                        field_path="$",
                        reason=str(exc),
                        raw_bytes=raw,
                    ))
                    parsed_batch.append(_Parsed(
                        raw, input_file.path, record_index + 1,
                        batch_id, record_index, None,
                    ))
                    continue

                observed = infer_node(value, (), contract)
                result = _merge_root(root, observed, contract, allow_new_fields)
                root = result.node
                for event in result.events:
                    payload = {
                        "batch_id": batch_id,
                        "path": render(event.path),
                        "action": event.action,
                        "detail": event.detail,
                        "policy": event.policy.value,
                        "before": describe(event.old),
                        "after": describe(event.new),
                    }
                    (conflict_events if event.is_conflict
                     else merge_events).append(payload)
                parsed_batch.append(_Parsed(
                    raw, input_file.path, record_index + 1,
                    batch_id, record_index, value,
                ))
            parsed_batches.append(parsed_batch)
            batch_id += 1

    snapshots = _snapshot_schema(parsed_batches, contract)

    # decimal precision ceiling: never let an over-wide value reach Arrow where
    # it would raise an opaque library error — emit a located conflict instead
    for violation_path, decimal_node in find_precision_violations(
            root, (), contract.decimal_precision_ceiling):
        conflict_events.append({
            "batch_id": batch_id - 1,
            "path": render(violation_path),
            "action": "conflict",
            "detail": (
                f"decimal precision {decimal_node.precision} exceeds contract "
                f"ceiling {contract.decimal_precision_ceiling}"),
            "policy": ConflictPolicy.FAIL.value,
            "before": describe(decimal_node),
            "after": describe(decimal_node),
        })

    hard_conflicts = [
        e for e in conflict_events
        if e["policy"] == ConflictPolicy.FAIL.value
    ]
    if hard_conflicts and contract.fail_on_error:
        raise ConflictError(hard_conflicts)

    # ------------------------------------------------ pass 2: encode + write
    writer: pq.ParquetWriter | None = None
    written = 0
    quarantined = 0
    conflicted_paths: set[tuple[int, str]] = {
        (e["batch_id"], e["path"]) for e in conflict_events
    }

    for parsed_batch in parsed_batches:
        encoded: list[EncodedRecord] = []
        current_batch = parsed_batch[0].batch_id if parsed_batch else -1
        for parsed in parsed_batch:
            if parsed.value is None:
                continue  # parse failure already recorded
            try:
                encoded.append(encode_record(parsed.value, root, contract))
            except EncodeError as exc:
                quarantined += 1
                error_sink.add(ErrorRecord(
                    source=parsed.source,
                    line_number=parsed.line_number,
                    batch_id=parsed.batch_id,
                    record_index=parsed.record_index,
                    error_kind="encode",
                    field_path=render(exc.path),
                    reason=exc.message,
                    raw_bytes=parsed.raw,
                ))
        if encoded:
            table = build_table(encoded, root, contract)
            if writer is None:
                writer = pq.ParquetWriter(
                    output_parquet, table.schema, compression="zstd")
            writer.write_table(table)
            written += len(encoded)

        # type-conflict quarantine provenance: keep the first raw record of
        # the batch where the conflict surfaced
        for conflict_batch, conflict_path in sorted(conflicted_paths):
            if conflict_batch != current_batch:
                continue
            raw = parsed_batch[0].raw if parsed_batch else b""
            source = parsed_batch[0].source if parsed_batch else "?"
            event = next(
                e for e in conflict_events
                if e["batch_id"] == conflict_batch and e["path"] == conflict_path
            )
            if event["policy"] == ConflictPolicy.QUARANTINE.value:
                quarantined += 1
                error_sink.add(ErrorRecord(
                    source=source,
                    line_number=-1,
                    batch_id=conflict_batch,
                    record_index=-1,
                    error_kind="type_conflict",
                    field_path=conflict_path,
                    reason=event["detail"],
                    raw_bytes=raw,
                ))

    if writer is not None:
        writer.close()

    err_pq = err_jsonl = None
    if len(error_sink):
        error_sink.write(error_parquet, error_jsonl)
        err_pq, err_jsonl = str(error_parquet), str(error_jsonl)

    return ConversionResult(
        output_parquet=str(output_parquet),
        error_parquet=err_pq,
        error_jsonl=err_jsonl,
        record_written=written,
        record_quarantined=quarantined,
        parse_errors=sum(1 for r in error_sink if r.error_kind == "parse"),
        conflict_events=conflict_events,
        merge_events=merge_events,
        batch_snapshots=snapshots,
        final_schema=schema_tree(root),
        arrow_schema=str(to_arrow(root)),
        contract=contract,
    )


def _merge_root(root: TObject, observed, contract: Contract,
                allow_new_fields: bool):
    return merge_into(root, observed, (), contract,
                      allow_new_fields=allow_new_fields)


def _snapshot_schema(parsed_batches: list[list[_Parsed]],
                     contract: Contract) -> list[dict]:
    """Replay inference per batch to capture the schema after each batch."""
    node = TObject()
    snapshots = []
    for batch_id, parsed_batch in enumerate(parsed_batches):
        for parsed in parsed_batch:
            if parsed.value is None:
                continue
            observed = infer_node(parsed.value, (), contract)
            result = _merge_root(node, observed, contract,
                                 allow_new_fields=(batch_id == 0))
            node = result.node
        snapshots.append({
            "batch_id": batch_id,
            "record_count": sum(1 for p in parsed_batch if p.value is not None),
            "schema": schema_tree(node),
            "summary": describe(node),
        })
    return snapshots
