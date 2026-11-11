"""Concurrency control and transport-level behaviour tests."""

from __future__ import annotations

import asyncio

import pytest

from graphql_harvest.collector.client import GQLClient
from graphql_harvest.collector.engine import HarvestEngine
from graphql_harvest.collector.store import Store


@pytest.mark.asyncio
async def test_client_enforces_max_concurrency(server_url, tmp_path):
    inflight = 0
    peak = 0
    lock = asyncio.Lock()

    async def on_request(_query, _variables):
        nonlocal inflight, peak
        async with lock:
            inflight += 1
            peak = max(peak, inflight)
        await asyncio.sleep(0.05)
        async with lock:
            inflight -= 1

    db = tmp_path / "conc.db"
    client = GQLClient(
        endpoint=server_url, max_concurrency=2, on_request=on_request
    )
    store = Store(db)
    engine = HarvestEngine(
        client=client, store=store, page_size=2, max_workers=8,
        base_backoff=0.01,
    )
    async with client:
        await engine.run()
    store.close()

    # eight workers may be ready, but the semaphore caps actual HTTP fan-out
    assert peak <= 2
    assert peak == 2


@pytest.mark.asyncio
async def test_corrupted_cursor_path_ends_in_dead_letter_not_crash(
    server_url, tmp_path
):
    db = tmp_path / "corrupt.db"
    store = Store(db)
    # fabricate a checkpoint whose cursor belongs to a *different* scope,
    # simulating external tampering / a cursor copied across parents
    store.ensure_checkpoint("exp:exp-1", "exp-1", "observations")
    from graphql_harvest.server.cursors import encode_cursor

    foreign = encode_cursor("exp:exp-2", 0)
    store.advance_checkpoint("exp:exp-1", foreign, 0, True)
    store.commit()

    client = GQLClient(endpoint=server_url, max_concurrency=2)
    engine = HarvestEngine(
        client=client, store=store, page_size=3, max_workers=2,
        max_attempts=2, base_backoff=0.01, max_backoff=0.05,
    )
    async with client:
        summary = await engine.run()

    scopes = {d["scope"] for d in summary.dead_letters}
    assert "exp:exp-1" in scopes
    # unrelated data still landed
    assert store.counts()["institutions"] == 6
    store.close()
