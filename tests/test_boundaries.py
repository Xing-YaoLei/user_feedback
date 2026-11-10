"""Boundary conditions: overflow, precision ceilings, Arrow null counts."""

from __future__ import annotations

from decimal import Decimal
from io import BytesIO

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from nested2arrow.contract import Contract
from nested2arrow.decoder import decode_table
from nested2arrow.encoder import EncodeError, encode_record
from nested2arrow.inference import infer_batches, read_batches
from nested2arrow.runner import ConflictError, InputFile, convert


def _tmp(tmp_path):
    return tmp_path / "out"


def test_integer_overflow_int64_is_a_conflict_not_wraparound(contract, tmp_path):
    raw = b'{"x":99999999999999999999}\n'  # beyond int64
    with pytest.raises((ConflictError, ValueError, OverflowError)):
        convert([InputFile("<m>", BytesIO(raw))], _tmp(tmp_path), contract)


def test_decimal_precision_ceiling_blocks_silent_truncation(contract, tmp_path):
    # 40 significant digits exceeds the decimal128 ceiling of 38
    raw = b'{"x":1234567890123456789012345678901234567890.12}\n'
    with pytest.raises(ConflictError) as exc:
        convert([InputFile("<m>", BytesIO(raw))], _tmp(tmp_path), contract)
    assert any("ceiling" in c["detail"] or "precision" in c["detail"]
               for c in exc.value.conflicts)


def test_decimal256_raises_the_ceiling_when_enabled(tmp_path):
    contract = Contract(use_decimal256=True, max_decimal_precision=76)
    raw = b'{"x":1234567890123456789012345678901234567890.12}\n'
    result = convert([InputFile("<m>", BytesIO(raw))],
                     tmp_path / "out256", contract)
    table = pq.read_table(result.output_parquet)
    field = table.schema.field("record").type.field("x")
    assert pa.types.is_decimal256(field.type)


def test_encode_rejects_value_exceeding_declared_decimal(contract):
    from nested2arrow.typesystem import TDecimal, TObject
    root = TObject(fields={"x": TDecimal(precision=5, scale=2)})
    with pytest.raises(EncodeError) as exc:
        encode_record({"x": Decimal("12345.67")}, root, contract)
    assert "exceeds" in exc.value.message


def test_encode_rejects_scale_that_would_lose_digits(contract):
    from nested2arrow.typesystem import TDecimal, TObject
    root = TObject(fields={"x": TDecimal(precision=6, scale=2)})
    with pytest.raises(EncodeError) as exc:
        encode_record({"x": Decimal("1.234")}, root, contract)
    assert "fractional digits" in exc.value.message


def test_arrow_null_count_distinguishes_null_elements_from_empty_list(
        contract, tmp_path):
    raw = (b'{"a":[],"b":[null,null]}\n'
           b'{"a":[1],"b":[null,2]}\n')
    result = convert([InputFile("<m>", BytesIO(raw))],
                     _tmp(tmp_path), contract)
    table = pq.read_table(result.output_parquet)
    record_type = table.schema.field("record").type
    b_type = record_type.field("b").type
    assert pa.types.is_list(b_type)

    # flatten the list child and count real Arrow nulls
    child = table.column("record").combine_chunks().field("b").values
    assert child.null_count == 3  # two from row 1, one from row 2

    a_child = table.column("record").combine_chunks().field("a").values
    assert a_child.null_count == 0  # empty lists contribute no nulls


def test_explicit_null_field_is_nullable_arrow_column(contract, tmp_path):
    raw = b'{"x":null}\n{"x":5}\n'
    result = convert([InputFile("<m>", BytesIO(raw))],
                     _tmp(tmp_path), contract)
    table = pq.read_table(result.output_parquet)
    field = table.schema.field("record").type.field("x")
    assert field.nullable
    col = table.column("record").combine_chunks().field("x")
    assert col.null_count == 1


def test_presence_survives_multiple_input_files(contract, tmp_path):
    a = tmp_path / "a.ndjson"
    b = tmp_path / "b.ndjson"
    a.write_bytes(b'{"id":1,"only_in_a":true}\n')
    b.write_bytes(b'{"id":2}\n')
    result = convert(
        [InputFile(str(a), a.open("rb")),
         InputFile(str(b), b.open("rb"))],
        _tmp(tmp_path), contract)
    table = pq.read_table(result.output_parquet)
    rows = table.to_pylist()
    assert "$.only_in_a" in set(rows[0]["__present__"])
    assert "$.only_in_a" not in set(rows[1]["__present__"])

    inference = infer_batches(
        read_batches(BytesIO(a.read_bytes() + b.read_bytes()),
                     contract.batch_max_records),
        contract)
    decoded = decode_table(table, inference.root, contract)
    assert "only_in_a" in decoded[0]
    assert "only_in_a" not in decoded[1]


def test_nanosecond_timestamp_is_rejected_not_truncated(contract, tmp_path):
    raw = b'{"t":"2026-11-11T00:00:00.123456789Z"}\n'
    with pytest.raises((ConflictError, ValueError)):
        convert([InputFile("<m>", BytesIO(raw))], _tmp(tmp_path), contract)


def test_microsecond_timestamp_is_accepted(contract, tmp_path):
    raw = b'{"t":"2026-11-11T00:00:00.123456Z"}\n'
    result = convert([InputFile("<m>", BytesIO(raw))],
                     _tmp(tmp_path), contract)
    assert result.record_written == 1
