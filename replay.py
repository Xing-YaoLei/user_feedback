#!/usr/bin/env python3
"""Replay warning-time sensor features from a revision stream.

For every warning point T the replay only uses information the platform had
received by T:

* window = [T - 30 minutes, T)  (start inclusive, warning instant exclusive),
  membership is decided by the sample time, not by the receive time;
* for each sample in the window, pick the highest revision number the platform
  had received at or before T;
* if that revision is a retraction, the sample is dropped;
* the remaining samples produce the valid count, mean, gap to the most recent
  valid sample, and the (sample id, revision) pairs that were used.

`--baseline` re-checks a previously generated CSV row by row, which is how a
revision stream that later grows with revisions received after the warning is
verified to leave earlier features untouched.  `--self-check` re-derives every
warning from a shuffled stream and from an independent streaming replay that
applies arrivals in receive order up to the warning instant.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import io
import json
import math
import random
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

WINDOW_MINUTES = 30.0
CSV_SAMPLE_SEPARATOR = "|"

MEAN_DECIMALS = 9
GAP_DECIMALS = 6


class ReplayError(Exception):
    """Bad input data or a violated input invariant."""


# ---------------------------------------------------------------------------
# Column / field aliases
# -------------------------------------------------------------------------

def normalize_key(key: str) -> str:
    return key.strip().lower().replace("_", "").replace("-", "").replace(" ", "")


def _aliases(*names: str) -> tuple[str, ...]:
    return tuple(normalize_key(n) for n in names)


WARNING_ID_ALIASES = _aliases(
    "warning_id", "warningid", "warn_id", "alert_id", "id",
    "预警ID", "预警id", "预警编号", "预警标识",
)
WARNING_TIME_ALIASES = _aliases(
    "warning_time", "warn_time", "alert_time", "time", "timestamp",
    "预警时点", "预警时间", "时点",
)

SAMPLE_ID_ALIASES = _aliases(
    "sample_id", "sampleid", "sample", "sid", "采样ID", "采样id", "采样编号",
)
DEVICE_ALIASES = _aliases(
    "device_id", "deviceid", "device", "device_sn", "sn", "设备号", "设备编号",
)
SAMPLE_TIME_ALIASES = _aliases(
    "sample_time", "sampled_at", "sample_ts", "采样时间",
)
RECEIVED_ALIASES = _aliases(
    "received_at", "receive_time", "received_time", "recv_at",
    "platform_received_at", "平台接收时间", "接收时间",
)
REVISION_ALIASES = _aliases(
    "revision", "rev", "revision_no", "revision_number", "version",
    "修订号", "修订版本",
)
VALUE_ALIASES = _aliases(
    "value", "val", "new_value", "newvalue", "newval",
    "reading", "数值", "新数值", "测量值", "值",
)
RETRACTED_ALIASES = _aliases(
    "retracted", "is_retracted", "withdrawn", "revoked",
    "is_deleted", "deleted",
    "撤回", "撤回标记",
)
STATUS_ALIASES = _aliases(
    "status", "state", "action", "op", "operation", "type", "kind", "event",
)
STATUS_RETRACT_WORDS = {
    "retract", "retracted", "retraction",
    "withdraw", "withdrawn", "revoke", "revoked",
    "delete", "deleted", "deletion",
    "撤回", "撤销", "作废",
}
TRUE_WORDS = STATUS_RETRACT_WORDS | {"true", "1", "yes", "y", "是"}
FALSE_WORDS = {"false", "0", "no", "n", "否", "正常", "valid", "active", "ok",
               "received", "updated", "update"}

FEATURE_COLUMNS = (
    "warning_id",
    "valid_sample_count",
    "mean",
    "last_sample_gap_seconds",
    "sample_ids",
    "revision_numbers",
)


# ---------------------------------------------------------------------------
# Parsing helpers
# -------------------------------------------------------------------------

def parse_timestamp(raw: object, context: str) -> datetime:
    if not isinstance(raw, str) or not raw.strip():
        raise ReplayError(f"{context}: missing or non-text timestamp: {raw!r}")
    text = raw.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        value = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ReplayError(f"{context}: unparseable timestamp {raw!r}") from exc
    if value.tzinfo is None:  # naive timestamps share one implicit timeline
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def parse_revision_number(raw: object, context: str) -> int:
    if isinstance(raw, bool):
        raise ReplayError(f"{context}: revision must be an integer, got a boolean")
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float) and raw.is_integer():
        return int(raw)
    if isinstance(raw, str) and re.fullmatch(r"[+-]?\d+", raw.strip()):
        return int(raw.strip())
    raise ReplayError(f"{context}: revision must be an integer, got {raw!r}")


def parse_value(raw: object, context: str) -> float:
    if isinstance(raw, bool):
        raise ReplayError(f"{context}: numeric value must not be a boolean")
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ReplayError(f"{context}: value must be numeric, got {raw!r}") from exc
    if not math.isfinite(value):
        raise ReplayError(f"{context}: value must be finite, got {raw!r}")
    return value


def parse_flag(raw: object, context: str) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        if raw == 0:
            return False
        if raw == 1:
            return True
    if isinstance(raw, str):
        word = normalize_key(raw)
        if word in TRUE_WORDS:
            return True
        if word in FALSE_WORDS:
            return False
    raise ReplayError(f"{context}: cannot interpret retraction marker {raw!r}")


def _find_field(obj: dict, aliases: tuple[str, ...]) -> object | None:
    """Return the first present alias' value (None when the alias is absent)."""
    normalized = {}
    for key, val in obj.items():
        if isinstance(key, str):
            normalized.setdefault(normalize_key(key), val)
    for alias in aliases:
        if alias in normalized:
            return normalized[alias]
    return None


