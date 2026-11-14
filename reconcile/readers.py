"""Readers that normalise the two unsorted input formats into records."""

from __future__ import annotations

import json
from typing import Iterator

from .errors import InputError
from .fields import (
    DEFAULT_SOURCE,
    KEY_ALIASES,
    SHA_ALIASES,
    SIZE_ALIASES,
    SOURCE_ALIASES,
    get_field,
    parse_key,
    parse_sha256,
    parse_size,
    parse_source,
)
from .lines import iter_text_lines
from .records import ManifestRecord, TargetRecord, encode_manifest, encode_target

#: Canonical header names accepted for the TSV target snapshot.
TARGET_COLUMNS = ("key", "size", "sha256")

#: Header aliases per canonical column for the TSV target snapshot.
TARGET_ALIASES = {
    "key": KEY_ALIASES,
    "size": SIZE_ALIASES,
    "sha256": SHA_ALIASES,
}


def manifest_lines(path: str, max_bytes: int) -> Iterator[bytes]:
    """Yield one encoded record per manifest entry, in file order.

    Blank lines are skipped.  Duplicate and contradictory records are kept
    here; they are resolved when the key is grouped.
    """
    shown = path
    for lineno, text in iter_text_lines(path, max_bytes):
        where = f"{shown}:{lineno}"
        if not text.strip():
            continue
        try:
            record = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InputError(
                f"{where}: invalid JSON at column {exc.colno}: {exc.msg}"
            ) from exc
        if not isinstance(record, dict):
            raise InputError(f"{where}: each manifest line must be a JSON object")
        key = parse_key(get_field(record, KEY_ALIASES, where), where)
        size = parse_size(get_field(record, SIZE_ALIASES, where), where)
        sha256 = parse_sha256(get_field(record, SHA_ALIASES, where), where)
        source = DEFAULT_SOURCE
        for alias in SOURCE_ALIASES:
            if alias in record:
                source = parse_source(record[alias], where)
                break
        yield encode_manifest(ManifestRecord(key, source, size, sha256))


def _locate_columns(header: list[str], shown: str) -> dict[str, int]:
    normalised = [cell.strip().lower() for cell in header]
    positions: dict[str, int] = {}
    for canonical, aliases in TARGET_ALIASES.items():
        for alias in aliases:
            if alias in normalised:
                index = normalised.index(alias)
                if index in positions.values():
                    raise InputError(
                        f"{shown}:1: header maps more than one column to {canonical!r}"
                    )
                positions[canonical] = index
                break
        else:
            raise InputError(
                f"{shown}:1: target header is missing the {canonical!r} column "
                f"(accepted names: {', '.join(aliases)})"
            )
    return positions


def target_lines(path: str, max_bytes: int) -> Iterator[bytes]:
    """Yield one encoded record per target row, in file order.

    The first non-blank line must be a header naming the ``key``, ``size`` and
    ``sha256`` columns, in any order and with the usual aliases.  Blank lines
    after the header are skipped.
    """
    shown = path
    columns: dict[str, int] | None = None
    width = 0
    for lineno, text in iter_text_lines(path, max_bytes):
        if not text.strip():
            continue
        row = text.split("\t")
        if columns is None:
            columns = _locate_columns(row, shown)
            width = max(columns.values()) + 1
            continue
        where = f"{shown}:{lineno}"
        if len(row) < width:
            raise InputError(
                f"{where}: expected at least {width} tab-separated columns, "
                f"found {len(row)}"
            )
        key = parse_key(row[columns["key"]], where)
        size = parse_size(row[columns["size"]], where)
        sha256 = parse_sha256(row[columns["sha256"]], where)
        yield encode_target(TargetRecord(key, size, sha256))
