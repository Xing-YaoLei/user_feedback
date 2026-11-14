"""Shared exception type for configuration and input problems."""

from __future__ import annotations


class LinkageError(Exception):
    """Raised when an export cannot proceed safely.

    Configuration mistakes and structurally invalid input files raise this
    instead of being silently skipped, so an export never reports success
    while hiding a problem with the crosswalk, the manifest, or a file
    header.
    """
