"""External merge sort for more records than the memory budget allows.

Records arrive as encoded bytes.  A run holds sorted records with a 4-byte
little-endian length in front of each record.  If every record fits in the
in-memory chunk allowance no temporary file is written; otherwise sorted runs
are spilled and merged in bounded fan-in passes.
"""

from __future__ import annotations

import heapq
import os
import struct
from itertools import count
from typing import Iterable, Iterator

from .errors import ReconcileError
from .records import RECORD_LIST_OVERHEAD

_FRAME = struct.Struct("<I")
_RUN_BUFFER_BYTES = 1 << 18
_RUN_READ_BUFFER_BYTES = 1 << 15


def _write_run(path: str, records: list[bytes]) -> None:
    buffer = bytearray()
    with open(path, "wb") as handle:
        for record in sorted(records):
            buffer += _FRAME.pack(len(record))
            buffer += record
            if len(buffer) >= _RUN_BUFFER_BYTES:
                handle.write(buffer)
                buffer.clear()
        if buffer:
            handle.write(buffer)


def _iter_run(path: str) -> Iterator[bytes]:
    with open(path, "rb", buffering=_RUN_READ_BUFFER_BYTES) as handle:
        while True:
            header = handle.read(_FRAME.size)
            if not header:
                return
            if len(header) != _FRAME.size:
                raise ReconcileError(
                    "internal error: truncated temporary sort run"
                )
            (length,) = _FRAME.unpack(header)
            payload = handle.read(length)
            if len(payload) != length:
                raise ReconcileError(
                    "internal error: truncated temporary sort run"
                )
            yield payload


def _close_all(iterators: Iterable[Iterator[bytes]]) -> None:
    for iterator in iterators:
        close = getattr(iterator, "close", None)
        if close is not None:
            close()


def _merge_into(paths: list[str], out_path: str) -> None:
    iterators = [_iter_run(path) for path in paths]
    buffer = bytearray()
    try:
        with open(out_path, "wb") as handle:
            for record in heapq.merge(*iterators):
                buffer += _FRAME.pack(len(record))
                buffer += record
                if len(buffer) >= _RUN_BUFFER_BYTES:
                    handle.write(buffer)
                    buffer.clear()
            if buffer:
                handle.write(buffer)
    finally:
        _close_all(iterators)
    for path in paths:
        os.unlink(path)


def _merge_runs(paths: list[str]) -> Iterator[bytes]:
    iterators = [_iter_run(path) for path in paths]
    try:
        yield from heapq.merge(*iterators)
    finally:
        _close_all(iterators)
        for path in paths:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def external_sort(
    records: Iterable[bytes],
    workdir: str,
    prefix: str,
    chunk_bytes: int,
    fan_in: int,
) -> Iterator[bytes]:
    """Return the records in ascending byte order.

    ``chunk_bytes`` bounds the in-memory record bytes of one sorted chunk;
    ``fan_in`` bounds how many runs are merged at once.
    """
    if chunk_bytes < 1:
        raise ValueError("chunk_bytes must be positive")
    if fan_in < 2:
        raise ValueError("fan_in must be at least 2")

    chunk: list[bytes] = []
    used = 0
    runs: list[str] = []
    run_ids = count()
    merge_ids = count()

    for record in records:
        chunk.append(record)
        used += len(record) + RECORD_LIST_OVERHEAD
        if used >= chunk_bytes:
            run = os.path.join(workdir, f"{prefix}-{next(run_ids):04d}.run")
            _write_run(run, chunk)
            runs.append(run)
            chunk = []
            used = 0

    if not runs:
        return iter(sorted(chunk))

    if chunk:
        run = os.path.join(workdir, f"{prefix}-{next(run_ids):04d}.run")
        _write_run(run, chunk)
        runs.append(run)
    chunk = []

    level = 0
    while len(runs) > fan_in:
        merged: list[str] = []
        for start in range(0, len(runs), fan_in):
            group = runs[start : start + fan_in]
            if len(group) == 1:
                merged.append(group[0])
                continue
            out = os.path.join(
                workdir, f"{prefix}-m{level:02d}-{next(merge_ids):04d}.run"
            )
            _merge_into(group, out)
            merged.append(out)
        runs = merged
        level += 1

    return _merge_runs(runs)
