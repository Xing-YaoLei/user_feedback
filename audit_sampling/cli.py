"""Command line interface.

Branch side (repeat per branch, one sequential scan per input)::

    audit-sampling summarize \\
        --seed 2026Q4 --quota quota.json --reviewed reviewed.json \\
        --input branch-01.jsonl.gz --out branch-01.summary.json

Head office (reads every summary, writes the review list and report)::

    audit-sampling merge --summary branch-01.summary.json \\
        --summary branch-02.summary.json --report report.json \\
        --selection selection.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from typing import Any

from . import io as stream_io
from .core import (
    BranchSummary,
    SamplingError,
    merge_summaries,
    stratum_sort_key,
    summary_from_dict,
    summary_to_dict,
    summarize_records,
)


def _load_json_file(path: str, what: str) -> Any:
    stream = stream_io.open_text_for_read(path)
    try:
        text = stream.read()
    finally:
        if stream is not sys.stdin:
            stream.close()
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise SamplingError(f"{what} {path}: invalid JSON: {exc.msg}") from exc


def _cmd_summarize(args: argparse.Namespace) -> int:
    quota = _load_json_file(args.quota, "quota table")
    reviewed = (
        stream_io.read_reviewed_ids(args.reviewed)
        if args.reviewed
        else frozenset()
    )
    summary = summarize_records(
        stream_io.iter_page_records_many(args.input),
        seed=args.seed,
        quota=quota,
        reviewed_ids=reviewed,
        label=args.label,
    )
    stream_io.write_json(args.out, summary_to_dict(summary))
    _log(
        f"summarized {sum(s.eligible for s in summary.strata.values())} eligible "
        f"records into {len(summary.strata)} strata -> {args.out}"
    )
    return 0


def _cmd_merge(args: argparse.Namespace) -> int:
    loaded = [_load_json_file(path, "summary") for path in args.summary]
    if args.summary_out:
        # Roll-up level: merge summaries and re-emit a summary that can itself
        # be merged at the head office.
        merged = merge_summaries(
            [summary_from_dict(item) for item in loaded],
            quota=_load_json_file(args.quota, "quota table") if args.quota else None,
        )
        stream_io.write_json(
            args.summary_out, summary_to_dict(merged.as_summary(label=args.label))
        )
        _write_table(merged)
        return 0

    summaries: list[BranchSummary] = [summary_from_dict(item) for item in loaded]
    quota = _load_json_file(args.quota, "quota table") if args.quota else None
    result = merge_summaries(summaries, quota=quota)

    if args.report:
        stream_io.write_json(args.report, result.report_dict())
    if args.selection:
        stream_io.write_json(args.selection, result.selection_dict())

    _write_table(result)
    return 0


def _cmd_direct(args: argparse.Namespace) -> int:
    from .core import select_directly

    quota = _load_json_file(args.quota, "quota table")
    reviewed = (
        stream_io.read_reviewed_ids(args.reviewed)
        if args.reviewed
        else frozenset()
    )
    direct = select_directly(
        stream_io.iter_page_records_many(args.input),
        seed=args.seed,
        quota=quota,
        reviewed_ids=reviewed,
    )
    payload = {
        "schema": "audit-sampling/direct-report/v1",
        "seed": args.seed,
        "strata": [
            {
                "language": key[0],
                "tier": key[1],
                "eligible": direct.eligible[key],
                "selected_page_ids": list(direct.selected[key]),
                "selected_count": len(direct.selected[key]),
            }
            for key in sorted(direct.selected, key=stratum_sort_key)
        ],
    }
    stream_io.write_json(args.out, payload)
    return 0


def _write_table(result: Any) -> None:
    header = f"{'language':<10}{'tier':<8}{'quota':>7}{'eligible':>10}{'selected':>10}{'shortfall':>11}"
    lines = [header, "-" * len(header)]
    for stratum in result.strata:
        lines.append(
            f"{stratum.language:<10}{stratum.tier:<8}{stratum.quota:>7}"
            f"{stratum.eligible:>10}{stratum.selected_count:>10}"
            f"{stratum.shortfall:>11}"
        )
    totals = result.totals
    lines.append("-" * len(header))
    lines.append(
        f"{'TOTAL':<18}{sum(s.quota for s in result.strata):>7}"
        f"{totals['eligible']:>10}{totals['selected']:>10}{totals['shortfall']:>11}"
    )
    _log("\n".join(lines))


def _log(message: str) -> None:
    print(message, file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="audit-sampling",
        description=(
            "Deterministic stratified sampling across branches of newspaper "
            "scans: branch summaries merge into exactly the same list as a "
            "single head-office pass."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    summarize = subparsers.add_parser(
        "summarize",
        help="scan one branch's JSONL files and write a mergeable summary",
    )
    summarize.add_argument("--seed", required=True, help="sampling seed")
    summarize.add_argument(
        "--quota", required=True, help="path to the per-language/per-tier quota JSON"
    )
    summarize.add_argument(
        "--reviewed",
        help="path to the already-reviewed page ID list (JSON, JSONL, or text)",
    )
    summarize.add_argument(
        "--input",
        action="append",
        required=True,
        help="gzip (.gz) or plain JSONL input file (repeatable)",
    )
    summarize.add_argument("--out", required=True, help="summary JSON output path")
    summarize.add_argument("--label", help="optional branch name recorded in the summary")
    summarize.set_defaults(handler=_cmd_summarize)

    merge = subparsers.add_parser(
        "merge", help="merge branch summaries into the review list and report"
    )
    merge.add_argument(
        "--summary", action="append", required=True, help="summary JSON (repeatable)"
    )
    merge.add_argument(
        "--quota", help="optional quota table to cross-check against the summaries"
    )
    merge.add_argument("--report", help="report JSON output path")
    merge.add_argument("--selection", help="selection JSON output path")
    merge.add_argument(
        "--summary-out",
        help="write a merged summary instead (for multi-level roll-ups)",
    )
    merge.add_argument("--label", help="label for a summary written with --summary-out")
    merge.set_defaults(handler=_cmd_merge)

    direct = subparsers.add_parser(
        "direct",
        help="single-pass reference sampler over all records (for verification)",
    )
    direct.add_argument("--seed", required=True)
    direct.add_argument("--quota", required=True)
    direct.add_argument("--reviewed")
    direct.add_argument(
        "--input", action="append", required=True, help="repeatable JSONL input file"
    )
    direct.add_argument("--out", required=True)
    direct.set_defaults(handler=_cmd_direct)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except SamplingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
