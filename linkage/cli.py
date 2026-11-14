"""Command-line entry point.

    participant-linkage \\
        --purpose cohort-linkage \\
        --key-file ./secret.key \\
        --manifest manifest.json \\
        --crosswalk crosswalk.csv \\
        --instrument-data instruments.csv \\
        --field-data observations.tsv
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import List, Optional, Sequence

from .errors import LinkageError
from .export import export
from .crosswalk import load_crosswalk
from .manifest import load_manifest
from .spec import (
    FIELD_ID_ALIASES,
    FIELD_PAYLOAD,
    INSTRUMENT_ID_ALIASES,
    INSTRUMENT_PAYLOAD,
    SourceSpec,
)

PROG = "participant-linkage"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Link instrument and field records for one approved purpose, "
            "emitting a stable participant code in place of registration numbers."
        ),
    )
    parser.add_argument("--purpose", required=True, help="approved purpose for this export")
    parser.add_argument("--manifest", required=True, type=Path, help="purpose manifest (JSON)")
    parser.add_argument("--crosswalk", required=True, type=Path, help="registration crosswalk")

    key_group = parser.add_mutually_exclusive_group(required=True)
    key_group.add_argument(
        "--key-file",
        type=Path,
        help="file containing the export key (raw bytes, or hex with --key-encoding hex)",
    )
    key_group.add_argument("--key-env", metavar="VARIABLE", help="environment variable holding the key")
    key_group.add_argument("--key-hex", metavar="HEX", help="key as hex, for test harnesses")
    parser.add_argument(
        "--key-encoding",
        choices=("raw", "hex"),
        default="raw",
        help="how --key-file is encoded (default: raw); --key-hex is always hex",
    )

    parser.add_argument("--instrument-data", type=Path, help="instrument measurements (CSV)")
    parser.add_argument("--field-data", type=Path, help="field observations (TSV)")
    parser.add_argument("--instrument-output", type=Path, help="instrument result file (CSV)")
    parser.add_argument("--field-output", type=Path, help="field result file (CSV)")
    parser.add_argument(
        "--rejects",
        type=Path,
        default=Path("rejects.csv"),
        help="internal rejection list (default: rejects.csv)",
    )
    parser.add_argument("--quiet", action="store_true", help="suppress the run summary")
    return parser


def _read_key(args: argparse.Namespace) -> bytes:
    if args.key_hex is not None:
        try:
            return bytes.fromhex(args.key_hex)
        except ValueError as exc:
            raise LinkageError(f"--key-hex is not valid hex: {exc}") from exc
    if args.key_env is not None:
        raw = os.environ.get(args.key_env)
        if raw is None:
            raise LinkageError(f"environment variable {args.key_env!r} is not set")
        return raw.encode("utf-8")
    path: Path = args.key_file
    try:
        data = path.read_bytes()
    except FileNotFoundError as exc:
        raise LinkageError(f"key file not found: {path}") from exc
    except OSError as exc:
        raise LinkageError(f"cannot read key file {path}: {exc}") from exc
    if args.key_encoding == "hex":
        try:
            return bytes.fromhex(data.decode("ascii").strip())
        except (UnicodeDecodeError, ValueError) as exc:
            raise LinkageError(f"{path}: key file is not valid hex: {exc}") from exc
    # A single trailing newline is a common artifact of storing the key with
    # an editor; it is not part of the key.
    if data.endswith(b"\n"):
        data = data[:-1]
        if data.endswith(b"\r"):
            data = data[:-1]
    return data


def _specs(args: argparse.Namespace) -> List[SourceSpec]:
    specs: List[SourceSpec] = []
    pairs = (
        ("instrument", args.instrument_data, args.instrument_output),
        ("field", args.field_data, args.field_output),
    )
    for key, data_path, output_path in pairs:
        if data_path is None and output_path is None:
            continue
        if data_path is None:
            raise LinkageError(f"--{key}-output needs --{key}-data")
        if output_path is None:
            # Sits next to the input, always as CSV since the result is CSV.
            output_path = data_path.with_name(data_path.stem + ".linked.csv")
        if key == "instrument":
            specs.append(
                SourceSpec(
                    key="instrument",
                    display_name="instrument measurement",
                    data_path=data_path,
                    delimiter=",",
                    id_aliases=INSTRUMENT_ID_ALIASES,
                    payload=INSTRUMENT_PAYLOAD,
                    output_path=output_path,
                )
            )
        else:
            specs.append(
                SourceSpec(
                    key="field",
                    display_name="field observation",
                    data_path=data_path,
                    delimiter="\t",
                    id_aliases=FIELD_ID_ALIASES,
                    payload=FIELD_PAYLOAD,
                    output_path=output_path,
                )
            )
    if not specs:
        raise LinkageError("at least one of --instrument-data or --field-data is required")
    return specs


def run(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    key = _read_key(args)
    manifest = load_manifest(args.manifest)
    crosswalk = load_crosswalk(args.crosswalk)
    specs = _specs(args)

    result = export(
        purpose=args.purpose,
        key=key,
        manifest=manifest,
        crosswalk=crosswalk,
        specs=specs,
        reject_path=args.rejects,
    )

    if not args.quiet:
        print(f"purpose: {result.purpose}")
        for spec in specs:
            outcome = result.sources[spec.key]
            print(
                f"  {spec.display_name}: {outcome.emitted} linked, "
                f"{len(outcome.rejects)} rejected -> {outcome.output_path}"
            )
        print(f"reject list: {result.reject_path} ({result.rejected} entries)")
        for warning in result.warnings:
            print(f"warning: {warning}", file=sys.stderr)
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        return run(argv)
    except LinkageError as exc:
        print(f"{PROG}: error: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 1
