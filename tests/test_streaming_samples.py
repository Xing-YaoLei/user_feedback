"""Streaming batching, Parquet row groups and end-to-end sample tests."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from nested2arrow.contract import Contract
from nested2arrow.runner import ConflictError, InputFile, convert
from nested2arrow.samples import generate_samples
from nested2arrow.verify import verify_roundtrip


def test_batching_produces_one_row_group_per_batch(tmp_path):
    contract = Contract(batch_max_records=2)
    raw = b"".join(b'{"id":%d}\n' % i for i in range(7))
    result = convert(
        [InputFile("<mem>", BytesIO(raw))], tmp_path / "out", contract)
    parquet_file = pq.ParquetFile(result.output_parquet)
    assert parquet_file.num_row_groups == 4  # ceil(7 / 2)
    assert parquet_file.read().num_rows == 7


def test_multiple_input_files_share_one_schema(tmp_path):
    contract = Contract(batch_max_records=10)
    a = tmp_path / "a.ndjson"
    b = tmp_path / "b.ndjson"
    a.write_bytes(b'{"id":1,"name":"x"}\n')
    b.write_bytes(b'{"id":2}\n')  # missing name
    result = convert(
        [InputFile(str(a), a.open("rb")),
         InputFile(str(b), b.open("rb"))],
        tmp_path / "out", contract)
    table = pq.read_table(result.output_parquet)
    assert table.num_rows == 2
    rows = table.to_pylist()
    assert rows[1]["record"].get("name") is None
    assert "$.name" not in set(rows[1]["__present__"])


def test_sample_generation_is_deterministic(tmp_path):
    first = generate_samples(tmp_path / "s1")
    second = generate_samples(tmp_path / "s2")
    for f, s in zip(first.files, second.files):
        assert Path(f).read_bytes() == Path(s).read_bytes()


def test_end_to_end_samples_verify_semantics(tmp_path):
    sample = generate_samples(tmp_path / "samples")
    contract = Contract.load(sample.contract_file)
    streams = [InputFile(p, open(p, "rb")) for p in sample.files]
    result = convert(streams, tmp_path / "out", contract)

    assert result.record_written == 6
    # promotions/widenings were observed and documented
    paths = {e["path"] for e in result.merge_events}
    assert "$.id" in paths
    assert "$.price" in paths

    raw_records: list[bytes] = []
    for path in sample.files:
        raw_records.extend(
            line for line in Path(path).read_bytes().splitlines() if line)

    from nested2arrow.inference import infer_batches, read_batches
    inference = infer_batches(
        read_batches(BytesIO(b"\n".join(raw_records)),
                     contract.batch_max_records),
        contract,
    )
    report = verify_roundtrip(
        raw_records, result.output_parquet, inference.root, contract)
    assert report.ok, [f.message for f in report.failures]


def test_corrupt_sample_is_quarantined_with_bytes(tmp_path):
    sample = generate_samples(tmp_path / "samples")
    contract = Contract.load(sample.contract_file)
    result = convert(
        [InputFile(sample.corrupt_file, open(sample.corrupt_file, "rb"))],
        tmp_path / "out", contract)
    # two malformed lines, two good lines (700 before, 702 after)
    assert result.record_written == 2
    assert result.parse_errors == 2
    errors = pq.read_table(result.error_parquet).to_pylist()
    assert all(e["raw_bytes"] for e in errors)


def test_conflict_sample_aborts_under_fail_contract(tmp_path):
    sample = generate_samples(tmp_path / "samples", include_conflict=True)
    contract = Contract.load(sample.contract_file)
    streams = [InputFile(p, open(p, "rb")) for p in sample.files]
    with pytest.raises(ConflictError) as exc:
        convert(streams, tmp_path / "out", contract)
    paths = {c["path"] for c in exc.value.conflicts}
    assert "$.id" in paths
    id_conflict = next(c for c in exc.value.conflicts if c["path"] == "$.id")
    assert id_conflict["policy"] == "fail"