def _has_field(obj: dict, aliases: tuple[str, ...]) -> bool:
    return any(
        isinstance(key, str) and normalize_key(key) in aliases for key in obj
    )


def _as_text(raw: object, context: str) -> str:
    if isinstance(raw, bool):
        raise ReplayError(f"{context}: expected text, got a boolean")
    if isinstance(raw, (int, float)):
        return str(raw)
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    raise ReplayError(f"{context}: missing or empty text field")


# -------------------------------------------------------------------------
# Input records
# -------------------------------------------------------------------------

@dataclass(frozen=True)
class Warning:
    warning_id: str
    warning_time: datetime


@dataclass(frozen=True)
class Revision:
    sample_id: str
    device: str | None
    sample_time: datetime
    received_at: datetime
    revision: int
    value: float | None
    retracted: bool
    line: int


@dataclass
class Sample:
    sample_id: str
    device: str | None
    sample_time: datetime
    revisions: list[Revision]


@dataclass(frozen=True)
class Feature:
    warning_id: str
    warning_time: datetime
    valid_sample_count: int
    mean: float | None
    last_sample_gap_seconds: float | None
    samples: tuple[tuple[str, int], ...]  # (sample_id, revision) sorted by time

    def signature(self) -> tuple:
        return (
            self.warning_id,
            self.valid_sample_count,
            format_number(self.mean, MEAN_DECIMALS),
            format_number(self.last_sample_gap_seconds, GAP_DECIMALS),
            tuple(self.samples),
        )


# -------------------------------------------------------------------------
# Warning CSV
# -------------------------------------------------------------------------

def _resolve_column(
    fieldnames: list[str],
    aliases: tuple[str, ...],
    label: str,
    override: str | None = None,
) -> str:
    if override is not None:
        for name in fieldnames:
            if name == override or normalize_key(name) == normalize_key(override):
                return name
        raise ReplayError(f"warning CSV: column {override!r} for {label} not found")
    ranked = sorted(
        (aliases.index(normalize_key(name)), name)
        for name in fieldnames
        if normalize_key(name) in aliases
    )
    if not ranked:
        raise ReplayError(
            f"warning CSV: no column for {label}; headers are {fieldnames!r}"
        )
    best_rank = ranked[0][0]
    best = [name for rank, name in ranked if rank == best_rank]
    if len(best) > 1:
        raise ReplayError(
            f"warning CSV: columns {best!r} are equally good matches for {label}; "
            "use --id-col/--time-col to disambiguate"
        )
    return best[0]


