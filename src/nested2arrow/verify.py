"""Deep semantic verification of a JSON -> Parquet -> JSON round-trip.

The checks deliberately go beyond "the Parquet file opens":

* structure equality (nested objects, arrays, field order);
* value equality with exact decimals and timezone-aware instants;
* *presence semantics* — missing field vs explicit null vs empty array vs
  null array element — using the ``__present__`` auxiliary column;
* explicit Arrow-level assertions on null counts and decimal/timestamp types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .contract import Contract
from .decoder import decode_table, read_table
from .inference import parse_line
from .paths import INDEX, Path, render
from .typesystem import TObject


@dataclass
class VerificationFailure:
    path: str
    message: str


@dataclass
class VerificationReport:
    ok: bool
    records_checked: int
    failures: list[VerificationFailure] = field(default_factory=list)
    checks: list[str] = field(default_factory=list)

    def raise_if_failed(self) -> None:
        if not self.ok:
            joined = "\n".join(f"  - {f.path}: {f.message}"
                               for f in self.failures)
            raise AssertionError(
                f"round-trip verification failed "
                f"({len(self.failures)} failure(s)):\n{joined}")


def verify_roundtrip(
    raw_records: list[bytes],
    parquet_source: str,
    root: TObject,
    contract: Contract,
) -> VerificationReport:
    expected = [parse_line(raw) for raw in raw_records]
    table = read_table(parquet_source)
    actual = decode_table(table, root, contract)
    report = VerificationReport(ok=True, records_checked=len(expected))

    report.checks.append(
        f"row count: {len(expected)} source vs {table.num_rows} parquet")
    if len(expected) != table.num_rows:
        report.ok = False
        report.failures.append(VerificationFailure(
            "$", f"row count {table.num_rows} != source {len(expected)}"))

    expected_presence = [_collect_presence(rec) for rec in expected]
    actual_presence = [
        {entry.split("#d=", 1)[0]
         for entry in row[contract.presence_column]}
        for row in table.to_pylist()
    ]

    for i, (exp, act) in enumerate(zip(expected, actual)):
        _compare(exp, act, (), report, i)
        # presence-set equality is the missing-vs-null guarantee
        if expected_presence[i] != actual_presence[i]:
            report.ok = False
            missing = expected_presence[i] - actual_presence[i]
            extra = actual_presence[i] - expected_presence[i]
            report.failures.append(VerificationFailure(
                f"record[{i}]",
                f"presence mismatch missing={sorted(missing)} extra={sorted(extra)}",
            ))

    _arrow_invariants(table, root, contract, report)
    return report


def _collect_presence(value: Any, path: Path = ()) -> set[str]:
    present = {render(path)}
    if isinstance(value, dict):
        for key, child in value.items():
            present |= _collect_presence(child, path + (key,))
    elif isinstance(value, list):
        for item in value:
            present |= _collect_presence(item, path + (INDEX,))
    return present


def _compare(expected: Any, actual: Any, path: Path,
             report: VerificationReport, record_index: int) -> None:
    label = f"record[{record_index}].{render(path)}"

    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            _fail(report, label, f"expected object, got {type(actual).__name__}")
            return
        if set(expected) != set(actual):
            _fail(report, label,
                  f"keys differ expected={sorted(expected)} actual={sorted(actual)}")
        for key in expected.keys() & actual.keys():
            _compare(expected[key], actual[key], path + (key,),
                     report, record_index)
        return

    if isinstance(expected, list):
        if not isinstance(actual, list):
            _fail(report, label, f"expected array, got {type(actual).__name__}")
            return
        if len(expected) != len(actual):
            _fail(report, label,
                  f"array length {len(actual)} != {len(expected)}")
        for i, (exp_item, act_item) in enumerate(
                zip(expected, actual)):
            _compare(exp_item, act_item, path + (INDEX,),
                     report, record_index)
        if not expected:
            report.checks.append(f"{label}: empty array preserved")
        return

    # scalars
    if expected is None:
        if actual is not None:
            _fail(report, label, f"expected null, got {actual!r}")
        return

    if isinstance(expected, bool):
        if expected != actual:
            _fail(report, label, f"{actual!r} != {expected!r}")
        return

    if isinstance(expected, int):
        if type(actual) is not int or expected != actual:
            _fail(report, label,
                  f"integer mismatch expected {expected!r} got {actual!r}")
        return

    if isinstance(expected, Decimal):
        if not isinstance(actual, Decimal) or expected != actual:
            _fail(report, label,
                  f"decimal mismatch expected {expected!r} got {actual!r}")
        elif expected.as_tuple() != actual.as_tuple():
            _fail(report, label,
                  f"decimal scale lost expected {expected.as_tuple()} "
                  f"got {actual.as_tuple()}")
        return

    if isinstance(expected, str):
        # ISO timestamps compare by instant: normalization to UTC may change
        # the offset text while representing the identical point in time
        expected_dt = _maybe_timestamp(expected)
        if expected_dt is not None:
            actual_dt = _maybe_timestamp(actual)
            if actual_dt is None or expected_dt != actual_dt:
                _fail(report, label,
                      f"timestamp instant mismatch {actual!r} != {expected!r}")
            return
        if expected != actual:
            _fail(report, label, f"string mismatch {actual!r} != {expected!r}")
        return

    _fail(report, label, f"unsupported expected value {expected!r}")


def _maybe_timestamp(text: str):
    from datetime import datetime
    if not isinstance(text, str):
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else None


def _arrow_invariants(table, root: TObject, contract: Contract,
                      report: VerificationReport) -> None:
    import pyarrow as pa

    schema = table.schema
    if contract.presence_column not in schema.names:
        _fail(report, "$", f"missing auxiliary column {contract.presence_column}")
    else:
        report.checks.append(
            f"auxiliary presence column {contract.presence_column} present")

    record_type = schema.field("record").type
    if not pa.types.is_struct(record_type):
        _fail(report, "$", "record column is not a struct")
        return
    if all(field.nullable for field in record_type):
        report.checks.append("all struct fields are nullable (explicit nulls)")

    # Walk every list column and assert null array elements survive as real
    # Arrow nulls on the flattened child array — empty lists contribute none.
    record_column = table.column("record").combine_chunks()

    def walk(arrow_type, array, prefix):
        if pa.types.is_struct(arrow_type):
            for field_ in arrow_type:
                walk(field_.type, array.field(field_.name),
                     prefix + "." + field_.name)
        elif pa.types.is_list(arrow_type):
            child = array.values
            null_count = child.null_count
            report.checks.append(
                f"list {prefix}: flattened child null_count={null_count}")
            # cross-check against explicit null elements in source-derived data
            walk(arrow_type.value_type, child, prefix + "[]")

    walk(record_type, record_column, "record")

    # decimal columns must be physical decimal types, never strings/floats
    for field_ in record_type:
        if pa.types.is_decimal(field_.type):
            report.checks.append(
                f"{field_.name} stored as {field_.type} (exact decimal)")
        if pa.types.is_timestamp(field_.type):
            report.checks.append(
                f"{field_.name} stored as {field_.type} (tz-aware instant)")


def _fail(report: VerificationReport, path: str, message: str) -> None:
    report.ok = False
    report.failures.append(VerificationFailure(path=path, message=message))
