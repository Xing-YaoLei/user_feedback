"""Descriptions of the two input sources and their output columns.

Both sources share one processing path; only the header names, delimiter and
payload columns differ.  Keeping those in one small record makes it
impossible for the instrument and field paths to drift apart on the rules
that matter (registration resolution, purpose gating, code derivation).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

from .labels import VALID_SOURCES


@dataclass(frozen=True)
class PayloadColumn:
    """A surviving business field: output name plus accepted input aliases."""

    output_name: str
    aliases: Tuple[str, ...]


ID_COLUMN = "registration_number"


@dataclass(frozen=True)
class SourceSpec:
    """Everything that differs between the instrument and field inputs."""

    key: str  # canonical source key: "instrument" or "field"
    display_name: str
    data_path: Path
    delimiter: str
    id_aliases: Tuple[str, ...]
    payload: Tuple[PayloadColumn, ...]
    output_path: Optional[Path] = None

    def __post_init__(self):
        if self.key not in VALID_SOURCES:
            raise ValueError(f"unknown source key {self.key!r}")

    @property
    def required_columns(self) -> Tuple[str, ...]:
        """Canonical header names the reader must find, id first."""
        return (ID_COLUMN, *(column.output_name for column in self.payload))

    @property
    def header_aliases(self) -> dict:
        """Accepted input spellings, keyed by canonical column name."""
        aliases = {ID_COLUMN: self.id_aliases}
        aliases.update({column.output_name: column.aliases for column in self.payload})
        return aliases

    @property
    def payload_columns(self) -> Tuple[str, ...]:
        """Output column names after the participant code."""
        return tuple(column.output_name for column in self.payload)


INSTRUMENT_ID_ALIASES = (
    "device_registration_number",
    "device_registration_no",
    "device_registration",
    "device_id",
    "device_number",
    "instrument_registration_number",
    "instrument_id",
    "设备登记号",
    "设备登记编号",
)

FIELD_ID_ALIASES = (
    "observation_registration_number",
    "observation_registration_no",
    "observation_registration",
    "observation_id",
    "observation_number",
    "field_registration_number",
    "field_id",
    "观察登记号",
    "观察登记编号",
)

INSTRUMENT_PAYLOAD = (
    PayloadColumn(
        "measurement_item",
        ("measurement_item", "measurement", "measurement_name", "test_name", "测量项", "测量项目"),
    ),
    PayloadColumn(
        "value",
        ("value", "measurement_value", "result", "reading", "数值", "测量值"),
    ),
)

FIELD_PAYLOAD = (
    PayloadColumn(
        "observation_category",
        ("observation_category", "category", "observation_type", "观察类别", "类别"),
    ),
)