def load_warnings(
    path: str | Path,
    *,
    delimiter: str = ",",
    id_col: str | None = None,
    time_col: str | None = None,
) -> list[Warning]:
    text = Path(path).read_text(encoding="utf-8-sig")
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    if reader.fieldnames is None:
        raise ReplayError("warning CSV: missing header row")
    fieldnames = [name.strip() if name else "" for name in reader.fieldnames]
    reader.fieldnames = fieldnames
    id_column = _resolve_column(fieldnames, WARNING_ID_ALIASES, "warning id", id_col)
    time_column = _resolve_column(
        fieldnames, WARNING_TIME_ALIASES, "warning time", time_col
    )

    warnings: list[Warning] = []
    seen_ids: dict[str, int] = {}
    for line_no, row in enumerate(reader, start=2):
        if not any((row.get(name) or "").strip() for name in fieldnames):
            continue  # blank padding line
        context = f"warning CSV line {line_no}"
        warning_id = _as_text(row.get(id_column), f"{context}: warning id")
        warning_time = parse_timestamp(row.get(time_column), f"{context}: warning time")
        if warning_id in seen_ids:
            raise ReplayError(
                f"{context}: duplicate warning id {warning_id!r} "
                f"(first seen on line {seen_ids[warning_id]})"
            )
        seen_ids[warning_id] = line_no
        warnings.append(Warning(warning_id, warning_time))
    return warnings


# -------------------------------------------------------------------------
# Revision JSONL
# -------------------------------------------------------------------------

def _revision_from_object(obj: object, line_no: int, source: str) -> Revision:
    context = f"{source} line {line_no}"
    if not isinstance(obj, dict):
        raise ReplayError(f"{context}: revision must be a JSON object")

    sample_id = _as_text(_find_field(obj, SAMPLE_ID_ALIASES), f"{context}: sample id")
    sample_time = parse_timestamp(
        _find_field(obj, SAMPLE_TIME_ALIASES), f"{context}: sample time"
    )
    received_at = parse_timestamp(
        _find_field(obj, RECEIVED_ALIASES), f"{context}: received time"
    )
    revision = parse_revision_number(
        _find_field(obj, REVISION_ALIASES), f"{context}: revision"
    )

    device_raw = _find_field(obj, DEVICE_ALIASES)
    device = _as_text(device_raw, f"{context}: device") if device_raw is not None else None

    status_raw = _find_field(obj, STATUS_ALIASES)
    status_retract = (
        isinstance(status_raw, str)
        and normalize_key(status_raw) in STATUS_RETRACT_WORDS
    )
    retracted = status_retract
    if _has_field(obj, RETRACTED_ALIASES):
        marker = _find_field(obj, RETRACTED_ALIASES)
        if marker is not None:  # an explicit marker wins over the status column
            retracted = parse_flag(marker, f"{context}: retraction marker")

    value: float | None = None
    if not retracted:
        raw_value = _find_field(obj, VALUE_ALIASES)
        if raw_value is None:
            raise ReplayError(
                f"{context}: revision has neither a value nor a retraction marker"
            )
        value = parse_value(raw_value, f"{context}: value")

    return Revision(
        sample_id=sample_id,
        device=device,
        sample_time=sample_time,
        received_at=received_at,
        revision=revision,
        value=value,
        retracted=retracted,
        line=line_no,
    )


