"""Opaque, parent-scoped Relay cursors.

A cursor is base64url over ``v1:<scope>:<index>`` where *scope* identifies the
connection the cursor belongs to (root / ``inst:<id>`` / ``exp:<id>``).

The server always re-checks the scope when resolving a cursor, so a cursor
issued for one parent can never advance another parent's connection.
"""

from __future__ import annotations

import base64

PREFIX = "v1"


class CursorError(ValueError):
    """Raised when a cursor is malformed or used in the wrong connection scope."""


def encode_cursor(scope: str, index: int) -> str:
    raw = f"{PREFIX}:{scope}:{index}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_cursor(cursor: str, expected_scope: str) -> int:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise CursorError(f"malformed cursor: {cursor!r}") from exc
    # The scope itself contains a colon (e.g. "exp:exp-3"), so peel the
    # version prefix off the left and the index off the right.
    prefix, rest = raw.split(":", 1)
    if prefix != PREFIX or ":" not in rest:
        raise CursorError(f"malformed cursor: {cursor!r}")
    scope, index_str = rest.rsplit(":", 1)
    if scope != expected_scope:
        raise CursorError(
            f"cursor scope mismatch: cursor belongs to connection {scope!r}, "
            f"but was used on {expected_scope!r}"
        )
    try:
        index = int(index_str)
    except ValueError as exc:
        raise CursorError(f"malformed cursor index: {cursor!r}") from exc
    if index < 0:
        raise CursorError("cursor index must be non-negative")
    return index
