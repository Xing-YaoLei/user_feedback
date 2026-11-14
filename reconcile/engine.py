"""Merge two sorted record streams and classify every object key once.

The streams produced by :mod:`reconcile.sortmerge` are already ordered by
encoded key, so records for the same key are contiguous.  Each key is reduced
with constant extra memory no matter how many duplicate records it has:

* identical records collapse because equal values are adjacent in the sort;
* at most two distinct conflicting values are retained (the two smallest,
  which is order-independent);
* source names reported in a conflict are capped, with an explicit
  ``truncated`` marker.

That keeps peak memory flat even when one key appears in every input row.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterator

from .errors import ReconcileError
from .records import (
    MANIFEST_FIELD_COUNT,
    TARGET_FIELD_COUNT,
    FIELD_SEPARATOR,
    decode_key,
)

STATUS_CONSISTENT = "consistent"
STATUS_MISSING_IN_TARGET = "missing_in_target"
STATUS_EXTRA_IN_TARGET = "extra_in_target"
STATUS_CONTENT_MISMATCH = "content_mismatch"
STATUS_MANIFEST_CONFLICT = "manifest_conflict"
STATUS_TARGET_CONFLICT = "target_conflict"

STATUS_ORDER = (
    STATUS_CONSISTENT,
    STATUS_MISSING_IN_TARGET,
    STATUS_EXTRA_IN_TARGET,
    STATUS_CONTENT_MISMATCH,
    STATUS_MANIFEST_CONFLICT,
    STATUS_TARGET_CONFLICT,
)

#: Cap on how many conflicting sources/values are embedded in one detail row.
REPORT_CAP = 8

Emit = Callable[[dict], None]


@dataclass
class Stats:
    manifest_lines: int = 0
    target_lines: int = 0
    manifest_duplicate_records: int = 0
    target_duplicate_records: int = 0
    truncated_conflict_reports: int = 0
    total_objects: int = 0
    counts: dict[str, int] = field(
        default_factory=lambda: {status: 0 for status in STATUS_ORDER}
    )

    def record(self, status: str) -> None:
        self.counts[status] += 1


def _split(payload: bytes, expected: int) -> list[bytes]:
    parts = payload.split(FIELD_SEPARATOR)
    if len(parts) != expected:
        raise ReconcileError("internal error: corrupt sorted record")
    return parts


def _value(size_text: bytes, sha_text: bytes) -> tuple[int, str]:
    return int(size_text), sha_text.decode("utf-8")


class _Peekable:
    """One-record lookahead over an iterator of encoded records."""

    __slots__ = ("_iterator", "_head", "_exhausted")

    def __init__(self, iterator: Iterator[bytes]) -> None:
        self._iterator = iterator
        self._head: bytes | None = None
        self._exhausted = False

    def head(self) -> bytes | None:
        if self._exhausted:
            return None
        if self._head is None:
            try:
                self._head = next(self._iterator)
            except StopIteration:
                self._exhausted = True
                return None
        return self._head

    def advance(self) -> None:
        self._head = None

    @staticmethod
    def key_of(record: bytes) -> bytes:
        return record.split(FIELD_SEPARATOR, 1)[0]


class _ManifestAccumulator:
    """Reduces every manifest record for one key.

    Incoming records are globally sorted by
    ``(key, source, sha256, size)``, so within one source equal values are
    adjacent and distinct values arrive in a fixed order independent of the
    original line order.
    """

    def __init__(self, stats: Stats) -> None:
        self._stats = stats
        self.present = False
        self.source_conflicts: list[dict] = []
        self.conflicting_sources = 0
        self.conflicts_truncated = False
        self.cross_disagreement = False
        self.cross_values: list[tuple[int, str]] = []
        self.consistent_value: tuple[int, str] | None = None

        self._source: str | None = None
        self._first: tuple[int, str] | None = None
        self._second: tuple[int, str] | None = None
        self._last: tuple[int, str] | None = None
        self._distinct = 0

    def add(self, payload: bytes) -> None:
        _, source_text, sha_text, size_text = _split(
            payload, MANIFEST_FIELD_COUNT
        )
        source = source_text.decode("utf-8")
        value = _value(size_text, sha_text)
        self.present = True

        if source != self._source:
            self._finish_source()
            self._source = source
            self._first = value
            self._second = None
            self._last = value
            self._distinct = 1
            return

        if value == self._last:
            # Adjacent equal value: an exact duplicate record.
            self._stats.manifest_duplicate_records += 1
            return

        # A new distinct value for the same source.
        self._distinct += 1
        if self._distinct == 2:
            self._second = value
        # Further distinct values are counted but not stored; the two
        # smallest already prove and describe the conflict.
        self._last = value

    def _finish_source(self) -> None:
        if self._source is None or self._first is None:
            return
        if self._distinct > 1:
            self.conflicting_sources += 1
            if len(self.source_conflicts) < REPORT_CAP:
                values = [self._first]
                if self._second is not None:
                    values.append(self._second)
                self.source_conflicts.append(
                    {
                        "source": self._source,
                        "distinct_value_count": self._distinct,
                        "values": [
                            {"size": size, "sha256": sha}
                            for size, sha in values
                        ],
                    }
                )
            else:
                self.conflicts_truncated = True
            return

        # The source was internally consistent; compare it across sources.
        if self.consistent_value is None:
            self.consistent_value = self._first
            self.cross_values = [self._first]
        elif self._first not in self.cross_values:
            self.cross_disagreement = True
            if len(self.cross_values) < REPORT_CAP:
                self.cross_values.append(self._first)
            else:
                self.conflicts_truncated = True

    def finalize(self) -> None:
        self._finish_source()
        if self.cross_disagreement:
            self.cross_values.sort()


class _TargetAccumulator:
    """Reduces every target row for one key.

    Incoming rows are globally sorted by ``(key, sha256, size)``, so equal
    values are adjacent.
    """

    def __init__(self, stats: Stats) -> None:
        self._stats = stats
        self.present = False
        self.conflict = False
        self.values: list[tuple[int, str]] = []
        self._previous: tuple[int, str] | None = None
        self._distinct = 0

    def add(self, payload: bytes) -> None:
        _, sha_text, size_text = _split(payload, TARGET_FIELD_COUNT)
        value = _value(size_text, sha_text)
        self.present = True
        if self._previous is not None and value == self._previous:
            self._stats.target_duplicate_records += 1
            return
        if self._previous is not None:
            self._distinct += 1
            if self._distinct >= 2:
                self.conflict = True
        else:
            self._distinct = 1
        if len(self.values) < 2:
            self.values.append(value)
        self._previous = value

    @property
    def single_value(self) -> tuple[int, str]:
        return self.values[0]


def _value_obj(value: tuple[int, str]) -> dict:
    size, sha = value
    return {"size": size, "sha256": sha}


def reconcile_streams(
    manifest: Iterator[bytes],
    target: Iterator[bytes],
    emit: Emit,
    stats: Stats,
) -> None:
    """Merge sorted streams and emit exactly one detail row per object key."""
    left = _Peekable(manifest)
    right = _Peekable(target)
    keys_seen = 0

    while True:
        left_record = left.head()
        right_record = right.head()
        if left_record is None and right_record is None:
            break
        keys_seen += 1

        if left_record is None:
            key = _Peekable.key_of(right_record)
        elif right_record is None:
            key = _Peekable.key_of(left_record)
        else:
            left_key = _Peekable.key_of(left_record)
            right_key = _Peekable.key_of(right_record)
            key = min(left_key, right_key)

        key_text = decode_key(key)
        manifest_acc = _ManifestAccumulator(stats)
        target_acc = _TargetAccumulator(stats)

        while (record := left.head()) is not None and _Peekable.key_of(
            record
        ) == key:
            stats.manifest_lines += 1
            manifest_acc.add(record)
            left.advance()
        manifest_acc.finalize()

        while (record := right.head()) is not None and _Peekable.key_of(
            record
        ) == key:
            stats.target_lines += 1
            target_acc.add(record)
            right.advance()

        emit(_classify(key_text, manifest_acc, target_acc, stats))

    stats.total_objects = keys_seen


def _classify(
    key: str,
    manifest: _ManifestAccumulator,
    target: _TargetAccumulator,
    stats: Stats,
) -> dict:
    row: dict = {"key": key}

    if manifest.source_conflicts or manifest.cross_disagreement:
        if manifest.conflicts_truncated:
            stats.truncated_conflict_reports += 1
        row["status"] = STATUS_MANIFEST_CONFLICT
        if manifest.source_conflicts:
            row["reason"] = "same_source_conflicting_values"
            row["conflicts"] = manifest.source_conflicts
        else:
            row["reason"] = "cross_source_disagreement"
        if manifest.cross_values:
            row["distinct_manifest_values"] = [
                _value_obj(value) for value in manifest.cross_values
            ]
        if manifest.conflicts_truncated:
            row["truncated"] = True
        stats.record(STATUS_MANIFEST_CONFLICT)
        return row

    if not manifest.present:
        if target.conflict:
            row["status"] = STATUS_TARGET_CONFLICT
            row["distinct_target_values"] = [
                _value_obj(value) for value in target.values
            ]
            stats.record(STATUS_TARGET_CONFLICT)
            return row
        row["status"] = STATUS_EXTRA_IN_TARGET
        row["target"] = _value_obj(target.single_value)
        stats.record(STATUS_EXTRA_IN_TARGET)
        return row

    manifest_value = manifest.consistent_value
    if manifest_value is None:  # pragma: no cover - present implies a value
        raise ReconcileError("internal error: manifest key without any value")

    if not target.present:
        row["status"] = STATUS_MISSING_IN_TARGET
        row["manifest"] = _value_obj(manifest_value)
        stats.record(STATUS_MISSING_IN_TARGET)
        return row

    if target.conflict:
        row["status"] = STATUS_TARGET_CONFLICT
        row["manifest"] = _value_obj(manifest_value)
        row["distinct_target_values"] = [
            _value_obj(value) for value in target.values
        ]
        stats.record(STATUS_TARGET_CONFLICT)
        return row

    target_value = target.single_value
    if manifest_value == target_value:
        row["status"] = STATUS_CONSISTENT
        row["manifest"] = _value_obj(manifest_value)
        row["target"] = _value_obj(target_value)
        stats.record(STATUS_CONSISTENT)
        return row

    differing = []
    if manifest_value[0] != target_value[0]:
        differing.append("size")
    if manifest_value[1] != target_value[1]:
        differing.append("sha256")
    row["status"] = STATUS_CONTENT_MISMATCH
    row["manifest"] = _value_obj(manifest_value)
    row["target"] = _value_obj(target_value)
    row["differing_fields"] = differing
    stats.record(STATUS_CONTENT_MISMATCH)
    return row