def parse_revisions(text: str, source: str = "revisions") -> dict[str, Sample]:
    # Keyed by (sample id, revision number) so re-deliveries collapse first.
    canonical: dict[tuple[str, int], Revision] = {}

    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            obj = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise ReplayError(f"{source} line {line_no}: invalid JSON: {exc}") from exc
        revision = _revision_from_object(obj, line_no, source)

        key = (revision.sample_id, revision.revision)
        previous = canonical.get(key)
        if previous is not None:
            if (
                previous.sample_time != revision.sample_time
                or previous.value != revision.value
                or previous.retracted != revision.retracted
                or (
                    previous.device is not None
                    and revision.device is not None
                    and previous.device != revision.device
                )
            ):
                raise ReplayError(
                    f"{source} line {line_no}: revision {revision.revision} of sample "
                    f"{revision.sample_id!r} conflicts with line {previous.line}"
                )
            # Same content delivered twice: the first arrival decides whether the
            # revision was visible, so keep the earliest receive time.
            if revision.received_at < previous.received_at:
                canonical[key] = revision
            continue
        canonical[key] = revision

    samples: dict[str, Sample] = {}
    for revision in sorted(canonical.values(), key=lambda item: item.line):
        sample = samples.get(revision.sample_id)
        if sample is None:
            samples[revision.sample_id] = Sample(
                sample_id=revision.sample_id,
                device=revision.device,
                sample_time=revision.sample_time,
                revisions=[revision],
            )
            continue
        if sample.sample_time != revision.sample_time:
            raise ReplayError(
                f"{source} line {revision.line}: sample {revision.sample_id!r} has "
                f"sample time {revision.sample_time.isoformat()} but earlier "
                f"revisions say {sample.sample_time.isoformat()} "
                "(sample time is fixed per sample)"
            )
        if (
            sample.device is not None
            and revision.device is not None
            and sample.device != revision.device
        ):
            raise ReplayError(
                f"{source} line {revision.line}: sample {revision.sample_id!r} has "
                f"device {revision.device!r} but earlier revisions say "
                f"{sample.device!r} (device is fixed per sample)"
            )
        if sample.device is None:
            sample.device = revision.device
        sample.revisions.append(revision)

    for sample in samples.values():
        sample.revisions.sort(key=lambda revision: revision.revision)
    return samples


# -------------------------------------------------------------------------
# Replay
# -------------------------------------------------------------------------

def _visible_revision(sample: Sample, deadline: datetime) -> Revision | None:
    """Highest revision number received at or before `deadline`."""
    for revision in reversed(sample.revisions):  # sorted ascending by number
        if revision.received_at <= deadline:
            return revision
    return None


def build_features(
    warnings: list[Warning],
    samples: dict[str, Sample],
    window: timedelta = timedelta(minutes=WINDOW_MINUTES),
) -> list[Feature]:
    # Sample time is fixed per sample id, so one timeline entry per sample.
    timeline = sorted((sample.sample_time, sample.sample_id) for sample in samples.values())

    features: list[Feature] = []
    for warning in warnings:  # preserve the warning file's order
        start = warning.warning_time - window
        low = bisect.bisect_left(timeline, (start, ""))
        high = bisect.bisect_left(timeline, (warning.warning_time, ""))

        chosen: list[tuple[datetime, str, int, float]] = []
        for index in range(low, high):
            sample_time, sample_id = timeline[index]
            revision = _visible_revision(samples[sample_id], warning.warning_time)
            if revision is None or revision.retracted:
                continue
            chosen.append((sample_time, sample_id, revision.revision, revision.value))

        count = len(chosen)
        if count:
            mean = math.fsum(item[3] for item in chosen) / count
            gap = (warning.warning_time - chosen[-1][0]).total_seconds()
            pairs = tuple((item[1], item[2]) for item in chosen)
        else:
            mean = None
            gap = None
            pairs = ()

        features.append(
            Feature(
                warning_id=warning.warning_id,
                warning_time=warning.warning_time,
                valid_sample_count=count,
                mean=mean,
                last_sample_gap_seconds=gap,
                samples=pairs,
            )
        )
    return features


# -------------------------------------------------------------------------
# Formatting / output
# -------------------------------------------------------------------------

