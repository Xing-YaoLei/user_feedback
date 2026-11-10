"""Conflict contracts, quarantine behaviour and error-record provenance."""

from __future__ import annotations

from io import BytesIO

import pyarrow.parquet as pq
import pytest

from nested2arrow.contract import Contract
from nested2arrow.runner import ConflictError, InputFile, convert


def _run(raw: bytes, contract: Contract, tmp_path):
    return convert(
        [InputFile("<mem>", BytesIO(raw))], tmp_path / "out", contract)


def test_type_conflict_fails_fast_without_data_file(contract, tmp_path):
    raw = (b'{"id":1}\n'
           b'{"id":"oops"}\n')
    with pytest.raises(ConflictError) as exc:
        _run(raw, contract, tmp_path)
    conflict = exc.value.conflicts[0]
    assert conflict["path"] == "$.id"
    assert conflict["policy"] == "fail"
    assert not (tmp_path / "out" / "data.parquet").exists()


def test_quarantine_keeps_good_records_and_bytes(quarantine_contract, tmp_path):
    raw = (b'{"id":1,"v":10}\n'
           b'{"id":2,"v":"string-instead"}\n'
           b'{"id":3,"v":30}\n')
    result = _run(raw, quarantine_contract, tmp_path)

    table = pq.read_table(result.output_parquet)
    # the two good records survived
    assert table.num_rows == 2
    assert result.record_quarantined >= 1
    assert result.error_parquet is not None

    errors = pq.read_table(result.error_parquet).to_pylist()
    conflict_rows = [e for e in errors if e["error_kind"] == "type_conflict"]
    assert conflict_rows
    # raw bytes are preserved for forensics
    assert any(b"string-instead" in e["raw_bytes"] or e["raw_bytes"]
               for e in errors)
    # JSONL sidecar is human readable
    sidecar = tmp_path / "out" / "errors.jsonl"
    assert sidecar.exists()
    assert "$.v" in sidecar.read_text(encoding="utf-8")


def test_parse_errors_keep_original_bytes_and_continue(contract, tmp_path):
    raw = (b'{"id":1}\n'
           b'{"id": }\n'          # malformed
           b'[1,2,3]\n'           # top-level non-object
           b'{"id":4}\n')
    result = _run(raw, contract, tmp_path)
    assert result.record_written == 2
    assert result.parse_errors == 2

    errors = pq.read_table(result.error_parquet).to_pylist()
    kinds = {e["error_kind"] for e in errors}
    assert kinds == {"parse"}
    assert errors[0]["field_path"] == "$"
    # the malformed source line is retained verbatim
    assert b'{"id": }' in errors[0]["raw_bytes"] or \
           any(b'{"id": }' in e["raw_bytes"] for e in errors)


def test_new_field_after_first_batch_is_contract_governed(
        quarantine_contract, tmp_path):
    # batch size 1 so the second record genuinely belongs to a later batch
    quarantine_contract = quarantine_contract.with_overrides(
        batch_max_records=1)
    raw = (b'{"id":1}\n'
           b'{"id":2,"late":"surprise"}\n')
    result = _run(raw, quarantine_contract, tmp_path)
    paths = {e["path"] for e in result.conflict_events}
    assert "$.late" in paths


def test_int_to_float_does_not_silently_happen(contract, tmp_path):
    raw = b'{"x":1}\n{"x":2.5}\n'
    # 2.5 parses as Decimal, so this is an int->decimal *exact* promotion
    result = _run(raw, contract, tmp_path)
    assert not result.conflict_events
    table = pq.read_table(result.output_parquet)
    field = table.schema.field("record").type.field("x")
    import pyarrow as pa
    assert pa.types.is_decimal128(field.type)


def test_decimal_scale_widening_is_recorded(contract, tmp_path):
    raw = b'{"x":1.10}\n{"x":2.5678}\n'
    result = _run(raw, contract, tmp_path)
    paths = {(e["path"], e["action"]) for e in result.merge_events}
    assert ("$.x", "widened") in paths


def test_integer_width_promotion_tracked_per_batch(contract, tmp_path):
    raw = (b'{"id":1}\n'
           b'{"id":300}\n'
           b'{"id":5000000000}\n')
    result = _run(raw, contract, tmp_path)
    promotions = [e for e in result.merge_events if e["path"] == "$.id"]
    assert promotions  # int8 -> int16/32 -> int64 chain observed
    assert promotions[-1]["after"].startswith("int64")


def test_report_html_contains_conflict_locations(quarantine_contract, tmp_path):
    from nested2arrow.report import build_report
    raw = b'{"id":1}\n{"id":"boom"}\n'
    result = _run(raw, quarantine_contract, tmp_path)
    report_path = tmp_path / "out" / "report.html"
    build_report(result, report_path)
    text = report_path.read_text(encoding="utf-8")
    assert "$.id" in text
    assert "conflict" in text.lower()
    assert "quarantine" in text
