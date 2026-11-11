"""Example 3 — HTTP 200 with partial data + errors: split, keep, retry.

The server is configured to inject three kinds of failures:

1. root ``institutions`` connection fails once       (connection level)
2. ``inst-3.experiments`` connection fails twice      (connection level)
3. one edge node ``exp-7 -> obs-09`` fails twice      (edge-node level)

Every failure still returns HTTP 200.  The engine's behaviour:

* a connection-level error retries that whole connection from its own cursor;
  no other parent is affected;
* an edge-node error keeps the sibling edges of the page (ingested once,
  upserts make the retry idempotent), records only that edge position in
  ``failed_edges`` and re-requests the same page until the node recovers;
* the run converges with zero dead letters and a complete, duplicate-free
  dataset.  The request log keeps the 200-vs-error distinction for auditing.

Run:
    python examples/03_partial_errors.py
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from aiohttp import web

from graphql_harvest.collector.client import GQLClient
from graphql_harvest.collector.engine import HarvestEngine
from graphql_harvest.collector.store import Store
from graphql_harvest.server.app import create_app
from graphql_harvest.server.seed import EXPERIMENT_OBSERVATIONS

FAIL_RULES = [
    {"path": ["institutions"], "times": 1},
    {"path": ["institution", "experiments"], "id": "inst-3", "times": 2},
    {
        "path": ["experiment", "observations", "edges", 2, "node"],
        "id": "exp-7",
        "nodeId": "obs-09",
        "times": 2,
    },
]

EXPECTED_LINKS = sum(len(v) for v in EXPERIMENT_OBSERVATIONS.values())


def on_event(event: str, payload: dict) -> None:
    if event == "connection_error":
        print(f"  [retry connection] {payload['scope']} attempt={payload['attempt']}")
    elif event == "edge_error":
        print(
            f"  [retry edge]       {payload['scope']} "
            f"position={payload['position']} node={payload['node_id']}"
        )
    elif event == "page_ok":
        print(f"  [page ok]          {payload['scope']} edges={payload['edges']}")


async def main() -> None:
    runner = web.AppRunner(create_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/graphql"

    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "partial.db"
        store = Store(db)
        async with GQLClient(endpoint=url, max_concurrency=4,
                             fail_rules=FAIL_RULES) as client:
            engine = HarvestEngine(
                client=client, store=store, page_size=5, max_workers=4,
                max_attempts=8, base_backoff=0.01, max_backoff=0.1,
                on_event=on_event,
            )
            summary = await engine.run()

    await runner.cleanup()

    print("\n--- summary ---")
    print(f"requests={summary.requests} retried_pages={summary.pages_retried} "
          f"dead_letters={len(summary.dead_letters)}")
    print("counts:", summary.counts)

    # every failed response was still HTTP 200
    statuses = {
        r["status"]
        for r in store._conn.execute("SELECT DISTINCT status FROM request_log")
    }
    print("distinct HTTP statuses:", statuses)

    assert summary.dead_letters == []
    assert summary.counts["observations"] == 20
    assert summary.counts["experiment_observation_links"] == EXPECTED_LINKS
    assert summary.counts["failed_edges"] == 0
    assert store.duplicate_link_count() == 0
    assert statuses == {200}
    store.close()
    print("\npartial errors were retried in place; good subtrees survived, "
          "nothing duplicated.")


if __name__ == "__main__":
    asyncio.run(main())