def format_number(value: float | None, decimals: int) -> str:
    if value is None:
        return ""
    text = f"{value:.{decimals}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("", "-0"):
        return "0"
    return text


def _rounded(value: float | None, decimals: int) -> float | None:
    if value is None:
        return None
    rounded = round(value, decimals)
    return 0.0 if rounded == 0 else rounded


def feature_csv_record(feature: Feature) -> dict[str, str]:
    return {
        "warning_id": feature.warning_id,
        "valid_sample_count": str(feature.valid_sample_count),
        "mean": format_number(feature.mean, MEAN_DECIMALS),
        "last_sample_gap_seconds": format_number(
            feature.last_sample_gap_seconds, GAP_DECIMALS
        ),
        "sample_ids": CSV_SAMPLE_SEPARATOR.join(
            sample_id for sample_id, _ in feature.samples
        ),
        "revision_numbers": CSV_SAMPLE_SEPARATOR.join(
            str(revision) for _, revision in feature.samples
        ),
    }


def feature_json_record(feature: Feature) -> dict:
    return {
        "warning_id": feature.warning_id,
        "valid_sample_count": feature.valid_sample_count,
        "mean": _rounded(feature.mean, MEAN_DECIMALS),
        "last_sample_gap_seconds": _rounded(
            feature.last_sample_gap_seconds, GAP_DECIMALS
        ),
        "samples": [
            {"sample_id": sample_id, "revision": revision}
            for sample_id, revision in feature.samples
        ],
    }


def render_features(features: list[Feature], output_format: str) -> str:
    buffer = io.StringIO()
    if output_format == "csv":
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(FEATURE_COLUMNS)
        for feature in features:
            for sample_id, _ in feature.samples:
                if CSV_SAMPLE_SEPARATOR in sample_id:
                    raise ReplayError(
                        f"sample id {sample_id!r} contains {CSV_SAMPLE_SEPARATOR!r}, "
                        "which is the CSV list separator; use --format json instead"
                    )
            record = feature_csv_record(feature)
            writer.writerow([record[column] for column in FEATURE_COLUMNS])
    elif output_format == "jsonl":
        for feature in features:
            buffer.write(json.dumps(feature_json_record(feature), ensure_ascii=False))
            buffer.write("\n")
    elif output_format == "json":
        json.dump(
            [feature_json_record(feature) for feature in features],
            buffer,
            ensure_ascii=False,
            indent=2,
        )
        buffer.write("\n")
    else:  # pragma: no cover - argparse restricts the choices
        raise ReplayError(f"unknown output format {output_format!r}")
    return buffer.getvalue()


# -------------------------------------------------------------------------
# Verification helpers
# -------------------------------------------------------------------------

def _equal_value(column: str, left: str, right: str) -> bool:
    """Compare one output cell, tolerating pure formatting differences."""
    if column in ("mean", "last_sample_gap_seconds"):
        if not left or not right:
            return left == right
        try:
            return float(left) == float(right)
        except ValueError:
            return left == right
    if column == "valid_sample_count":
        try:
            return int(left) == int(right)
        except ValueError:
            return left == right
    return left == right


