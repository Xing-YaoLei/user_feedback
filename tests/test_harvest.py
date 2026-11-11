"""End-to-end collector tests against the real aiohttp service."""

from __future__ import annotations

import asyncio

import pytest

from graphql_harvest.collector.client import GQLClient
from graphql_harvest.collector.engine import HarvestEngine
from graphql_harvest.collector.store import Store
from graphql_harvest.server.cursors import decode_cursor
from graphql_harvest.server.seed import (
    EXPERIMENT_OBSERVATIONS,
    OBSERVATIONS,
)

EXPECTED_LINKS = sum(len(v) for v in EXPERIMENT_OBSERVATIONS.values())


def make_engine(server_url, db_path, *, fail_rules=None, **kwargs):
    client = GQLClient(
        endpoint=server_url,
        max_concurrency=kwargs.pop("max_concurrency", 4),
        fail_rules=fail_rules,
    )
    store = Store(db_path)
    engine = HarvestEngine(
        client=client,
        store=store,
        page_size=kwargs.pop("page_size", 5),
        max_workers=kwargs.pop("max_workers", 4),
        base_backoff=kwargs.pop("base_backoff", 0.01),
        max_backoff=kwargs.pop("max_backoff", 0.1),
        **kwargs,
    )
    return client, store, engine


async def run_harvest(server_url, db_path, **kwargs):
    client, store, engine = make_engine(server_url, db_path, **kwargs)
    async with client:
        summary = await engine.run()
    return store, summary


# --------------------------------------------------------------------------- #
# completeness
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_full_harvest_completeness(server_url, tmp_path):
    db = tmp_path / "harvest.db"
    store, summary = await run_harvest(server_url, db)

    assert summary.dead_letters == []
    counts = store.counts()
    assert counts["institutions"] == 6
    assert counts["experiments"] == 11
    assert counts["observations"] == len(OBSERVATIONS)  # 20 unique nodes
    assert counts["institution_experiment_links"] == 11
    assert counts["experiment_observation_links"] == EXPECTED_LINKS  # 46
    assert counts["failed_edges"] == 0
    assert counts["dead_letters"] == 0

    # one independent checkpoint per parent connection
    checkpoints = {cp.scope: cp for cp in store.list_checkpoints()}
    assert set(checkpoints) == {"root"} | {
        f"inst:inst-{i}" for i in range(1, 7)
    } | {f"exp:exp-{i}" for i in range(1, 12)}
    for cp in checkpoints.values():
        assert cp.has_next == 0  # every connection reached its last page

    # done counts match the underlying dataset
    assert checkpoints["root"].done == 6
    assert checkpoints["inst:inst-1"].done == 2
    assert checkpoints["exp:exp-1"].done == 6
    store.close()


@pytest.mark.asyncio
async def test_empty_connections_complete_without_jobs_left(server_url, tmp_path):
    db = tmp_path / "harvest.db"
    store, _ = await run_harvest(server_url, db)
    cp_empty_inst = store.get_checkpoint("inst:inst-6")
    cp_empty_exp = store.get_checkpoint("exp:exp-11")
    assert cp_empty_inst.done == 0 and cp_empty_inst.has_next == 0
    assert cp_empty_exp.done == 0 and cp_empty_exp.has_next == 0
    store.close()


# --------------------------------------------------------------------------- #
# relationship storage: shared node once, links separately, never duplicated
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_shared_observation_stored_once_with_multiple_links(
    server_url, tmp_path
):
    db = tmp_path / "harvest.db"
    store, _ = await run_harvest(server_url, db)

    # obs-01 is shared by exp-1 and exp-2 in the seed data
    row = store._conn.execute(
        "SELECT count(*) c FROM observations WHERE id='obs-01'"
    ).fetchone()
    assert row["c"] == 1

    links = store._conn.execute(
        "SELECT experiment_id FROM experiment_observations "
        "WHERE observation_id='obs-01' ORDER BY experiment_id"
    ).fetchall()
    assert [r["experiment_id"] for r in links] == ["exp-1", "exp-2"]

    # every shared observation's link fan-out matches the seed
    seed_fanout: dict[str, set[str]] = {}
    for exp_id, obs_ids in EXPERIMENT_OBSERVATIONS.items():
        for obs_id in obs_ids:
            seed_fanout.setdefault(obs_id, set()).add(exp_id)
    for obs_id, expected_parents in seed_fanout.items():
        got = {
            r["experiment_id"]
            for r in store._conn.execute(
                "SELECT experiment_id FROM experiment_observations "
                "WHERE observation_id=?",
                (obs_id,),
            ).fetchall()
        }
        assert got == expected_parents, obs_id

    assert store.duplicate_link_count() == 0
    store.close()


