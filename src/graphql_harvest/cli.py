"""Command line entry points: ``harvest run`` and ``harvest trace``."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from .collector.client import GQLClient
from .collector.engine import HarvestEngine
from .collector.store import Store


async def run_async(args: argparse.Namespace) -> int:
    fail_rules = json.loads(args.fail_rules) if args.fail_rules else None

    def on_event(event: str, payload: dict) -> None:
        if args.quiet:
            return
        if event == "page_ok":
            print(
                f"  ok   {payload['scope']:<12} edges={payload['edges']:<2} "
                f"has_next={payload['has_next']}"
            )
        elif event in ("connection_error", "edge_error", "transport_error"):
            print(f"  retry {payload['scope']:<12} {payload}")

    with Store(args.db) as store:
        async with GQLClient(
            endpoint=args.endpoint,
            max_concurrency=args.concurrency,
            min_interval=args.min_interval,
            fail_rules=fail_rules,
            on_request=None,
        ) as client:
            engine = HarvestEngine(
                client=client,
                store=store,
                page_size=args.page_size,
                max_workers=args.workers,
                max_attempts=args.max_attempts,
                on_event=on_event,
            )
            summary = await engine.run()

    print("\n=== harvest summary ===")
    print(f"requests:           {summary.requests}")
    print(f"pages ok:           {summary.pages_ok}")
    print(f"pages retried:      {summary.pages_retried}")
    print(f"dead letters:       {len(summary.dead_letters)}")
    for dl in summary.dead_letters:
        print(f"  - {dl}")
    print("row counts:")
    for key, value in summary.counts.items():
        print(f"  {key:<34} {value}")
    return 1 if summary.dead_letters else 0


def trace(args: argparse.Namespace) -> int:
    with Store(args.db) as store:
        paths = store.observation_paths(args.node_id)
        if not paths:
            # maybe it is an experiment or institution: show direct lineage
            exp = store.experiment_parent(args.node_id)
            if exp is not None:
                cp = store.get_checkpoint(f"exp:{args.node_id}")
                print(f"experiment {exp['id']} ({exp['name']})")
                print(f"  parent institution: {exp['institution_id']}")
                if cp is not None:
                    print(
                        f"  checkpoint scope={cp.scope} done={cp.done} "
                        f"has_next={cp.has_next} cursor={cp.cursor}"
                    )
                return 0
            inst = store._conn.execute(
                "SELECT * FROM institutions WHERE id=?", (args.node_id,)
            ).fetchone()
            if inst is not None:
                cp = store.get_checkpoint("root")
                print(f"institution {inst['id']} ({inst['name']})")
                if cp is not None:
                    print(
                        f"  checkpoint scope={cp.scope} done={cp.done} "
                        f"has_next={cp.has_next} cursor={cp.cursor}"
                    )
                return 0
            print(f"node {args.node_id!r} not found in {args.db}", file=sys.stderr)
            return 2

        print(f"observation {args.node_id} is reachable through {len(paths)} path(s):")
        for p in paths:
            print(
                f"  {p.institution_id} ({p.institution_name}) -> "
                f"{p.experiment_id} ({p.experiment_name}) -> "
                f"{p.observation_id} ({p.observation_name}) "
                f"[position={p.position}]"
            )
        cp = store.get_checkpoint(f"exp:{paths[0].experiment_id}")
        if cp is not None:
            print(
                f"\ncheckpoint of last parent connection: scope={cp.scope} "
                f"done={cp.done} has_next={cp.has_next} cursor={cp.cursor}"
            )
        failed = store.list_failed_edges()
        if failed:
            print("\npending failed edges:")
            for fe in failed:
                print(f"  {fe.scope} -> {fe.node_id} (attempts={fe.attempts})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harvest", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="run (or resume) a harvest")
    p_run.add_argument("--endpoint", default="http://127.0.0.1:8080/graphql")
    p_run.add_argument("--db", default="harvest.db")
    p_run.add_argument("--page-size", type=int, default=5)
    p_run.add_argument("--workers", type=int, default=4)
    p_run.add_argument("--concurrency", type=int, default=4)
    p_run.add_argument("--min-interval", type=float, default=0.0)
    p_run.add_argument("--max-attempts", type=int, default=8)
    p_run.add_argument(
        "--fail-rules",
        help="JSON array of failure rules sent via X-Fail-Rules header",
    )
    p_run.add_argument("--quiet", action="store_true")
    p_run.set_defaults(func=lambda a: asyncio.run(run_async(a)))

    p_trace = sub.add_parser("trace", help="trace a node's source paths")
    p_trace.add_argument("node_id")
    p_trace.add_argument("--db", default="harvest.db")
    p_trace.set_defaults(func=trace)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