def verify_against_baseline(
    features: list[Feature], baseline_text: str, source: str = "baseline",
    delimiter: str = ",",
) -> list[str]:
    """Compare fresh features with an earlier CSV, one warning id at a time."""
    reader = csv.DictReader(io.StringIO(baseline_text), delimiter=delimiter)
    if reader.fieldnames is None:
        raise ReplayError(f"baseline {source}: missing header row")
    fieldnames = [name.strip() if name else "" for name in reader.fieldnames]
    reader.fieldnames = fieldnames  # so row keys match the stripped names
    missing = [column for column in FEATURE_COLUMNS if column not in fieldnames]
    if missing:
        raise ReplayError(f"baseline {source}: missing columns {missing!r}")
    baseline: dict[str, dict[str, str]] = {}
    for line_no, row in enumerate(reader, start=2):
        if not any((row.get(column) or "").strip() for column in FEATURE_COLUMNS):
            continue
        warning_id = (row.get("warning_id") or "").strip()
        if not warning_id:
            raise ReplayError(f"baseline {source} line {line_no}: empty warning id")
        if warning_id in baseline:
            raise ReplayError(
                f"baseline {source} line {line_no}: duplicate warning id "
                f"{warning_id!r}"
            )
        baseline[warning_id] = {
            column: (row.get(column) or "").strip() for column in FEATURE_COLUMNS
        }

    problems: list[str] = []
    current: dict[str, dict[str, str]] = {}
    for feature in features:
        current[feature.warning_id] = feature_csv_record(feature)

    for warning_id in sorted(set(baseline) | set(current)):
        if warning_id not in baseline:
            problems.append(f"{warning_id}: new warning not present in baseline")
            continue
        if warning_id not in current:
            problems.append(f"{warning_id}: warning missing from fresh replay")
            continue
        old, new = baseline[warning_id], current[warning_id]
        changed = [
            f"{column}: {old[column]!r} -> {new[column]!r}"
            for column in FEATURE_COLUMNS
            if not _equal_value(column, old[column], new[column])
        ]
        if changed:
            problems.append(f"{warning_id}: " + "; ".join(changed))
    return problems


def verify_order_independence(
    warnings: list[Warning],
    text: str,
    source: str,
    window: timedelta,
    features: list[Feature],
    seed: int = 20261113,
) -> list[str]:
    lines = text.splitlines()
    random.Random(seed).shuffle(lines)
    shuffled = parse_revisions("\n".join(lines), source=f"{source} (shuffled)")
    replayed = build_features(warnings, shuffled, window)
    expected = [feature.signature() for feature in features]
    actual = [feature.signature() for feature in replayed]
    if actual == expected:
        return []
    differing = [
        left.warning_id
        for left, right in zip(features, replayed)
        if left.signature() != right.signature()
    ]
    if len(actual) != len(expected):
        return ["shuffled replay produced a different number of warnings"]
    return [f"{warning_id}: shuffled replay differs" for warning_id in differing]


def _streamed_state(
    samples: dict[str, Sample], deadline: datetime
) -> dict[str, Revision]:
    """Independent re-derivation: highest visible revision per sample.

    Written differently from `build_features` on purpose — plain filtering plus
    `max` instead of a bisect over a sorted timeline — so a bug in one path is
    unlikely to be mirrored in the other.
    """
    state: dict[str, Revision] = {}
    for sample in samples.values():
        visible = [
            revision
            for revision in sample.revisions
            if revision.received_at <= deadline
        ]
        if visible:
            state[sample.sample_id] = max(
                visible, key=lambda revision: revision.revision
            )
    return state


def _reference_feature(
    warning: Warning, samples: dict[str, Sample], window: timedelta
) -> Feature:
    """Naive, deliberately separate implementation used only for checking."""
    state = _streamed_state(samples, warning.warning_time)
    start = warning.warning_time - window
    visible = []
    for revision in state.values():
        if revision.retracted:
            continue
        if start <= revision.sample_time < warning.warning_time:
            visible.append((revision.sample_time, revision.sample_id, revision))
    if not visible:
        return Feature(
            warning.warning_id, warning.warning_time, 0, None, None, ()
        )
    visible.sort(key=lambda item: (item[0], item[1]))
    values = [item[2].value for item in visible]
    return Feature(
        warning_id=warning.warning_id,
        warning_time=warning.warning_time,
        valid_sample_count=len(visible),
        mean=math.fsum(values) / len(values),
        last_sample_gap_seconds=(
            warning.warning_time - visible[-1][0]
        ).total_seconds(),
        samples=tuple((item[1], item[2].revision) for item in visible),
    )


