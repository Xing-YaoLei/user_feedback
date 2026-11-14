"""Command-line entry point: wire readers, external sorts and the engine."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

try:  # RLIMIT_NOFILE is POSIX-only; Windows falls back to the default fan-in.
    import resource
except ImportError:  # pragma: no cover - platform specific
    resource = None

from . import __version__
from .engine import (
    STATUS_ORDER,
    Stats,
    reconcile_streams,
)
from .errors import ReconcileError
from .readers import manifest_lines, target_lines
from .sortmerge import external_sort

DEFAULT_MEMORY_LIMIT_MIB = 128
DEFAULT_MAX_LINE_BYTES = 4096
DEFAULT_FAN_IN = 64

#: Fraction of the memory cap that may hold buffered sort records.  The rest
#: is reserved for the interpreter, line readers, merge readers and output.
DATA_BUDGET_FRACTION = 0.5


def _fan_in_limit() -> int:
    if resource is None or not hasattr(resource, "RLIMIT_NOFILE"):
        return DEFAULT_FAN_IN
    soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft == resource.RLIM_INFINITY:
        return DEFAULT_FAN_IN
    # Two input sides may each open this many runs, plus work files and output.
    bounded = (soft - 32) // 2
    return max(2, min(DEFAULT_FAN_IN, bounded))


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="reconcile",
        description=(
            "Reconcile a handover manifest (JSONL) against a target inventory "
            "snapshot (TSV) with bounded memory and deterministic output."
        ),
    )
    parser.add_argument(
        "--manifest",
        required=True,
        help="handover manifest in JSONL (key, size, sha256, optional source)",
    )
    parser.add_argument(
        "--target",
        required=True,
        help="target inventory snapshot in TSV, with a header row",
    )
    parser.add_argument(
        "--detail",
        required=True,
        help="output path for the per-key difference detail (JSONL, sorted)",
    )
    parser.add_argument(
        "--summary",
        required=True,
        help="output path for the summary counts (JSON)",
    )
    parser.add_argument(
        "--workdir",
        help="directory for temporary sort runs (defaults to the system temp dir)",
    )
    parser.add_argument(
        "--memory-limit-mib",
        type=int,
        default=DEFAULT_MEMORY_LIMIT_MIB,
        help=(
            "peak memory budget in MiB; sort chunk sizes are derived from it "
            f"(default: {DEFAULT_MEMORY_LIMIT_MIB})"
        ),
    )
    parser.add_argument(
        "--max-line-bytes",
        type=int,
        default=DEFAULT_MAX_LINE_BYTES,
        help=f"maximum accepted input line length (default: {DEFAULT_MAX_LINE_BYTES})",
    )
    parser.add_argument(
        "--fan-in",
        type=int,
        default=None,
        help="maximum runs merged per pass (default: derived from the fd limit)",
    )
    parser.add_argument(
        "--only-differences",
        action="store_true",
        help="omit 'consistent' rows from the detail output",
    )
    parser.add_argument(
        "--version", action="version", version=f"reconcile {__version__}"
    )
    return parser.parse_args(argv)


def _write_summary(path: str, stats: Stats, args: argparse.Namespace) -> None:
    summary = {
        "status_counts": {status: stats.counts[status] for status in STATUS_ORDER},
        "total_objects": stats.total_objects,
        "input_lines": {
            "manifest": stats.manifest_lines,
            "target": stats.target_lines,
        },
        "identical_records_merged": {
            "manifest": stats.manifest_duplicate_records,
            "target": stats.target_duplicate_records,
        },
        "truncated_conflict_reports": stats.truncated_conflict_reports,
        "settings": {
            "memory_limit_mib": args.memory_limit_mib,
            "max_line_bytes": args.max_line_bytes,
            "only_differences": bool(args.only_differences),
        },
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2, sort_keys=True)
        handle.write("\n")


def run(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.memory_limit_mib < 16:
        raise ReconcileError("--memory-limit-mib must be at least 16")
    if args.max_line_bytes < 1:
        raise ReconcileError("--max-line-bytes must be positive")
    fan_in = args.fan_in or _fan_in_limit()
    if fan_in < 2:
        raise ReconcileError("--fan-in must be at least 2")

    data_budget = int(args.memory_limit_mib * 1024 * 1024 * DATA_BUDGET_FRACTION)
    per_side_chunk = max(64 * 1024, data_budget // 2)

    for output in (args.detail, args.summary):
        parent = Path(output).parent
        if parent and not parent.exists():
            raise ReconcileError(f"output directory does not exist: {parent}")

    workdir = tempfile.mkdtemp(prefix="reconcile-", dir=args.workdir)
    detail_handle = None
    try:
        # The sort objects are lazy generators; chunking happens while the
        # merge engine pulls records, never by loading a whole input at once.
        manifest_sorted = external_sort(
            manifest_lines(args.manifest, args.max_line_bytes),
            workdir,
            "manifest",
            per_side_chunk,
            fan_in,
        )
        target_sorted = external_sort(
            target_lines(args.target, args.max_line_bytes),
            workdir,
            "target",
            per_side_chunk,
            fan_in,
        )

        stats = Stats()
        detail_handle = open(args.detail, "w", encoding="utf-8")

        def emit(row: dict) -> None:
            if args.only_differences and row["status"] == "consistent":
                return
            detail_handle.write(json.dumps(row, sort_keys=True))
            detail_handle.write("\n")

        reconcile_streams(manifest_sorted, target_sorted, emit, stats)
        detail_handle.flush()
        detail_handle.close()
        detail_handle = None
        _write_summary(args.summary, stats, args)
    finally:
        if detail_handle is not None:
            detail_handle.close()
        shutil.rmtree(workdir, ignore_errors=True)

    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run(argv)
    except ReconcileError as exc:
        print(f"reconcile: error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"reconcile: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
