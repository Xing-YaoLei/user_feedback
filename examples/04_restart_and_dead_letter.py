"""Example 4 — restart recovery and dead letters.

Phase 1 runs a harvest against a server whose ``exp-5`` connection never
recovers.  The job exhausts its retry budget and lands in ``dead_letters``;
every other connection completes.

Phase 2 restarts with a *fresh, healthy* server pointed at the same SQLite
file.  Checkpoints make all finished connections skip immediately (zero
requests for them), and the previously dead path is retried and completed,
leaving a fully consistent database.

Run:
    python examples/04_restart_and_dead_letter.py
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

EXPECTED_LINKS = sum(len(v) for v in EXPERIMENT_OBSERVATIONS.values())


async def start_server() -> tuple[web.AppRunner, str]:
    runner = web.AppRunner(create_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/graphql"
    return runner, url


async def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "restart.db"

        # ---- phase 1: permanently failing exp-5 connection --------------
        runner, url = await start_server()
        rules = [
            {"path": ["experiment", "observations"], "id": "exp-5", "times": 1000}
        ]
        store = Store(db)
        async with GQLClient(endpoint=url, fail_rules=rules) as client:
            engine = HarvestEngine(
                client=client, store=store, page_size=5, max_workers=4,
                max_attempts=3, base_backoff=0.01, max_backoff=0.05,
            )
            summary1 = await engine.run()
        await runner.cleanup()

        print("phase 1 (unhealthy server):")
        print("  dead letters:", [(d["scope"], d["attempts"]) for d in summary1.dead_letters])
        exp5_links = store._conn.execute(
            "SELECT count(*) c FROM experiment_observations WHERE experiment_id='exp-5'"
        ).fetchone()["c"]
        total_links = summary1.counts["experiment_observation_links"]
        print(f"  exp-5 links: {exp5_links} (all 6 missing)")
        print(f"  other links: {total_links} (= {EXPECTED_LINKS} - 6)")
        assert len(summary1.dead_letters) == 1
        assert exp5_links == 0 and total_links == EXPECTED_LINKS - 6

        # ---- phase 2: healthy server, same database ---------------------
        # No manual cleanup is required: unfinished/dead connections are
        # re-enqueued from checkpoints on startup, and a successful page
        # clears its own dead_letter row.
        runner2, url2 = await start_server()
        async with GQLClient(endpoint=url2) as client:
            engine2 = HarvestEngine(
                client=client, store=store, page_size=5, max_workers=4
            )
            summary2 = await engine2.run()
        await runner2.cleanup()

        print("\nphase 2 (healthy server, resumed from checkpoints):")
        print("  requests needed:", summary2.requests)
        print("  dead letters:", summary2.dead_letters)
        print("  counts:", summary2.counts)
        assert summary2.dead_letters == []
        assert summary2.counts["experiment_observation_links"] == EXPECTED_LINKS
        assert store.duplicate_link_count() == 0
        store.close()
        print("\nrecovery complete: the dead path was finished, finished "
              "connections were not re-fetched, no duplicate relationships.")


if __name__ == "__main__":
    asyncio.run(main())
