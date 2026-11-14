"""Deterministic, purpose-scoped participant codes.

A code is an HMAC-SHA256 of the study master id, keyed by the export secret
and domain-separated by the purpose.  That gives three properties the export
depends on:

* the same participant gets the same code on every re-export with the same
  key and purpose (so the two result files can be joined and re-run safely);
* the same participant gets a different code under a different purpose;
* the code cannot be recomputed from the master id without the key.

The code is a pseudonym, not anonymisation: anyone holding the key and the
crosswalk can reproduce it.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Union

from .errors import LinkageError

CODE_PREFIX = "P-"
CODE_HEX_DIGITS = 16
RECOMMENDED_KEY_BYTES = 16
_DOMAIN = "participant-linkage/v1"

KeyMaterial = Union[bytes, bytearray]


def validate_key(key: KeyMaterial) -> None:
    """Reject keys that cannot be used for a deterministic HMAC."""
    if not isinstance(key, (bytes, bytearray)):
        raise TypeError("key must be bytes")
    if not bytes(key):
        raise LinkageError("key must not be empty")


def key_is_weak(key: KeyMaterial) -> bool:
    """True for keys short enough to be worth warning about."""
    return len(bytes(key)) < RECOMMENDED_KEY_BYTES


def participant_code(master_id: str, purpose: str, key: KeyMaterial) -> str:
    """Return the stable participant code for ``master_id`` in ``purpose``."""
    validate_key(key)
    master = master_id.strip()
    scope = purpose.strip()
    if not master:
        raise LinkageError("cannot derive a participant code without a master id")
    if not scope:
        raise LinkageError("cannot derive a participant code without a purpose")
    message = b"\x00".join(
        (_DOMAIN.encode("utf-8"), scope.encode("utf-8"), master.encode("utf-8"))
    )
    digest = hmac.new(bytes(key), message, hashlib.sha256).hexdigest()
    return CODE_PREFIX + digest[:CODE_HEX_DIGITS].upper()
