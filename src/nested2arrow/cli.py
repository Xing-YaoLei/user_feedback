"""Command-line interface for nested2arrow."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .contract import Contract
from .decoder import decode_table, read_table
from .report import build_report
from .runner import ConflictError, InputFile, convert
from .samples import generate_samples
from .verify import verify_roundtrip


def _load_inputs(paths: list[str]) -> list[InputFile]:
    return [InputFile(path=p, stream=open(p, "rb")) for p in paths]


def _cmd_samples(args: argparse.Namespace) -> int:
    sample = generate_samples(
        args.out_dir, include_conflict=args.include_conflict)
    print(f"generated {len(sample.files)} input files in {sample.dir}")
    for path in sample.files:
        print(f"  - {path}")
    print(f"corrupt input: {sample.corrupt_file}")
    print(f"contract:      {sample.contract_file}")
    return 0


def _cmd_convert(args: argparse.Namespace) -> int:
    contract = (Contract.load(args.contract) if args.contract
                else Contract())
    inputs = _load_inputs(args.inputs)
    try:
        result = convert(inputs, args.out_dir, contract)
    except ConflictError as exc:
        print("CONVERSION ABORTED — unresolved conflicts:", file=sys.stderr)
        for conflict in exc.conflicts:
            print(f"  batch {conflict['batch_id']} {conflict['path']}: "
                  f"{conflict['detail']} "
                  f"({conflict['before']} vs {conflict['after']}, "
                  f"policy={conflict['policy']})", file=sys.stderr)
        return 2

    build_report(result, Path(args.out_dir) / "report.html")
    summary = {
        "output_parquet": result.output_parquet,
        "records_written": result.record_written,
        "records_quarantined": result.record_quarantined,
        "parse_errors": result.parse_errors,
        "conflicts": len(result.conflict_events),
        "merge_events": len(result.merge_events),
        "error_parquet": result.error_parquet,
        "report": str(Path(args.out_dir) / "report.html"),
    }
    print(json.dumps(summary, indent=2))
    if result.conflict_events:
        for event in result.conflict_events:
            print(f"  CONFLICT batch {event['batch_id']} {event['path']}: "
                  f"{event['detail']} [policy={event['policy']}]",
                  file=sys.stderr)
    return 1 if (result.record_quarantined or result.parse_errors) and \
        contract.fail_on_error else 0


def _cmd_verify(args: argparse.Namespace) -> int:
    contract = (Contract.load(args.contract) if args.contract
                else Contract())
    raw_records = []
    for path in args.inputs:
        with open(path, "rb") as fh:
            raw_records.extend(
                line for line in fh.read().splitlines() if line.strip())

    # reconstruct the root schema by re-running inference from the parquet's
    # embedded tree is not possible, so infer fresh from raw inputs
    from .inference import infer_batches, read_batches
    from io import BytesIO
    data = b"\n".join(raw_records)
    inference = infer_batches(
        read_batches(BytesIO(data), contract.batch_max_records), contract)
    report = verify_roundtrip(
        raw_records, args.parquet, inference.root, contract)
    print(f"checked {report.records_checked} records, "
          f"{len(report.checks)} invariant groups, "
          f"{len(report.failures)} failures")
    for check in report.checks:
        print(f"  ok: {check}")
    if not report.ok:
        report.raise_if_failed()
    print("ROUND-TRIP VERIFIED: structure, values and presence semantics match")
    return 0


def _cmd_decode(args: argparse.Namespace) -> int:
    contract = (Contract.load(args.contract) if args.contract
                else Contract())
    table = read_table(args.parquet)
    # schema tree is stored alongside at conversion time in the report payload;
    # here we re-infer from source when provided
    if args.inputs:
        from .inference import infer_batches, read_batches
        from io import BytesIO
        data = b"".join(Path(p).read_bytes() for p in args.inputs)
        inference = infer_batches(
            read_batches(BytesIO(data), contract.batch_max_records),
            contract)
        root = inference.root
    else:
        print("error: --inputs required to reconstruct the typed schema",
              file=sys.stderr)
        return 2
    records = decode_table(table, root, contract)
    for record in records:
        print(json.dumps(record, ensure_ascii=False, default=str))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nested2arrow",
        description="Nested JSON -> Arrow/Parquet with preserved semantics")
    sub = parser.add_subparsers(dest="command", required=True)

    p_samples = sub.add_parser("generate-samples",
                               help="create repeatable sample NDJSON inputs")
    p_samples.add_argument("out_dir")
    p_samples.add_argument("--include-conflict", action="store_true")
    p_samples.set_defaults(func=_cmd_samples)

    p_conv = sub.add_parser("convert", help="stream NDJSON files to Parquet")
    p_conv.add_argument("inputs", nargs="+")
    p_conv.add_argument("--out-dir", required=True)
    p_conv.add_argument("--contract")
    p_conv.set_defaults(func=_cmd_convert)

    p_ver = sub.add_parser("verify",
                           help="deep semantic round-trip verification")
    p_ver.add_argument("parquet")
    p_ver.add_argument("--inputs", nargs="+", required=True)
    p_ver.add_argument("--contract")
    p_ver.set_defaults(func=_cmd_verify)

    p_dec = sub.add_parser("decode", help="read Parquet back to JSON lines")
    p_dec.add_argument("parquet")
    p_dec.add_argument("--inputs", nargs="+")
    p_dec.add_argument("--contract")
    p_dec.set_defaults(func=_cmd_decode)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
