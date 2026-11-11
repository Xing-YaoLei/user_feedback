"""Unit tests for opaque parent-scoped cursors."""

import pytest

from graphql_harvest.server.cursors import (
    CursorError,
    decode_cursor,
    encode_cursor,
)


def test_cursor_roundtrip():
    cur = encode_cursor("exp:exp-3", 7)
    assert isinstance(cur, str)
    # opaque: raw index/scope must not be readable as plain text
    assert "exp-3" not in cur
    assert decode_cursor(cur, "exp:exp-3") == 7


def test_cursor_is_scoped_to_its_connection():
    cur = encode_cursor("inst:inst-1", 2)
    with pytest.raises(CursorError, match="scope mismatch"):
        decode_cursor(cur, "inst:inst-2")
    with pytest.raises(CursorError, match="scope mismatch"):
        decode_cursor(cur, "root")
    with pytest.raises(CursorError, match="scope mismatch"):
        decode_cursor(cur, "exp:exp-9")


def test_malformed_cursor_rejected():
    with pytest.raises(CursorError):
        decode_cursor("not-a-cursor", "root")
