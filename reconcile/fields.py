"""Field names, aliases and strict value parsers shared by both readers.

Canonical manifest fields are ``key``, ``size``, ``sha256`` and the optional
``source``.  The target snapshot columns are ``key``, ``size`` and ``sha256``.
Aliases exist so ordinary inventories with slightly different headers can be
read without preprocessing; canonical names always win when both are present.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from .errors import InputError
from .records import MAX_SIZE

#: Source used when a manifest record has no explicit ``source`` field.
DEFAULT_SOURCE = "default"

KEY_ALIASES = ("key", "object_key", "objectkey", "path", "object", "name")
SIZE_ALIASES = ("size", "bytes", "length", "byte_size", "bytesize")
SHA_ALIASES = ("sha256", "sha_256", "sha", "hash", "checksum", "digest")
SOURCE_ALIASES = ("source", "origin", "src")

_DECIMAL = re.compile(r"[0-9]+\Z")


def get_field(record: dict[str, Any], names: Iterable[str], where: str) -> Any:
    """Return the first present alias of a field, or fail with a clear error."""
    for name in names:
        if name in record:
            return record[name]
    raise InputError(f"{where}: missing required field {next(iter(names))!r}")


def parse_key(value: Any, where: str) -> str:
    if not isinstance(value, str) or value == "":
        raise InputError(f"{where}: object key must be a non-empty string")
    if "\x00" in value:
        raise InputError(f"{where}: object key must not contain a NUL character")
    return value

def parse_size(value: Any, where: str) -> int:
    """Parse a byte count from a JSON number or a decimal TSV string."""
    if isinstance(value, bool):
        raise InputError(f"{where}: byte count must be an integer, not a boolean")
    if isinstance(value, int):
        size = value
    elif isinstance(value, str) and _DECIMAL.fullmatch(value.strip()):
        size = int(value.strip())
    else:
        raise InputError(f"{where}: byte count must be a non-negative integer")
    if size < 0:
        raise InputError(f"{where}: byte count must be non-negative")
    if size >= MAX_SIZE:
        raise InputError(
            f"{where}: byte count must be smaller than {MAX_SIZE}"
        )
    return size


def parse_sha256(value: Any, where: str) -> str:
    """Normalise a digest for case-insensitive comparison.

    The length is intentionally not enforced: real inventories occasionally
    carry short test digests, and a length check here would reject them while
    adding nothing to the comparison, which is purely string equality.
    """
    if not isinstance(value, str):
        raise InputError(f"{where}: SHA-256 must be a string")
    digest = value.strip()
    if not digest:
        raise InputError(f"{where}: SHA-256 must not be empty")
    if any(ch.isspace() for ch in digest):
        raise InputError(f"{where}: SHA-256 must not contain whitespace")
    if "\x00" in digest:
        raise InputError(f"{where}: SHA-256 must not contain a NUL character")
    return digest.lower()


def parse_source(value: Any, where: str) -> str:
    if not isinstance(value, str):
        raise InputError(f"{where}: source must be a string")
    if "\x00" in value:
        raise InputError(f"{where}: source must not contain a NUL character")
    return value
