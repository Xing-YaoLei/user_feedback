"""Canonical labels for the two data sources.

Source labels are compared case-insensitively and with surrounding whitespace
ignored.  A few common spellings are accepted so a crosswalk written by one
team and a manifest written by another can still agree on the same source.
"""

from __future__ import annotations

# The only two sources this export knows how to read.
VALID_SOURCES = frozenset({"instrument", "field"})

_SOURCE_ALIASES = {
    "instrument": "instrument",
    "instruments": "instrument",
    "device": "instrument",
    "devices": "instrument",
    "device_measurement": "instrument",
    "device_measurements": "instrument",
    "device measurement": "instrument",
    "device measurements": "instrument",
    "field": "field",
    "observation": "field",
    "observations": "field",
    "field_observation": "field",
    "field_observations": "field",
    "field observation": "field",
    "field observations": "field",
}


def normalize_source(label: str) -> str:
    """Return the canonical source key for a label."""
    key = label.strip().casefold()
    return _SOURCE_ALIASES.get(key, key)
