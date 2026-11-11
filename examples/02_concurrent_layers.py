"""Example 2 — all three layers paginate concurrently.

The engine is a worker pool: as soon as a parent page yields nodes, child
connection jobs are enqueued and picked up by other workers while the parent
connection keeps paginating.  This script records the layer of every request
in order and shows that experiments/observations pages start before the root
institutions connection finishes.

Run:
    python examples/02_concurrent_layers.py
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


def layer_of(query: str) -> str:
    if "institutions(first" in query:
        return "institutions"
    if "institution(id" in query:
        return "experiments"
    return "observations"


async def main() -> None:
    runner = web.AppRunner(create_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/graphql"

    sequence: list[str] = []

    async def on_request(query: str, _variables: dict) -> None:
        sequence.append(layer_of(query))

    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "concurrent.db"
        async with GQLClient(
            endpoint=url, max_concurrency=4, on_request=on_request
        ) as client:
            engine = HarvestEngine(
                client=client, store=Store(db), page_size=2, max_workers=4
            )
            summary = await engine.run()

    await runner.cleanup()

    print(f"request sequence ({len(sequence)} requests):")
    print("  " + " -> ".join(sequence))
    first_exp = sequence.index("experiments")
    last_inst = len(sequence) - 1 - sequence[::-1].index("institutions")
    first_obs = sequence.index("observations")
    last_exp = len(sequence) - 1 - sequence[::-1].index("experiments")
    print(
        f"experiments start at request {first_exp}, "
        f"root finishes at {last_inst} -> overlap: {first_exp < last_inst}"
    )
    print(
        f"observations start at request {first_obs}, "
        f"experiments finish at {last_exp} -> overlap: {first_obs < last_exp}"
    )
    print(
        f"harvested {summary.counts['observations']} observations via "
        f"{summary.counts['experiment_observation_links']} links"
    )
    assert first_exp < last_inst and first_obs < last_exp


if __name__ == "__main__":
    asyncio.run(main())
