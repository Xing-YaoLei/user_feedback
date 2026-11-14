"""The registration-number crosswalk.

Each row maps one source's registration number to the study master id.
Lookups are scoped by source, so the same registration string used by two
different sources does not accidentally resolve to the wrong participant.

A registration number that appears with more than one master id is kept as
ambiguous rather than resolved arbitrarily; the export rejects those
records instead of guessing.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, FrozenSet, List, Optional, Set, Tuple

from .errors import LinkageError
from .labels import VALID_SOURCES, normalize_source

REGISTRATION_ALIASES = (
    "registration_number",
    "registration_no",
    "登记号",
    "登记编号",
)
SOURCE_ALIASES = (
    "source",
    "record_source",
    "data_source",
    "source_system",
    "来源",
)
MASTER_ALIASES = (
    "master_id",
    "study_id",
    "participant_master_id",
    "master_number",
    "主编号",
    "研究主编号",
)


@dataclass(frozen=True)
class Resolution:
    """Outcome of resolving one registration number."""

    kind: str  # "unique", "ambiguous" or "missing"
    masters: Tuple[str, ...] = ()

    @property
    def master_id(self) -> Optional[str]:
        return self.masters[0] if self.kind == "unique" else None


@dataclass(frozen=True)
class Crosswalk:
    """Immutable index from ``(source, registration)`` to master ids."""

    path: str
    index: Dict[Tuple[str, str], FrozenSet[str]]

    def resolve(self, source: str, registration: str) -> Resolution:
        masters = self.index.get((normalize_source(source), registration.strip()))
        if not masters:
            return Resolution("missing")
        if len(masters) > 1:
            return Resolution("ambiguous", tuple(sorted(masters)))
        return Resolution("unique", tuple(masters))


def load_crosswalk(path: Path) -> Crosswalk:
    """Read a crosswalk CSV/TSV into a lookup index."""
    delimiter = detect_delimiter(path)
    try:
        handle = path.open("r", encoding="utf-8-sig", newline="")
    except FileNotFoundError as exc:
        raise LinkageError(f"crosswalk not found: {path}") from exc
    except OSError as exc:
        raise LinkageError(f"cannot read crosswalk {path}: {exc}") from exc

    index: Dict[Tuple[str, str], Set[str]] = {}
    with handle:
        reader = csv.reader(handle, delimiter=delimiter)
        try:
            header = next(reader, None)
        except csv.Error as exc:
            raise LinkageError(f"{path}: cannot read crosswalk header: {exc}") from exc
        if header is None:
            raise LinkageError(f"{path}: crosswalk is empty")

        keys = [cell.strip().casefold() for cell in header]
        if any(not key for key in keys):
            raise LinkageError(f"{path}: crosswalk header has a blank column name")
        if len(set(keys)) != len(keys):
            raise LinkageError(f"{path}: crosswalk header repeats a column name")
        columns = {
            "registration": _find_column(keys, REGISTRATION_ALIASES, path),
            "source": _find_column(keys, SOURCE_ALIASES, path),
            "master": _find_column(keys, MASTER_ALIASES, path),
        }

        while True:
            line = reader.line_num + 1
            try:
                row = next(reader)
            except StopIteration:
                break
            except csv.Error as exc:
                raise LinkageError(
                    f"{path}: malformed crosswalk near line {reader.line_num}: {exc}"
                ) from exc
            if not row or all(not cell.strip() for cell in row):
                continue
            if len(row) <= max(columns.values()):
                # An incomplete crosswalk row is a configuration error: silently
                # ignoring it would make every record that depends on it look
                # like an unmapped registration.
                raise LinkageError(
                    f"{path}: crosswalk row {line} has {len(row)} cells; "
                    f"expected at least {max(columns.values()) + 1}"
                )
            registration = row[columns["registration"]].strip()
            master = row[columns["master"]].strip()
            raw_source = row[columns["source"]].strip()
            if not registration and not master and not raw_source:
                continue
            if not registration or not master or not raw_source:
                raise LinkageError(
                    f"{path}: crosswalk row {line} is missing a "
                    "registration number, source or master id"
                )
            source = normalize_source(raw_source)
            if source not in VALID_SOURCES:
                raise LinkageError(
                    f"{path}: crosswalk row {line} has unknown source "
                    f"{raw_source!r}; expected one of: "
                    f"{', '.join(sorted(VALID_SOURCES))}"
                )
            index.setdefault((source, registration), set()).add(master)

    return Crosswalk(
        path=str(path),
        index={key: frozenset(value) for key, value in index.items()},
    )


def _find_column(keys: List[str], aliases: Tuple[str, ...], path: Path) -> int:
    """Return the position of the first alias present in the header."""
    for alias in aliases:
        key = alias.casefold()
        if key in keys:
            return keys.index(key)
    wanted = ", ".join(repr(alias) for alias in aliases)
    found = ", ".join(repr(key) for key in keys)
    raise LinkageError(
        f"{path}: crosswalk has no {wanted} column; found: {found}"
    )


def detect_delimiter(path: Path) -> str:
    """Pick tab or comma for a delimited file.

    The extension wins when it is explicit; otherwise a tab in the header
    line selects TSV.  Crosswalks are small enough to read the header only.
    """
    suffix = path.suffix.casefold()
    if suffix in {".tsv", ".tab"}:
        return "\t"
    if suffix == ".csv":
        return ","
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            for line in handle:
                if line.strip():
                    return "\t" if "\t" in line else ","
    except OSError:
        return ","
    return ","
