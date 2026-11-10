"""Round-trip semantics: missing vs null vs empty array vs null elements.

These tests assert the *meaning* of the data after Parquet round-trip, not
just that a file was produced.
"""

from __future__ import annotations

from decimal import Decimal
from io import BytesIO

import pyarrow as pa
import pytest

from nested2arrow.contract import Contract
from nested2arrow.decoder import decode_table, read_table
from nested2arrow.inference import infer_batches, read_batches
from nested2arrow.runner import InputFile, convert
from nested2arrow.verify import verify_roundtrip


def _infer_root(raw: bytes, contract: Contract):
    inference = infer_batches(
        read_batches(BytesIO(raw), contract.batch_max_records), contract)
    return inference.root


def _roundtrip(raw: bytes, contract: Contract, tmp_path=None):
    root = _infer_root(raw, contract)
    out_dir = str(tmp_path) if tmp_path is not None else _tmpdir()
    result = convert(
        [InputFile("<mem>", BytesIO(raw))], out_dir, contract)
    table = read_table(result.output_parquet)
    records = decode_table(table, root, contract)
    return root, table, records, result


def _tmpdir() -> str:
    import tempfile
    return tempfile.mkdtemp(prefix="n2a-")


RECORDS = b"\n".join([
    rb'{"id":1,"missing_later":5,"explicit_null":null,"arr_empty":[],'
    rb'"arr_nulls":[null,null],"arr_mixed":[1,null,3],"nested":{"a":null}}',
    rb'{"id":2,"explicit_null":"x","arr_empty":[],"arr_nulls":[null],'
    rb'"arr_mixed":[4],"nested":{}}',
    rb'{"id":3,"explicit_null":null,"arr_empty":[],"arr_nulls":[],'
    rb'"arr_mixed":[],"nested":{"a":7},"extra_after_batch0":true}',
]) + b"\n"


def test_missing_field_distinct_from_explicit_null(contract):
    root, table, records, _ = _roundtrip(RECORDS, contract)

    first, second, third = records
    # explicit null comes back as None ...
    assert first["explicit_null"] is None
    # ... while a field absent from the source is genuinely absent
    assert "missing_later" not in second
    assert "missing_later" not in third
    # nested missing vs explicit null
    assert first["nested"]["a"] is None
    assert "a" not in second["nested"]


def test_presence_column_encodes_exact_distinction(contract):
    root, table, records, _ = _roundtrip(RECORDS, contract)
    presence = [set(row["__present__"]) for row in table.to_pylist()]

    assert "$.explicit_null" in presence[0]          # explicit null present
    assert "$.missing_later" not in presence[1]      # missing key absent
    assert "$.nested.a" in presence[0]
    assert "$.nested.a" not in presence[1]


def test_empty_array_vs_null_element_array(contract):
    root, table, records, _ = _roundtrip(RECORDS, contract)
    first = records[0]

    assert first["arr_empty"] == []                  # empty stays empty
    assert first["arr_nulls"] == [None, None]        # null elements survive
    assert first["arr_mixed"] == [1, None, 3]
    # Arrow-level proof: list child has real nulls, empty list has zero length
    arrow_rows = table.to_pylist()
    assert arrow_rows[0]["record"]["arr_nulls"] == [None, None]
    assert arrow_rows[0]["record"]["arr_empty"] == []

    # and the Arrow null count on the list child is non-zero
    list_type = _find_list(table.schema, "record.arr_nulls")
    assert pa.types.is_list(list_type)


def _find_list(schema, suffix):
    def walk(dtype, prefix):
        import pyarrow.types as types
        if types.is_list(dtype):
            yield prefix, dtype
            yield from walk(dtype.value_type, prefix + "[]")
        elif types.is_struct(dtype):
            for fld in dtype:
                yield from walk(fld.type, prefix + "." + fld.name)
    for name, dtype in walk(schema.field("record").type, "record"):
        if name == suffix:
            return dtype
    raise KeyError(suffix)


def test_exact_decimal_keeps_scale_and_value(contract):
    raw = (b'{"price":19.90}\n{"price":0.0050}\n{"price":1234.5678}\n')
    root, table, records, _ = _roundtrip(raw, contract)

    assert records[0]["price"] == Decimal("19.90")
    assert records[1]["price"] == Decimal("0.0050")
    # trailing scale is part of the Arrow decimal type
    price_type = root.fields["price"]
    assert isinstance(price_type, type(root.fields["price"]))
    assert price_type.scale == 4
    arrow_field = table.schema.field("record").type.field("price")
    assert pa.types.is_decimal128(arrow_field.type)
    assert arrow_field.type.scale == 4


def test_decimal_is_never_stringified(contract):
    raw = b'{"price":19.90}\n{"price":1.5}\n'
    root, table, records, _ = _roundtrip(raw, contract)
    assert isinstance(records[0]["price"], Decimal)
    arrow_field = table.schema.field("record").type.field("price")
    assert pa.types.is_decimal128(arrow_field.type)


def test_timestamp_preserves_instant_across_offsets(contract):
    raw = (b'{"t":"2026-11-11T08:00:00+08:00"}\n'
           b'{"t":"2026-11-11T00:00:00Z"}\n')
    root, table, records, _ = _roundtrip(raw, contract)
    # same instant, normalized to UTC on the wire type
    t0 = table.to_pylist()[0]["record"]["t"]
    t1 = table.to_pylist()[1]["record"]["t"]
    assert t0 == t1
    assert t0.tzinfo is not None
    arrow_field = table.schema.field("record").type.field("t")
    assert pa.types.is_timestamp(arrow_field.type)
    assert arrow_field.type.unit == "us"
    # reconstructed ISO text keeps an explicit offset
    assert records[0]["t"].endswith("Z")
    assert records[1]["t"].endswith("Z")


def test_naive_datetime_falls_back_to_string_but_never_fails(contract):
    # Without an explicit timestamp type override, an ISO string lacking an
    # offset is not recognized as a timestamp: it is stored verbatim as a
    # string rather than being assumed UTC. With an override it is rejected.
    raw = b'{"t":"2026-11-11T08:00:00"}\n'
    root, table, records, _ = _roundtrip(raw, contract)
    assert records[0]["t"] == "2026-11-11T08:00:00"

    import pyarrow as pa
    field = table.schema.field("record").type.field("t")
    assert pa.types.is_string(field.type)

    overridden = Contract(type_overrides={"$.t": "timestamp"})
    # an explicit timestamp override makes the missing offset a hard error
    from nested2arrow.inference import infer_scalar, parse_timestamp
    with pytest.raises(ValueError):
        infer_scalar("2026-11-11T08:00:00", ("t",), overridden)

    # the contract can instead accept naive timestamps in a declared zone
    permissive = Contract(
        type_overrides={"$.t": "timestamp"}, allow_naive_datetime=True)
    node = infer_scalar("2026-11-11T08:00:00", ("t",), permissive)
    import pyarrow as pa
    assert pa.types.is_timestamp(
        __import__("nested2arrow.typesystem", fromlist=["to_arrow"])
        .to_arrow(node))
    dt = parse_timestamp("2026-11-11T08:00:00", permissive)
    assert dt.tzinfo is not None


def test_full_verifier_passes_on_semantic_fixture(contract, tmp_path):
    out = tmp_path / "out"
    result = convert([InputFile("<mem>", BytesIO(RECORDS))], out, contract)
    raw_lines = [line for line in RECORDS.splitlines() if line]
    root = _infer_root(RECORDS, contract)
    report = verify_roundtrip(raw_lines, result.output_parquet, root, contract)
    assert report.ok, report.failures
    assert report.records_checked == 3
