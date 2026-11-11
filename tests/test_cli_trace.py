"""Tests for the ``harvest trace`` CLI and store-level lineage queries."""

from __future__ import annotations

import pytest

from graphql_harvest.cli import build_parser, trace
from graphql_harvest.collector.client import GQLClient
from graphql_harvest.collector.engine import HarvestEngine
from graphql_harvest.collector.store import Store


async def _harvest(server_url, db_path, **kwargs):
    client = GQLClient(endpoint=server_url, max_concurrency=4)
    store = Store(db_path)
    engine = HarvestEngine(
        client=client, store=store, page_size=3, max_workers=4,
        base_backoff=0.01, max_backoff=0.1, **kwargs,
    )
    async with client:
        await engine.run()
    return store


@pytest.mark.asyncio
async def test_trace_lists_every_source_path_of_a_shared_node(
    server_url, tmp_path, capsys
):
    db = tmp_path / "trace.db"
    store = await _harvest(server_url, db)
    store.close()

    parser = build_parser()
    args = parser.parse_args(["trace", "obs-19", "--db", str(db)])
    rc = trace(args)
    out = capsys.readouterr().out

    assert rc == 0
    # obs-19 is shared by exp-1, exp-7, exp-9 under three institutions
    assert "3 path(s)" in out
    for fragment in (
        "inst-1 (Alpha Institute) -> exp-1",
        "inst-4 (Delta Institute) -> exp-7",
        "inst-5 (Epsilon Institute) -> exp-9",
        "obs-19 (gas chromatogram)",
        "checkpoint",
    ):
        assert fragment in out


@pytest.mark.asyncio
async def test_trace_experiment_shows_parent_and_checkpoint(
    server_url, tmp_path, capsys
):
    db = tmp_path / "trace2.db"
    store = await _harvest(server_url, db)
    store.close()

    args = build_parser().parse_args(["trace", "exp-3", "--db", str(db)])
    rc = trace(args)
    out = capsys.readouterr().out
    assert rc == 0
    assert "experiment exp-3" in out
    assert "parent institution: inst-2" in out
    assert "scope=exp:exp-3" in out


@pytest.mark.asyncio
async def test_trace_unknown_node_returns_exit_code_2(
    server_url, tmp_path, capsys
):
    db = tmp_path / "trace3.db"
    store = await _harvest(server_url, db)
    store.close()

    args = build_parser().parse_args(["trace", "nope-99", "--db", str(db)])
    rc = trace(args)
    assert rc == 2
    assert "not found" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_observation_paths_query_matches_stored_links(server_url, tmp_path):
    db = tmp_path / "trace4.db"
    store = await _harvest(server_url, db)

    paths = store.observation_paths("obs-05")
    # obs-05 belongs to exp-1, exp-5 and exp-10
    assert sorted(p.experiment_id for p in paths) == [
        "exp-1",
        "exp-10",
        "exp-5",
    ]
    assert all(p.observation_name == "ph reading" for p in paths)
    # every path carries full institution lineage
    assert {p.institution_id for p in paths} == {"inst-1", "inst-3", "inst-5"}
    store.close()
