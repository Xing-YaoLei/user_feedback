"""The export: resolve registrations, gate on purpose, pseudonymise, split.

Processing is one pass per source file.  For each row the order of checks
matches the requirement's wording -- a record enters the results only if its
registration resolves uniquely *and* its source is approved for this purpose
for that participant:

1. a row whose cell count does not match the header is ``malformed_row``;
2. a blank registration is ``registration_missing``;
3. a registration that maps to no master id is ``registration_missing``;
4. a registration that maps to several master ids is ``registration_ambiguous``;
5. a source not approved for this participant under this purpose is
   ``purpose_not_approved``;
6. otherwise the row is emitted.

The first failing check is the one reported, so every rejected row has
exactly one reason and one locating pair of file and line.
"""

from __future__ import annotations

import csv
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

from .codes import key_is_weak, participant_code, validate_key
from .crosswalk import Crosswalk
from .errors import LinkageError
from .manifest import Manifest, PurposeApproval
from .reader import iter_rows
from .spec import ID_COLUMN, SourceSpec

CODE_HEADER = "participant_code"

# Rejection reasons.  The three the requirements name, plus a mis-shaped row
# which is rejected rather than guessed at.  Each entry carries the source
# file and physical line number so a record can be found again in its input.
REJECT_HEADERS = (
    "source_file",
    "line_number",
    "source",
    "registration_number",
    "reason",
)


@dataclass
class SourceOutcome:
    """What one source contributed to an export."""

    source: str
    data_path: str
    output_path: str
    emitted: int = 0
    rejects: List[dict] = field(default_factory=list)


@dataclass
class ExportResult:
    """Summary of an export run, suitable for printing or asserting on."""

    purpose: str
    sources: Dict[str, SourceOutcome]
    reject_path: str
    warnings: List[str] = field(default_factory=list)

    @property
    def emitted(self) -> int:
        return sum(outcome.emitted for outcome in self.sources.values())

    @property
    def rejected(self) -> int:
        return sum(len(outcome.rejects) for outcome in self.sources.values())


def export(
    *,
    purpose: str,
    key: bytes,
    manifest: Manifest,
    crosswalk: Crosswalk,
    specs: Sequence[SourceSpec],
    reject_path: Path,
) -> ExportResult:
    """Run a purpose-scoped export for the given sources."""
    scope = purpose.strip()
    if not scope:
        raise LinkageError("purpose must not be blank")
    validate_key(key)
    reject_path = Path(reject_path)

    if not specs:
        raise LinkageError("no input sources were given")
    seen = set()
    for spec in specs:
        if spec.key in seen:
            raise LinkageError(f"source {spec.key!r} was given more than once")
        seen.add(spec.key)
        if spec.output_path is None:
            raise LinkageError(f"no output path was given for source {spec.key!r}")
        if spec.output_path.resolve() == spec.data_path.resolve():
            raise LinkageError(
                f"output for source {spec.key!r} would overwrite its input file"
            )

    output_paths = [spec.output_path.resolve() for spec in specs]
    if len(set(output_paths)) != len(output_paths):
        raise LinkageError("two sources would write the same result file")
    if reject_path.resolve() in output_paths:
        raise LinkageError("reject list path must differ from result paths")
    if any(spec.data_path.resolve() == reject_path.resolve() for spec in specs):
        raise LinkageError("reject list path must differ from input paths")

    approval = manifest.require_purpose(scope)
    warnings: List[str] = []
    if key_is_weak(key):
        warnings.append(
            f"export key is shorter than the recommended 16 bytes ({len(key)} bytes)"
        )

    outcomes: Dict[str, SourceOutcome] = {}
    rows_out: Dict[str, List[List[str]]] = {}
    reject_rows: List[List[str]] = []

    # Process every source and write nothing until all of them have been read,
    # so a run that fails part-way leaves no half-updated result files behind.
    for spec in specs:
        rows, outcome = _process_source(
            spec=spec,
            scope=scope,
            key=key,
            crosswalk=crosswalk,
            approval=approval,
        )
        rows_out[spec.key] = rows
        outcomes[spec.key] = outcome
        reject_rows.extend(
            [
                row["source_file"],
                str(row["line_number"]),
                row["source"],
                row["registration_number"],
                row["reason"],
            ]
            for row in outcome.rejects
        )

    for spec in specs:
        _write_rows(
            spec.output_path,
            [CODE_HEADER, *spec.payload_columns],
            [[code, *values] for code, values in rows_out[spec.key]],
        )
    _write_rows(reject_path, REJECT_HEADERS, reject_rows)

    return ExportResult(
        purpose=scope,
        sources=outcomes,
        reject_path=str(reject_path),
        warnings=warnings,
    )


def _process_source(
    *,
    spec: SourceSpec,
    scope: str,
    key: bytes,
    crosswalk: Crosswalk,
    approval: PurposeApproval,
) -> Tuple[List[Tuple[str, List[str]]], SourceOutcome]:
    rows: List[Tuple[str, List[str]]] = []
    rejects: List[dict] = []
    source_file = spec.data_path.name

    def reject(line: int, registration: str, reason: str) -> None:
        rejects.append(
            {
                "source_file": source_file,
                "line_number": line,
                "source": spec.key,
                "registration_number": registration,
                "reason": reason,
            }
        )

    for line, record in iter_rows(
        spec.data_path,
        delimiter=spec.delimiter,
        required=spec.required_columns,
        aliases=spec.header_aliases,
    ):
        if record is None:
            reject(line, "", "malformed_row")
            continue

        registration = record.get(ID_COLUMN, "").strip()
        if not registration:
            reject(line, "", "registration_missing")
            continue

        resolution = crosswalk.resolve(spec.key, registration)
        if resolution.kind == "ambiguous":
            reject(line, registration, "registration_ambiguous")
            continue
        if resolution.kind == "missing":
            reject(line, registration, "registration_missing")
            continue

        # Approval is keyed by master id and purpose, so it can only be
        # checked once the registration has resolved to exactly one master id.
        if spec.key not in approval.approved_for(resolution.master_id):
            reject(line, registration, "purpose_not_approved")
            continue

        values = [record.get(column.output_name, "").strip() for column in spec.payload]
        code = participant_code(resolution.master_id, scope, key)
        rows.append((code, values))

    return rows, SourceOutcome(
        source=spec.key,
        data_path=str(spec.data_path),
        output_path=str(spec.output_path),
        emitted=len(rows),
        rejects=rejects,
    )


def _write_rows(path: Path, header: Sequence[str], rows: Iterable[Sequence[str]]) -> None:
    """Write a delimited file atomically, so readers never see a partial file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(header)
            writer.writerows(rows)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
