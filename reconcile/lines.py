"""Read input files as UTF-8 lines with a hard per-line byte limit.

Only one line (at most ``max_bytes`` + a little framing) is held at a time, so
an unexpectedly long line fails loudly instead of exhausting memory.
"""

from __future__ import annotations

import os
from typing import Iterator

from .errors import InputError

_READ_BLOCK = 1 << 20
_BOM = b"\xef\xbb\xbf"


def _display(path: str) -> str:
    return os.fspath(path)


def iter_lines(path: str, max_bytes: int) -> Iterator[tuple[int, bytes]]:
    """Yield ``(line_number, raw_line)`` without the trailing newline.

    ``raw_line`` has a trailing carriage return removed so CRLF files behave
    like LF files.  A line whose content is longer than ``max_bytes`` raises
    :class:`InputError`.
    """
    shown = _display(path)
    try:
        handle = open(path, "rb")
    except OSError as exc:
        raise InputError(f"cannot open {shown}: {exc.strerror or exc}") from exc

    with handle:
        buffer = b""
        lineno = 0
        try:
            while True:
                block = handle.read(_READ_BLOCK)
                if not block:
                    break
                buffer += block
                start = 0
                while True:
                    newline = buffer.find(b"\n", start)
                    if newline < 0:
                        break
                    raw = buffer[start:newline]
                    start = newline + 1
                    lineno += 1
                    if len(raw) > max_bytes:
                        raise InputError(
                            f"{shown}:{lineno}: line is {len(raw)} bytes, "
                            f"exceeding the {max_bytes}-byte limit"
                        )
                    if raw.endswith(b"\r"):
                        raw = raw[:-1]
                    yield lineno, raw
                buffer = buffer[start:]
                if len(buffer) > max_bytes:
                    raise InputError(
                        f"{shown}:{lineno + 1}: line exceeds the "
                        f"{max_bytes}-byte limit"
                    )
            if buffer:
                lineno += 1
                if len(buffer) > max_bytes:
                    raise InputError(
                        f"{shown}:{lineno}: line is {len(buffer)} bytes, "
                        f"exceeding the {max_bytes}-byte limit"
                    )
                if buffer.endswith(b"\r"):
                    buffer = buffer[:-1]
                yield lineno, buffer
        except OSError as exc:
            raise InputError(f"cannot read {shown}: {exc.strerror or exc}") from exc


def iter_text_lines(path: str, max_bytes: int) -> Iterator[tuple[int, str]]:
    shown = _display(path)
    for lineno, raw in iter_lines(path, max_bytes):
        if lineno == 1 and raw.startswith(_BOM):
            raw = raw[len(_BOM) :]
        try:
            yield lineno, raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise InputError(
                f"{shown}:{lineno}: invalid UTF-8 at byte offset {exc.start}"
            ) from exc