def test_link_upserts_are_idempotent(tmp_path):
    store = Store(tmp_path / "idempotent.db")
    store.upsert_institution({"id": "inst-1", "name": "a", "kind": "inst"})
    store.upsert_experiment(
        {"id": "exp-1", "name": "e", "kind": "exp", "institutionId": "inst-1"}
    )
    store.upsert_observation(
        {"id": "obs-1", "name": "o", "kind": "obs", "value": 1.0, "measuredAt": "t"}
    )
    for _ in range(3):  # re-fetching the same page must not duplicate rows
        store.link_experiment_observation("exp-1", "obs-1", 0)
        store.link_institution_experiment("inst-1", "exp-1", 0)
    store.commit()
    assert store.counts()["experiment_observation_links"] == 1
    assert store.counts()["institution_experiment_links"] == 1
    assert store.duplicate_link_count() == 0
    store.close()


# --------------------------------------------------------------------------- #
# per-parent cursor independence
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_each_parent_keeps_its_own_cursor(server_url, tmp_path):
    db = tmp_path / "cursors.db"
    store, _ = await run_harvest(server_url, db, page_size=2)

    cp1 = store.get_checkpoint("exp:exp-1")
    cp2 = store.get_checkpoint("exp:exp-2")
    # cursors are opaque strings encoding the owning scope ...
    assert cp1.cursor != cp2.cursor
    assert decode_cursor(cp1.cursor, "exp:exp-1") >= 0
    with pytest.raises(Exception):
        decode_cursor(cp1.cursor, "exp:exp-2")

    # every persisted cursor only decodes under its own checkpoint scope
    for cp in store.list_checkpoints():
        if cp.cursor is not None:
            decode_cursor(cp.cursor, cp.scope)  # raises on mismatch
    store.close()


# --------------------------------------------------------------------------- #
# partial errors: good subtree kept, failed path retried, no whole-page loss
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_partial_errors_keep_good_subtree_and_retry_failed_path(
    server_url, tmp_path
):
    db = tmp_path / "partial.db"
    fail_rules = [
        # connection-level failure on one institution, twice
        {
            "path": ["institution", "experiments"],
            "id": "inst-3",
            "times": 2,
        },
        # edge-node failure: obs-09 on the first page of exp-7, twice
        {
            "path": ["experiment", "observations", "edges", 2, "node"],
            "id": "exp-7",
            "nodeId": "obs-09",
            "times": 2,
        },
        # root connection fails once
        {"path": ["institutions"], "times": 1},
    ]
    store, summary = await run_harvest(
        server_url, db, fail_rules=fail_rules, max_attempts=8
    )

    # retries happened, but the run still converged with nothing dead
    assert summary.pages_retried >= 4
    assert summary.dead_letters == []
    counts = store.counts()
    assert counts["institutions"] == 6
    assert counts["experiments"] == 11
    assert counts["observations"] == 20
    assert counts["experiment_observation_links"] == EXPECTED_LINKS
    assert counts["failed_edges"] == 0
    assert store.duplicate_link_count() == 0

    # request log contains HTTP-200 responses flagged as carrying errors
    errored = store._conn.execute(
        "SELECT DISTINCT scope FROM request_log WHERE has_errors=1"
    ).fetchall()
    scopes = {r["scope"] for r in errored}
    assert "root" in scopes
    assert "inst:inst-3" in scopes
    assert "exp:exp-7" in scopes

    # every logged request was HTTP 200: partial errors never become 5xx here
    statuses = {
        r["status"]
        for r in store._conn.execute("SELECT DISTINCT status FROM request_log")
    }
    assert statuses == {200}
    store.close()


@pytest.mark.asyncio
async def test_exhausted_retry_budget_becomes_dead_letter_without_losing_rest(
    server_url, tmp_path
):
    db = tmp_path / "dead.db"
    fail_rules = [
        {
            "path": ["experiment", "observations"],
            "id": "exp-5",
            "times": 100,  # never recovers within the run
        }
    ]
    store, summary = await run_harvest(
        server_url, db, fail_rules=fail_rules, max_attempts=3
    )

    assert len(summary.dead_letters) == 1
    dl = summary.dead_letters[0]
    assert dl["scope"] == "exp:exp-5"
    assert dl["kind"] == "connection"
    assert dl["attempts"] == 3

    # everything unrelated to the dead path is still harvested
    assert store.counts()["institutions"] == 6
    assert store.counts()["experiments"] == 11
    missing_links = store._conn.execute(
        "SELECT count(*) c FROM experiment_observations WHERE experiment_id='exp-5'"
    ).fetchone()
    assert missing_links["c"] == 0
    other_links = store._conn.execute(
        "SELECT count(*) c FROM experiment_observations WHERE experiment_id != 'exp-5'"
    ).fetchone()
    assert other_links["c"] == EXPECTED_LINKS - 6
    store.close()


