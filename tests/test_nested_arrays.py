"""Regression: per-element decimal scale and presence inside nested arrays."""

from __future__ import annotations

from decimal import Decimal
from io import BytesIO

from nested2arrow.contract import Contract
from nested2arrow.decoder import decode_table, read_table
from nested2arrow.inference import infer_batches, read_batches
from nested2arrow.runner import InputFile, convert


def test_per_element_decimal_scale_inside_nested_arrays(tmp_path):
    raw = b"\n".join([
        b'{"items":[{"q":1.50,"tags":[{"k":"a","v":null}]},'
        b'{"q":2.00,"tags":[]}],"empty_obj":{}}',
        b'{"items":[],"empty_obj":{"x":1},"only_null":null}',
        b'{"items":[{"q":3.125,"tags":[{"k":"b"}]}]}',
    ]) + b"\n"

    contract = Contract(batch_max_records=2)
    result = convert([InputFile("<m>", BytesIO(raw))],
                     tmp_path / "out", contract)
    inference = infer_batches(
        read_batches(BytesIO(raw), contract.batch_max_records), contract)
    back = decode_table(read_table(result.output_parquet),
                        inference.root, contract)

    # each array element keeps its own source decimal scale
    assert back[0]["items"][0]["q"] == Decimal("1.50")
    assert back[0]["items"][1]["q"] == Decimal("2.00")
    assert back[2]["items"][0]["q"] == Decimal("3.125")

    # empty array, empty object, explicit null and missing field
    assert back[0]["items"][1]["tags"] == []
    assert back[0]["empty_obj"] == {}
    assert back[1]["items"] == []
    assert back[1]["only_null"] is None
    assert "only_null" not in back[0]
    assert back[1]["empty_obj"] == {"x": 1}

    # null element inside a nested array of structs
    assert back[0]["items"][0]["tags"][0]["v"] is None


def test_root_path_appears_exactly_once_in_presence(tmp_path):
    contract = Contract()
    raw = b'{"a":1,"b":[1,2,3]}\n'
    result = convert([InputFile("<m>", BytesIO(raw))],
                     tmp_path / "out", contract)
    table = read_table(result.output_parquet)
    presence = table.to_pylist()[0]["__present__"]
    assert presence.count("$") == 1


def test_all_null_column_roundtrips_and_distinct_from_missing(tmp_path):
    contract = Contract()
    raw = b'{"x":null,"y":1}\n{"y":2}\n'
    result = convert([InputFile("<m>", BytesIO(raw))],
                     tmp_path / "out", contract)
    inference = infer_batches(
        read_batches(BytesIO(raw), contract.batch_max_records), contract)
    back = decode_table(read_table(result.output_parquet),
                        inference.root, contract)

    # explicit null in row 1 ...
    assert "x" in back[0] and back[0]["x"] is None
    # ... vs genuinely missing field in row 2
    assert "x" not in back[1]
    assert back[0]["y"] == 1 and back[1]["y"] == 2
