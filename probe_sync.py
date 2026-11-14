#!/usr/bin/env python3
"""Calibrate vibration-probe peaks onto controller UTC time and attribute them
to process intervals.

Three inputs:

  * probe CSV -- one row per vibration sample:
      ``device_id, session_id, count, amplitude``
    ``count`` is the probe-local counter and is reset to zero on reboot, so it
    is only meaningful inside one ``(device_id, session_id)`` pair.

  * sync CSV -- one row per correspondence point:
      ``device_id, session_id, count, utc_us``
    Each device session gets several ``(count, utc_us)`` anchor points.

  * process JSON -- one object per process:
      ``{"device_id": ..., "process_id": ..., "start_utc_us": ..., "end_utc_us": ...}``
    ``utc_us`` is a Unix epoch timestamp in microseconds.  Process intervals on
    the same device never overlap.

Calibration rule: a sample whose counter is bracketed by two consecutive
anchor points of its own session is mapped onto UTC by linear interpolation
between those two anchors.  Interpolation is exact (rational) and never
rounded, so a sample sitting exactly on a process edge is classified as the
process boundary rule requires.  A sample outside the anchored counter range
of its session -- or in a session with too few anchors to interpolate -- is
reported as uncalibrated.  A session whose anchors give two different times
for the same counter, or whose time goes backwards as the counter increases,
is rejected as a whole and reported separately; none of its samples are
calibrated.

Attribution uses the full-precision interpolated timestamp and half-open
process intervals ``[start, end)``.  For every process the report carries the
number of calibrated samples inside it and the maximum amplitude.  Ties on the
maximum amplitude are broken by the earliest calibrated time, then by input
row order.  Every peak record shows the original sample (input row number,
device, session, raw count, amplitude) and its calibrated timestamp.  Samples
that are calibrated but fall into no process are listed separately.

Overlapping process intervals on one device are an input error and abort the
run, since a sample would otherwise have no single owning process.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from bisect import bisect_right
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Iterable, Sequence

PROBE_COLUMNS = ("device_id", "session_id", "count", "amplitude")
SYNC_COLUMNS = ("device_id", "session_id", "count", "utc_us")


# --------------------------------------------------------------------------
# Input
# --------------------------------------------------------------------------


class InputError(ValueError):
    """Raised when an input file cannot be interpreted."""


def _parse_int(text: str, what: str, where: str) -> int:
    try:
        return int(text)
    except ValueError:
        raise InputError(f"{where}: cannot parse {what} {text!r} as an integer") from None


def _parse_float(text: str, what: str, where: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise InputError(f"{where}: cannot parse {what} {text!r} as a number") from None
    if not math.isfinite(value):
        raise InputError(f"{where}: {what} {text!r} is not a finite number")
    return value


def _iter_csv_rows(path: str, columns: Sequence[str]) -> Iterable[tuple[int, list[str]]]:
    """Yield ``(line_number, fields)`` for data lines, skipping blanks and comments."""
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        for fields in reader:
            number = reader.line_num
            fields = [part.strip() for part in fields]
            if not fields or not any(fields) or fields[0].startswith("#"):
                continue
            if len(fields) != len(columns):
                raise InputError(
                    f"{path}:{number}: expected {len(columns)} fields "
                    f"({', '.join(columns)}), got {len(fields)}"
                )
            if [f.lower() for f in fields] == [c.lower() for c in columns]:
                continue  # header line
            yield number, fields


@dataclass(frozen=True)
class ProbeSample:
    row: int  # 1-based input line number, used for stable tie-breaking
    device_id: str
    session_id: str
    count: int
    amplitude: float


@dataclass(frozen=True)
class SyncPoint:
    row: int
    device_id: str
    session_id: str
    count: int
    utc_us: int


@dataclass(frozen=True)
class Process:
    index: int  # position in the input file, for stable output ordering
    device_id: str
    process_id: str
    start_utc_us: int
    end_utc_us: int

    def contains(self, utc_us: Fraction) -> bool:
        return self.start_utc_us <= utc_us < self.end_utc_us


def read_probe_csv(path: str) -> list[ProbeSample]:
    samples = []
    for number, fields in _iter_csv_rows(path, PROBE_COLUMNS):
        device_id, session_id, count, amplitude = fields
        samples.append(
            ProbeSample(
                row=number,
                device_id=device_id,
                session_id=session_id,
                count=_parse_int(count, "count", f"{path}:{number}"),
                amplitude=_parse_float(amplitude, "amplitude", f"{path}:{number}"),
            )
        )
    return samples


def read_sync_csv(path: str) -> list[SyncPoint]:
    points = []
    for number, fields in _iter_csv_rows(path, SYNC_COLUMNS):
        device_id, session_id, count, utc_us = fields
        points.append(
            SyncPoint(
                row=number,
                device_id=device_id,
                session_id=session_id,
                count=_parse_int(count, "count", f"{path}:{number}"),
                utc_us=_parse_int(utc_us, "utc_us", f"{path}:{number}"),
            )
        )
    return points


def _coerce_id(value: object, what: str, where: str) -> str:
    """Accept a JSON string or integer and normalise it to a string id."""
    if isinstance(value, bool) or value is None:
        raise InputError(f"{where}: {what} must be a string or integer")
    if isinstance(value, (str, int)):
        return str(value)
    raise InputError(f"{where}: {what} must be a string or integer, got {type(value).__name__}")


def _coerce_int(value: object, what: str, where: str) -> int:
    """Accept a JSON integer, an integral float, or a decimal string."""
    if isinstance(value, bool):
        raise InputError(f"{where}: {what} must be an integer, got a boolean")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not value.is_integer():
            raise InputError(f"{where}: {what} {value!r} is not an integer")
        return int(value)
    if isinstance(value, str):
        return _parse_int(value, what, where)
    raise InputError(f"{where}: {what} must be an integer, got {type(value).__name__}")


def read_process_json(path: str) -> list[Process]:
    with open(path, "r", encoding="utf-8-sig") as handle:
        try:
            payload = json.load(handle)
        except json.JSONDecodeError as exc:
            raise InputError(f"{path}: invalid JSON: {exc}") from None

    if isinstance(payload, dict):
        for key in ("processes", "items", "data"):
            if isinstance(payload.get(key), list):
                payload = payload[key]
                break
        else:
            payload = [payload]

    if not isinstance(payload, list):
        raise InputError(f"{path}: expected a list of process objects")

    processes = []
    for position, item in enumerate(payload):
        where = f"{path}: process #{position + 1}"
        if not isinstance(item, dict):
            raise InputError(f"{where}: expected an object, got {type(item).__name__}")
        missing = [
            key
            for key in ("device_id", "process_id", "start_utc_us", "end_utc_us")
            if key not in item
        ]
        if missing:
            raise InputError(f"{where}: missing field(s) {', '.join(missing)}")
        device_id = _coerce_id(item["device_id"], "device_id", where)
        process_id = _coerce_id(item["process_id"], "process_id", where)
        start = _coerce_int(item["start_utc_us"], "start_utc_us", where)
        end = _coerce_int(item["end_utc_us"], "end_utc_us", where)
        if start >= end:
            raise InputError(f"{where}: start_utc_us must be before end_utc_us")
        processes.append(Process(position, device_id, process_id, start, end))
    return processes


# --------------------------------------------------------------------------
# Session calibration
# --------------------------------------------------------------------------


@dataclass
class SessionCalibration:
    device_id: str
    session_id: str
    anchors: list[tuple[int, int]] = field(default_factory=list)
    issue: str | None = None  # non-None => the whole session is rejected
    anchor_count: int = 0  # sync rows seen, valid or not


def build_session_calibrations(
    points: Sequence[SyncPoint],
) -> dict[tuple[str, str], SessionCalibration]:
    """Group sync points per device session and validate their ordering."""
    grouped: dict[tuple[str, str], list[SyncPoint]] = {}
    for point in points:
        grouped.setdefault((point.device_id, point.session_id), []).append(point)

    result: dict[tuple[str, str], SessionCalibration] = {}
    for key, session_points in grouped.items():
        calibration = SessionCalibration(*key, anchor_count=len(session_points))

        # Same counter, different time -> the counter does not identify a moment.
        by_count: dict[int, int] = {}
        first_row: dict[int, int] = {}
        for point in session_points:
            seen = by_count.get(point.count)
            if seen is not None and seen != point.utc_us:
                calibration.issue = (
                    f"count {point.count} maps to two different times "
                    f"({seen} us at input row {first_row[point.count]} and "
                    f"{point.utc_us} us at input row {point.row})"
                )
                break
            by_count.setdefault(point.count, point.utc_us)
            first_row.setdefault(point.count, point.row)
        if calibration.issue:
            result[key] = calibration
            continue

        # Time must not run backwards as the counter grows.
        ordered = sorted(by_count.items())
        for (c0, t0), (c1, t1) in zip(ordered, ordered[1:]):
            if t1 < t0:
                calibration.issue = (
                    f"time runs backwards as count increases: count {c0} -> {t0} us, "
                    f"count {c1} -> {t1} us"
                )
                break
        if calibration.issue:
            result[key] = calibration
            continue

        calibration.anchors = ordered
        result[key] = calibration
    return result


def calibrate_count(calibration: SessionCalibration | None, count: int) -> Fraction | None:
    """Interpolate one counter value onto UTC microseconds.

    Returns ``None`` when the session is rejected, unknown, or has too few
    anchors, and when the count lies outside the anchored range (no pair of
    adjacent sync points brackets it).  The result is exact, never rounded.
    """
    if calibration is None or calibration.issue:
        return None
    anchors = calibration.anchors
    if len(anchors) < 2 or count < anchors[0][0] or count > anchors[-1][0]:
        return None
    # Index of the last anchor with a count <= this sample's count.  Clamped
    # to the last pair so a sample exactly at the final anchor still interpolates.
    pos = min(bisect_right(anchors, (count, math.inf)) - 1, len(anchors) - 2)
    c0, t0 = anchors[pos]
    c1, t1 = anchors[pos + 1]
    return Fraction(t0) + Fraction((t1 - t0) * (count - c0), c1 - c0)


# --------------------------------------------------------------------------
# Attribution
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class SampleRecord:
    row: int
    device_id: str
    session_id: str
    count: int
    amplitude: float
    utc_us: Fraction


@dataclass
class ProcessResult:
    process: Process
    valid_samples: int = 0
    peak: SampleRecord | None = None


@dataclass
class SessionSummary:
    device_id: str
    session_id: str
    status: str  # "ok", "rejected", "insufficient-anchors", "no-anchors"
    anchors: int
    issue: str | None = None
    uncalibrated_samples: int = 0


@dataclass
class AnalysisReport:
    processes: list[ProcessResult]
    unlocated: list[SampleRecord]
    uncalibrated: list[tuple[ProbeSample, str]]
    sessions: list[SessionSummary]


@dataclass
class DeviceProcessIndex:
    """Processes of one device, sorted by start, for fast time lookup.

    Each entry pairs the process with its position in the caller's process
    sequence, so a match maps back to the right result slot even when process
    indices are not unique.
    """

    entries: list[tuple[int, Process]] = field(default_factory=list)
    starts: list[int] = field(default_factory=list)

    def add(self, position: int, process: Process) -> None:
        self.entries.append((position, process))

    def finish(self) -> None:
        # Intervals on one device never overlap, so sorting by start is enough.
        self.entries.sort(key=lambda e: (e[1].start_utc_us, e[1].end_utc_us, e[1].index))
        for (_, earlier), (_, later) in zip(self.entries, self.entries[1:]):
            if later.start_utc_us < earlier.end_utc_us:
                raise InputError(
                    f"processes on device {earlier.device_id!r} overlap: "
                    f"{earlier.process_id!r} [{earlier.start_utc_us}, {earlier.end_utc_us}) "
                    f"and {later.process_id!r} [{later.start_utc_us}, {later.end_utc_us})"
                )
        self.starts = [process.start_utc_us for _, process in self.entries]

    def find(self, utc_us: Fraction) -> tuple[int, Process] | None:
        pos = bisect_right(self.starts, utc_us) - 1
        if pos < 0:
            return None
        position, process = self.entries[pos]
        return (position, process) if process.contains(utc_us) else None


def analyze(
    samples: Sequence[ProbeSample],
    points: Sequence[SyncPoint],
    processes: Sequence[Process],
) -> AnalysisReport:
    calibrations = build_session_calibrations(points)

    results = [ProcessResult(process) for process in processes]
    by_device: dict[str, DeviceProcessIndex] = {}
    for position, process in enumerate(processes):
        by_device.setdefault(process.device_id, DeviceProcessIndex()).add(position, process)
    for index in by_device.values():
        index.finish()

    unlocated: list[SampleRecord] = []
    uncalibrated: list[tuple[ProbeSample, str]] = []
    session_counts: dict[tuple[str, str], int] = {}

    for sample in samples:
        key = (sample.device_id, sample.session_id)
        calibration = calibrations.get(key)
        utc_us = calibrate_count(calibration, sample.count)

        if utc_us is None:
            reason = _uncalibrated_reason(calibration, sample)
            uncalibrated.append((sample, reason))
            session_counts[key] = session_counts.get(key, 0) + 1
            continue

        record = SampleRecord(
            row=sample.row,
            device_id=sample.device_id,
            session_id=sample.session_id,
            count=sample.count,
            amplitude=sample.amplitude,
            utc_us=utc_us,
        )
        device_index = by_device.get(sample.device_id)
        matched = device_index.find(utc_us) if device_index else None
        if matched is None:
            unlocated.append(record)
            continue

        position, _ = matched
        results[position].valid_samples += 1
        if _beats(record, results[position].peak):
            results[position].peak = record

    sessions = [
        _summarize_session(device_id, session_id, calibrations.get((device_id, session_id)))
        for device_id, session_id in sorted(set(calibrations) | set(session_counts))
    ]
    for summary in sessions:
        summary.uncalibrated_samples = session_counts.get((summary.device_id, summary.session_id), 0)

    return AnalysisReport(
        processes=results,
        unlocated=unlocated,
        uncalibrated=uncalibrated,
        sessions=sessions,
    )


def _summarize_session(
    device_id: str, session_id: str, calibration: SessionCalibration | None
) -> SessionSummary:
    if calibration is None:
        return SessionSummary(device_id, session_id, "no-anchors", 0, None, 0)
    if calibration.issue:
        return SessionSummary(
            device_id, session_id, "rejected", calibration.anchor_count, calibration.issue, 0
        )
    if len(calibration.anchors) < 2:
        return SessionSummary(
            device_id, session_id, "insufficient-anchors", calibration.anchor_count, None, 0
        )
    return SessionSummary(device_id, session_id, "ok", calibration.anchor_count, None, 0)


def _beats(candidate: SampleRecord, current: SampleRecord | None) -> bool:
    """True when ``candidate`` should replace ``current`` as the peak.

    Highest amplitude wins; ties go to the earliest calibrated time, then to
    the earliest input row.
    """
    if current is None:
        return True
    key = (candidate.amplitude, -candidate.utc_us, -candidate.row)
    return key > (current.amplitude, -current.utc_us, -current.row)


def _uncalibrated_reason(calibration: SessionCalibration | None, sample: ProbeSample) -> str:
    if calibration is None:
        return "no sync points for this device session"
    if calibration.issue:
        return "session rejected"
    anchors = calibration.anchors
    if len(anchors) < 2:
        return f"only {len(anchors)} sync point(s); interpolation needs two"
    if sample.count < anchors[0][0]:
        return f"count below calibrated range (first anchor count {anchors[0][0]})"
    if sample.count > anchors[-1][0]:
        return f"count above calibrated range (last anchor count {anchors[-1][0]})"
    return "no adjacent sync points bracket this count"


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


def format_utc(value: Fraction) -> str:
    """Exact rendering of an unrounded calibrated timestamp."""
    if value.denominator == 1:
        return str(value.numerator)
    return f"{value.numerator}/{value.denominator} (approx {float(value):.9f})"


def format_amplitude(value: float) -> str:
    """Render an amplitude without trailing float noise, preserving integers."""
    return f"{value:.12g}"


def format_report(report: AnalysisReport) -> str:
    lines: list[str] = ["Processes"]
    for result in report.processes:
        process = result.process
        peak = result.peak
        max_amplitude = "none" if peak is None else format_amplitude(peak.amplitude)
        lines.append(
            f"  device={process.device_id} process={process.process_id} "
            f"window=[{process.start_utc_us}, {process.end_utc_us}) "
            f"valid_samples={result.valid_samples} max_amplitude={max_amplitude}"
        )
        if peak is None:
            lines.append("    peak=none")
        else:
            lines.append(
                f"    peak amplitude={format_amplitude(peak.amplitude)} "
                f"calibrated_utc_us={format_utc(peak.utc_us)} "
                f"device={peak.device_id} session={peak.session_id} "
                f"count={peak.count} input_row={peak.row}"
            )

    lines.append(f"Unlocated samples ({len(report.unlocated)})")
    for record in report.unlocated:
        lines.append(
            f"  row={record.row} device={record.device_id} session={record.session_id} "
            f"count={record.count} amplitude={format_amplitude(record.amplitude)} "
            f"calibrated_utc_us={format_utc(record.utc_us)}"
        )

    lines.append(f"Uncalibrated samples ({len(report.uncalibrated)})")
    for sample, reason in report.uncalibrated:
        lines.append(
            f"  row={sample.row} device={sample.device_id} session={sample.session_id} "
            f"count={sample.count} amplitude={format_amplitude(sample.amplitude)} -- {reason}"
        )

    issues = [s for s in report.sessions if s.status != "ok"]
    lines.append(f"Session issues ({len(issues)})")
    for summary in issues:
        detail = summary.issue or summary.status
        lines.append(
            f"  device={summary.device_id} session={summary.session_id} "
            f"status={summary.status} anchors={summary.anchors} "
            f"uncalibrated_samples={summary.uncalibrated_samples} -- {detail}"
        )
    ok = len(report.sessions) - len(issues)
    lines.append(f"Calibrated sessions: {ok} of {len(report.sessions)}")
    return "\n".join(lines)


def _utc_json(value: Fraction) -> float | int:
    return value.numerator if value.denominator == 1 else float(value)


def build_json(report: AnalysisReport) -> dict:
    return {
        "processes": [
            {
                "device_id": result.process.device_id,
                "process_id": result.process.process_id,
                "window": {
                    "start_utc_us": result.process.start_utc_us,
                    "end_utc_us": result.process.end_utc_us,
                    "end_inclusive": False,
                },
                "valid_samples": result.valid_samples,
                "max_amplitude": result.peak.amplitude if result.peak else None,
                "peak": None
                if result.peak is None
                else {
                    **sample_json(result.peak),
                    "process_id": result.process.process_id,
                },
            }
            for result in report.processes
        ],
        "unlocated": [sample_json(record) for record in report.unlocated],
        "uncalibrated": [
            {
                "input_row": sample.row,
                "device_id": sample.device_id,
                "session_id": sample.session_id,
                "count": sample.count,
                "amplitude": sample.amplitude,
                "reason": reason,
            }
            for sample, reason in report.uncalibrated
        ],
        "sessions": [
            {
                "device_id": summary.device_id,
                "session_id": summary.session_id,
                "status": summary.status,
                "anchors": summary.anchors,
                "issue": summary.issue,
                "uncalibrated_samples": summary.uncalibrated_samples,
            }
            for summary in report.sessions
        ],
    }


def sample_json(record: SampleRecord) -> dict:
    payload = {
        "input_row": record.row,
        "device_id": record.device_id,
        "session_id": record.session_id,
        "count": record.count,
        "amplitude": record.amplitude,
        "calibrated_utc_us": _utc_json(record.utc_us),
    }
    # Interpolated times are often not whole microseconds; keep the exact value
    # so a consumer can re-apply the boundaries without float rounding.
    if record.utc_us.denominator != 1:
        payload["calibrated_utc_us_exact"] = str(record.utc_us)
    return payload


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("probe_csv", help="probe CSV: device_id,session_id,count,amplitude")
    parser.add_argument("sync_csv", help="sync CSV: device_id,session_id,count,utc_us")
    parser.add_argument("process_json", help="process JSON with UTC intervals")
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args(argv)

    try:
        samples = read_probe_csv(args.probe_csv)
        points = read_sync_csv(args.sync_csv)
        processes = read_process_json(args.process_json)
        report = analyze(samples, points, processes)
    except (OSError, UnicodeDecodeError, csv.Error, InputError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(build_json(report), indent=2) if args.json else format_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
