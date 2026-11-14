"""Delimited-file reading that keeps physical line numbers intact.

Rejections are located by source file and line number, so the reader must
report the physical line where a data row starts -- including when earlier
rows contain quoted newlines -- rather than a data-row counter.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Iterator, Mapping, Optional, Sequence

from .errors import LinkageError

Row = tuple  # (line number, record or None when the row is malformed)


def iter_rows(
    path: Path,
    *,
    delimiter: str,
    required: Sequence[str],
    aliases: Optional[Mapping[str, Sequence[str]]] = None,
) -> Iterator[Row]:
    """Yield ``(line_number, record)`` for each non-blank data row.

    * The header must be present and must contain every required column
      (directly or through an accepted alias).
    * Blank lines are skipped without producing a record.
    * A row whose cell count differs from the header yields ``(line, None)``
      so the caller can record it as a rejection instead of guessing which
      cells line up with which columns. Surplus trailing blank cells are
      dropped first, since some exporters emit them.
    """
    aliases = aliases or {}
    try:
        handle = path.open("r", encoding="utf-8-sig", newline="")
    except FileNotFoundError as exc:
        raise LinkageError(f"input file not found: {path}") from exc
    except OSError as exc:
        raise LinkageError(f"cannot read input file {path}: {exc}") from exc

    with handle:
        reader = csv.reader(handle, delimiter=delimiter)
        try:
            header = next(reader, None)
        except csv.Error as exc:
            raise LinkageError(f"{path}: cannot read header row: {exc}") from exc
        if header is None:
            raise LinkageError(f"{path}: file is empty; expected a header row")

        header_keys = [cell.strip().casefold() for cell in header]
        if any(not key for key in header_keys):
            raise LinkageError(f"{path}: header row contains a blank column name")
        duplicates = sorted(
            {key for key in header_keys if header_keys.count(key) > 1}
        )
        if duplicates:
            raise LinkageError(
                f"{path}: duplicate column name(s): {', '.join(duplicates)}"
            )

        positions: dict = {}
        claimed: dict = {}
        for column in required:
            candidates = [column, *aliases.get(column, ())]
            for candidate in candidates:
                key = candidate.strip().casefold()
                if key not in header_keys:
                    continue
                position = header_keys.index(key)
                if position in claimed:
                    raise LinkageError(
                        f"{path}: columns {claimed[position]!r} and {column!r} "
                        f"both resolve to header column {header[position]!r}"
                    )
                positions[column] = position
                claimed[position] = column
                break
            else:
                raise LinkageError(
                    f"{path}: missing required column {column!r}; "
                    f"found: {', '.join(header_keys)}"
                )

        while True:
            start_line = reader.line_num + 1
            try:
                row = next(reader)
            except StopIteration:
                return
            except csv.Error as exc:
                raise LinkageError(
                    f"{path}: malformed CSV near line {reader.line_num}: {exc}"
                ) from exc

            if not row or all(not cell.strip() for cell in row):
                continue
            # Some exporters append empty cells to shorter rows; drop only the
            # surplus blanks, so a genuinely missing value stays visible.
            while len(row) > len(header) and not row[-1].strip():
                row = row[:-1]
            if len(row) != len(header):
                yield start_line, None
                continue
            yield start_line, {
                column: row[position] for column, position in positions.items()
            }
