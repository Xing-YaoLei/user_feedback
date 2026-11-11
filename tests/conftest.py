"""Shared pytest fixtures: a real aiohttp server bound to an ephemeral port."""

from __future__ import annotations

import pytest_asyncio
from aiohttp import web

from graphql_harvest.server.app import create_app


@pytest_asyncio.fixture
async def server_url():
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/graphql"
    finally:
        await runner.cleanup()