@pytest.mark.asyncio
async def test_dead_letter_is_cleared_when_path_recovers_on_restart(
    tmp_path
):
    from aiohttp import web

    from graphql_harvest.server.app import create_app

    async def fresh_server():
        runner = web.AppRunner(create_app())
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        url = (
            f"http://127.0.0.1:"
            f"{site._server.sockets[0].getsockname()[1]}/graphql"
        )
        return runner, url

    db = tmp_path / "recover.db"
    rules = [
        {
            "path": ["experiment", "observations"],
            "id": "exp-5",
            "times": 1000,
        }
    ]

    # phase 1: unhealthy server -> exp-5 exhausts its budget
    runner1, url1 = await fresh_server()
    store, summary = await run_harvest(
        url1, db, fail_rules=rules, max_attempts=2
    )
    assert any(d["scope"] == "exp:exp-5" for d in summary.dead_letters)
    store.close()
    await runner1.cleanup()

    # phase 2: brand-new healthy server, same database, no manual cleanup
    runner2, url2 = await fresh_server()
    store2, summary2 = await run_harvest(url2, db)
    await runner2.cleanup()

    assert summary2.dead_letters == []
    assert store2.list_dead_letters() == []
    assert (
        store2._conn.execute(
            "SELECT count(*) c FROM experiment_observations "
            "WHERE experiment_id='exp-5'"
        ).fetchone()["c"]
        == 6
    )
    assert store2.duplicate_link_count() == 0
    store2.close()


# --------------------------------------------------------------------------- #
# restart recovery
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_restart_resumes_from_per_parent_checkpoints(server_url, tmp_path):
    db = tmp_path / "restart.db"

    # --- first run: cancelled after a few requests -----------------------
    client, store, engine = make_engine(server_url, db, page_size=3)
    task = asyncio.create_task(_run(engine, client))

    async def canceller() -> None:
        while client.request_count < 4:
            await asyncio.sleep(0.01)
        task.cancel()

    cancel_task = asyncio.create_task(canceller())
    with pytest.raises(asyncio.CancelledError):
        await task
    await cancel_task
    partial = store.counts()
    assert partial["institutions"] >= 1
    assert partial["checkpoints"] >= 1
    # some connections must still be unfinished
    assert store.unfinished_scopes()
    store.close()

    # --- second run on the same db: resumes and completes ----------------
    store2, summary = await run_harvest(server_url, db, page_size=3)
    assert summary.dead_letters == []
    counts = store2.counts()
    assert counts["institutions"] == 6
    assert counts["experiments"] == 11
    assert counts["observations"] == 20
    assert counts["experiment_observation_links"] == EXPECTED_LINKS
    assert store2.duplicate_link_count() == 0
    assert not store2.unfinished_scopes()
    store2.close()


async def _run(engine, client):
    async with client:
        return await engine.run()


# --------------------------------------------------------------------------- #
# concurrency: different layers paginate at the same time
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_different_layers_paginate_concurrently(server_url, tmp_path):
    db = tmp_path / "concurrent.db"
    seen: list[str] = []

    async def on_request(_query, variables):
        if "institutions" in _query:
            seen.append("institutions")
        elif "institution(id" in _query:
            seen.append("experiments")
        else:
            seen.append("observations")

    client = GQLClient(
        endpoint=server_url, max_concurrency=4, on_request=on_request
    )
    store = Store(db)
    engine = HarvestEngine(
        client=client, store=store, page_size=2, max_workers=4,
        base_backoff=0.01,
    )
    async with client:
        await engine.run()

    first_exp = seen.index("experiments")
    last_inst = len(seen) - 1 - seen[::-1].index("institutions")
    first_obs = seen.index("observations")
    last_exp = len(seen) - 1 - seen[::-1].index("experiments")
    # child-layer pages start while the parent layer is still paginating
    assert first_exp < last_inst
    assert first_obs < last_exp
    store.close()
