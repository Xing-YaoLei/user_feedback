"""Command line interface for the cold-chain batch receiver.

Examples
--------
    python -m coldstore.cli scan --root /var/lib/coldstore --once
    python -m coldstore.cli scan --root /var/lib/coldstore --interval 5
    python -m coldstore.cli status --root /var/lib/coldstore
    python -m coldstore.cli list-missing --root /var/lib/coldstore --gateway gw-7
    python -m coldstore.cli list-bad --root /var/lib/coldstore
    python -m coldstore.cli list-gaps --root /var/lib/coldstore
    python -m coldstore.cli list-conflicts --root /var/lib/coldstore
    python -m coldstore.cli list-duplicates --root /var/lib/coldstore
    python -m coldstore.cli receipt --root /var/lib/coldstore --gateway gw-7 --batch 41
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .receiver import Receiver


def _print_json(payload: object) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="coldstore",
        description="Cold-chain gateway batch receiver",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_scan = sub.add_parser("scan", help="scan the inbox and publish ready batches")
    p_scan.add_argument("--root", required=True, help="receiver data root")
    p_scan.add_argument(
        "--interval", type=float, default=5.0,
        help="polling interval in seconds (default: 5)",
    )
    p_scan.add_argument(
        "--once", action="store_true",
        help="perform a single scan and exit",
    )
    p_scan.add_argument(
        "--stable-seconds", type=float, default=2.0,
        help="files must be unchanged this long before use (default: 2)",
    )

    def add_query(name: str, help_text: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--root", required=True)
        p.add_argument("--gateway", help="limit to one gateway id")
        return p

    add_query("status", "per-gateway state summary and next expected batch")
    add_query("list-missing", "pairs with one file missing (缺件)")
    add_query("list-bad", "complete pairs that failed validation (坏包)")
    add_query("list-gaps", "batch numbers with no record at all (缺号)")
    add_query("list-conflicts", "published batches re-arrived with new content")
    add_query("list-duplicates", "identical retransmissions already receipted")

    p_receipt = sub.add_parser("receipt", help="show the receipt of one batch")
    p_receipt.add_argument("--root", required=True)
    p_receipt.add_argument("--gateway", required=True)
    p_receipt.add_argument("--batch", required=True, type=int)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "scan":
        receiver = Receiver(Path(args.root), stable_seconds=args.stable_seconds)
        receiver.run(interval=args.interval, once=args.once)
        return 0

    # Query commands: construct without running a scan.
    receiver = Receiver(Path(args.root))
    try:
        if args.command == "status":
            _print_json(receiver.status(args.gateway))
        elif args.command == "list-missing":
            _print_json(receiver.list_missing_pieces(args.gateway))
        elif args.command == "list-bad":
            _print_json(receiver.list_bad(args.gateway))
        elif args.command == "list-gaps":
            _print_json(receiver.list_gaps(args.gateway))
        elif args.command == "list-conflicts":
            _print_json(receiver.list_conflicts(args.gateway))
        elif args.command == "list-duplicates":
            _print_json(receiver.list_duplicates(args.gateway))
        elif args.command == "receipt":
            receipt = receiver._read_receipt(args.gateway, args.batch)
            if receipt is None:
                print(
                    f"no receipt for {args.gateway} batch {args.batch}",
                    file=sys.stderr,
                )
                return 1
            _print_json(receipt)
        return 0
    finally:
        receiver.close()


if __name__ == "__main__":
    raise SystemExit(main())
