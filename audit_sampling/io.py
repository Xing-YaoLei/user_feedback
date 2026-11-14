"""Streaming readers and writers for gzip JSONL inputs and JSON outputs.

Input records look like::

    {"page_id": "p-000123", "language": "zh", "confidence": 0.93}

Reviewed IDs may be stored as a plain JSON list, a JSON object with an ``ids``
key, or as JSONL (one page ID per line, or a full record per line).
"""

from __future__ import annotations

import gzip
import io
import json
import os
import sys
from collections.abc import Iterator, Mapping, Sequence
from typing import Any

from .core import PageRecord, SamplingError


def open_text_for_read(path: str) -> io.TextIOBase:
    """Open a gzip file transparently (sniffing the magic bytes), else plain text."""

    if path == "-":
        return sys.stdin
    with open(path, "rb") as probe:
        magic = probe.read(2)
    if magic == b"\x1f\x8b":
        return io.TextIOWrapper(
            gzip.open(path, "rb"), encoding="utf-8", errors="strict"
        )
    return open(path, "r", encoding="utf-8", errors="strict", newline="")


def open_text_for_write(path: str) -> io.TextIOBase:
    if path == "-":
        return sys.stdout
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    return open(path, "w", encoding="utf-8", newline="\n")


def _loads(raw: str, context: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SamplingError(f"{context}: invalid JSON: {exc.msg}") from exc


def _confidence(value: Any, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SamplingError(f"{context}: confidence must be a number, got {value!r}")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise SamplingError(f"{context}: confidence must be finite, got {value!r}")
    if not 0.0 <= number <= 1.0:
        raise SamplingError(f"{context}: confidence must be within [0, 1], got {value!r}")
    return number


_ID_ALIASES = ("page_id", "pageId", "id")
_LANGUAGE_ALIASES = ("language", "lang")
_CONFIDENCE_ALIASES = ("confidence", "ocr_confidence", "ocr_conf")


def _aliased(entry: Mapping[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        if name in entry:
            return entry[name]
    return None


def _read_record(entry: Mapping[str, Any], context: str) -> PageRecord:
    page_id = _aliased(entry, _ID_ALIASES)
    if not isinstance(page_id, str) or not page_id:
        raise SamplingError(
            f"{context}: missing a non-empty page ID field; expected one of "
            f"{list(_ID_ALIASES)}"
        )
    language = _aliased(entry, _LANGUAGE_ALIASES)
    if not isinstance(language, str) or not language:
        raise SamplingError(
            f"{context}: missing a non-empty language field; expected one of "
            f"{list(_LANGUAGE_ALIASES)}"
        )
    confidence = _aliased(entry, _CONFIDENCE_ALIASES)
    if confidence is None:
        raise SamplingError(
            f"{context}: missing a confidence field; expected one of "
            f"{list(_CONFIDENCE_ALIASES)}"
        )
    return PageRecord(
        page_id=page_id,
        language=language,
        confidence=_confidence(confidence, context),
    )


def iter_page_records(path: str) -> Iterator[PageRecord]:
    """Yield validated records from a gzip or plain JSONL file, one line at a time."""

    stream = open_text_for_read(path)
    try:
        for line_number, raw in enumerate(stream, start=1):
            if not raw.strip():
                continue
            context = f"{path}:{line_number}"
            entry = _loads(raw, context)
            if not isinstance(entry, Mapping):
                raise SamplingError(f"{context}: expected a JSON object per line")
            yield _read_record(entry, context)
    finally:
        if stream is not sys.stdin:
            stream.close()


def iter_page_records_many(paths: Sequence[str]) -> Iterator[PageRecord]:
    """Yield records from several files in order.

    Page IDs are required to be globally unique by the input contract.  No
    cross-file deduplication set is kept here: that would make memory grow with
    the number of input records, defeating the point of a branch summary.  The
    merge step rejects a page ID that appears as a candidate in two summaries.
    """

    for path in paths:
        yield from iter_page_records(path)


def read_reviewed_ids(path: str) -> frozenset[str]:
    """Load the already-reviewed page ID list.

    Accepted layouts:

    * JSON array of page IDs (optionally multi-line)::

          ["p1", "p2"]

    * JSON object with an ``ids`` array or a ``page_id`` field, or an object
      whose string keys *are* the reviewed IDs (``{"p1": true, "p2": true}``).
    * JSONL: one page ID, one quoted string, or one full record per line.
    * Plain text: one page ID per line.
    """

    stream = open_text_for_read(path)
    try:
        text = stream.read()
    finally:
        if stream is not sys.stdin:
            stream.close()

    stripped = text.strip()
    if not stripped:
        return frozenset()

    document = _try_loads(stripped)
    if isinstance(document, list):
        return frozenset(
            _reviewed_entry(value, index) for index, value in enumerate(document)
        )
    if isinstance(document, Mapping):
        return _reviewed_object(document, path)
    if isinstance(document, str):
        return frozenset({_reviewed_entry(document, 0)})
    if stripped[0] == "[":
        # A JSON array that could not be parsed as a whole is almost certainly
        # truncated or malformed; report it rather than indexing fragments.
        _loads(stripped, path)

    ids: set[str] = set()
    for line_number, raw in enumerate(stripped.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        entry = _try_loads(line)
        if isinstance(entry, Mapping):
            ids.add(_reviewed_entry(entry, line_number))
        elif isinstance(entry, str):
            # A quoted JSON string on its own line.
            ids.add(_reviewed_entry(entry, line_number))
        else:
            ids.add(line)
    return frozenset(ids)


def _try_loads(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _reviewed_object(document: Mapping[str, Any], path: str) -> frozenset[str]:
    if "ids" in document:
        ids = document["ids"]
        if not isinstance(ids, list):
            raise SamplingError(f"{path}: reviewed-ID JSON 'ids' must be an array")
        return frozenset(
            _reviewed_entry(value, index) for index, value in enumerate(ids)
        )
    if "page_id" in document:
        return frozenset({_reviewed_entry(document, 0)})
    # Fast path: {"p1": true, "p2": true}.
    if all(isinstance(key, str) and key for key in document):
        return frozenset(document)
    raise SamplingError(
        f"{path}: reviewed-ID JSON object needs an 'ids' array, a 'page_id' "
        f"field, or reviewed page IDs as object keys"
    )


def _reviewed_entry(value: Any, index: int) -> str:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, Mapping):
        page_id = _aliased(value, _ID_ALIASES)
        if isinstance(page_id, str) and page_id:
            return page_id
    raise SamplingError(
        f"reviewed IDs entry {index}: expected a non-empty string page ID "
        f"or an object with a page ID field ({', '.join(_ID_ALIASES)})"
    )


def write_json(path: str, payload: Any) -> None:
    stream = open_text_for_write(path)
    try:
        json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=False)
        stream.write("\n")
        stream.flush()
    finally:
        if stream is not sys.stdout:
            stream.close()
