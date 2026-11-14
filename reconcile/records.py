"""Normalised record types for both inputs and their on-disk sort encoding.

Records are encoded as NUL-separated UTF-8 fields in *sort order*::

    manifest:  key \\0 source \\0 sha256 \\0 <20-digit size>
    target:    key \\0 sha256 \\0 <20-digit size>

NUL is rejected inside every field, so the separator is unambiguous and plain
byte comparison of two encoded records is exactly the intended order
``(key, source, sha256, size)`` / ``(key, sha256, size)``.  That lets the
external sort order whole records with :func:`sorted` and lets merge passes
compare raw bytes, with no per-record key objects in memory.
"""

from __future__ import annotations

from typing import NamedTuple

from .errors import ReconcileError

#: Largest byte count accepted; keeps the fixed-width decimal field at 20 digits.
MAX_SIZE = 10**20

FIELD_SEPARATOR = b"\x00"
SIZE_WIDTH = 20

#: Rough bytes charged per buffered record beyond its payload: the bytes-object
#: header, the list slot that references it, and allocator slack.
RECORD_LIST_OVERHEAD = 96

MANIFEST_FIELD_COUNT = 4
TARGET_FIELD_COUNT = 3


class ManifestRecord(NamedTuple):
    key: str
    source: str
    size: int
    sha256: str


class TargetRecord(NamedTuple):
    key: str
    size: int
    sha256: str


def _size_field(size: int) -> bytes:
    return f"{size:0{SIZE_WIDTH}d}".encode("ascii")


def _text(field: bytes) -> str:
    try:
        return field.decode("utf-8")
    except UnicodeDecodeError as exc:  # pragma: no cover - writers always emit UTF-8
        raise ReconcileError(
            "internal error: temporary sort record is not valid UTF-8"
        ) from exc


def _split(payload: bytes, expected: int) -> list[bytes]:
    parts = payload.split(FIELD_SEPARATOR)
    if len(parts) != expected:
        raise ReconcileError("internal error: corrupt temporary sort record")
    return parts


def encode_manifest(record: ManifestRecord) -> bytes:
    return FIELD_SEPARATOR.join(
        (
            record.key.encode("utf-8"),
            record.source.encode("utf-8"),
            record.sha256.encode("utf-8"),
            _size_field(record.size),
        )
    )


def decode_manifest(payload: bytes) -> ManifestRecord:
    key, source, sha256, size = _split(payload, MANIFEST_FIELD_COUNT)
    return ManifestRecord(
        _text(key), _text(source), int(size), _text(sha256)
    )


def encode_target(record: TargetRecord) -> bytes:
    return FIELD_SEPARATOR.join(
        (
            record.key.encode("utf-8"),
            record.sha256.encode("utf-8"),
            _size_field(record.size),
        )
    )


def decode_target(payload: bytes) -> TargetRecord:
    key, sha256, size = _split(payload, TARGET_FIELD_COUNT)
    return TargetRecord(_text(key), int(size), _text(sha256))


def split_key(payload: bytes) -> bytes:
    """Return the raw key prefix of an encoded record."""
    return payload.split(FIELD_SEPARATOR, 1)[0]


def decode_key(key: bytes) -> str:
    return _text(key)