def verify_incremental(
    warnings: list[Warning],
    samples: dict[str, Sample],
    window: timedelta,
    features: list[Feature],
) -> list[str]:
    """Every warning must be reproducible using only revisions visible at T."""
    problems: list[str] = []
    for warning, feature in zip(warnings, features):
        reference = _reference_feature(warning, samples, window)
        if reference.signature() != feature.signature():
            problems.append(
                f"{warning.warning_id}: streaming replay disagrees "
                f"(got {feature.signature()!r}, expected {reference.signature()!r})"
            )
    return problems


# -------------------------------------------------------------------------
# CLI
# -------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="replay.py",
        description=(
            "Replay warning-time sensor features from a revision stream. "
            "Window is [T-30min, T); each sample uses the highest revision "
            "received by T, and a visible retraction drops the sample."
        ),
    )
    parser.add_argument("--warnings", required=True, help="warning-point CSV")
    parser.add_argument("--revisions", required=True, help="revision stream JSONL")
    parser.add_argument(
        "-o", "--output", help="output file (default: stdout)"
    )
    parser.add_argument(
        "--format", choices=("csv", "json", "jsonl"), default="csv",
        help="output format (default: csv)",
    )
    parser.add_argument(
        "--delimiter", default=",",
        help="warning CSV delimiter (default: comma)",
    )
    parser.add_argument(
        "--id-col", help="override the warning id column name"
    )
    parser.add_argument(
        "--time-col", help="override the warning time column name"
    )
    parser.add_argument(
        "--window-minutes", type=float, default=WINDOW_MINUTES,
        help="window length in minutes (default: 30)",
    )
    parser.add_argument(
        "--baseline",
        help=(
            "previously generated CSV to verify row by row; a revision added "
            "after a warning must not change that warning's row"
        ),
    )
    parser.add_argument(
        "--self-check", action="store_true",
        help=(
            "re-derive all features from a shuffled stream and from an "
            "independent streaming replay, and fail on any difference"
        ),
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="suppress diagnostics")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.window_minutes <= 0:
        parser.error("--window-minutes must be positive")

    try:
        warnings = load_warnings(
            args.warnings,
            delimiter=args.delimiter,
            id_col=args.id_col,
            time_col=args.time_col,
        )
        revisions_path = Path(args.revisions)
        revisions_text = revisions_path.read_text(encoding="utf-8-sig")
        samples = parse_revisions(revisions_text, source=str(revisions_path))
        window = timedelta(minutes=args.window_minutes)
        features = build_features(warnings, samples, window)

        # Read the baseline before writing, so `-o` may point at the baseline file.
        baseline_text = None
        if args.baseline:
            baseline_path = Path(args.baseline)
            baseline_text = baseline_path.read_text(encoding="utf-8-sig")

        # Verify before writing so a failed check never clobbers a baseline file.
        failures: list[str] = []
        if baseline_text is not None:
            failures.extend(verify_against_baseline(
                features,
                baseline_text,
                source=str(args.baseline),
                delimiter=args.delimiter,
            ))
        if args.self_check:
            failures.extend(verify_order_independence(
                warnings, revisions_text, str(revisions_path), window, features,
            ))
            failures.extend(verify_incremental(warnings, samples, window, features))

        if failures:
            stream = sys.stderr
            print(f"verification failed ({len(failures)} problem(s)):", file=stream)
            for problem in failures:
                print(f"  {problem}", file=stream)
            if args.output:
                print(
                    f"not writing {args.output}: verification failed",
                    file=stream,
                )
            return 1

        rendered = render_features(features, args.format)
        if args.output:
            Path(args.output).write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)

        if not args.quiet:
            revision_count = sum(len(sample.revisions) for sample in samples.values())
            stream = sys.stderr
            print(
                f"replayed {len(features)} warning(s) from {revision_count} revision(s) "
                f"of {len(samples)} sample(s)",
                file=stream,
            )
            if args.self_check:
                print(
                    "self-check: order-independent and incremental replay OK",
                    file=stream,
                )
            if args.baseline:
                print("baseline: all warnings match the previous run", file=stream)
        return 0
    except ReplayError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
