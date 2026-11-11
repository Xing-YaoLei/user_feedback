"""Example 1 — empty connections.

``inst-6`` owns no experiments and ``exp-11`` has no observations.  Empty
connections still return a well-formed page (empty ``edges``, null cursors,
``hasNextPage=false``); the collector records a finished checkpoint with
``done=0`` and never schedules child work for them.

Run:
    python examples/01_empty_connections.py
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


async def main() -> None:
    runner = web.AppRunner(create_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/graphql"

    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "empty.db"
        async with GQLClient(endpoint=url) as client:
            engine = HarvestEngine(client=client, store=Store(db), page_size=5)
            await engine.run()

        store = Store(db)
        for scope in ("inst:inst-6", "exp:exp-11"):
            cp = store.get_checkpoint(scope)
            print(
                f"{scope:<12} done={cp.done} has_next={cp.has_next} "
                f"cursor={cp.cursor}"
            )
        assert store.get_checkpoint("inst:inst-6").done == 0
        assert store.get_checkpoint("exp:exp-11").done == 0
        print("empty connections closed cleanly with zero edges")
        store.close()

    await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
