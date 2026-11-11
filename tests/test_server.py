"""HTTP-level tests of the GraphQL service."""

from __future__ import annotations

import aiohttp
import pytest


async def post(server_url, payload, headers=None):
    async with aiohttp.ClientSession() as session:
        async with session.post(server_url, json=payload, headers=headers) as resp:
            return resp.status, await resp.json()


@pytest.mark.asyncio
async def test_root_connection_pagination(server_url):
    query = """
    query ($first: Int, $after: String) {
      institutions(first: $first, after: $after) {
        edges { cursor node { id name } }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        totalCount
      }
    }
    """
    status, body = await post(
        server_url, {"query": query, "variables": {"first": 3}}
    )
    assert status == 200
    conn = body["data"]["institutions"]
    assert conn["totalCount"] == 6
    assert len(conn["edges"]) == 3
    assert conn["pageInfo"]["hasNextPage"] is True

    end_cursor = conn["pageInfo"]["endCursor"]
    _, body2 = await post(
        server_url,
        {"query": query, "variables": {"first": 3, "after": end_cursor}},
    )
    page2 = body2["data"]["institutions"]
    assert len(page2["edges"]) == 3
    assert page2["pageInfo"]["hasNextPage"] is False
    ids = [e["node"]["id"] for e in conn["edges"]] + [
        e["node"]["id"] for e in page2["edges"]
    ]
    assert ids == [f"inst-{i}" for i in range(1, 7)]


@pytest.mark.asyncio
async def test_empty_connections_return_well_formed_empty_pages(server_url):
    # inst-6 has zero experiments
    query = """
    query ($id: String!) {
      institution(id: $id) {
        id
        experiments(first: 5) {
          edges { node { id } }
          pageInfo { hasNextPage startCursor endCursor }
          totalCount
        }
      }
    }
    """
    status, body = await post(
        server_url, {"query": query, "variables": {"id": "inst-6"}}
    )
    assert status == 200
    assert "errors" not in body
    conn = body["data"]["institution"]["experiments"]
    assert conn["totalCount"] == 0
    assert conn["edges"] == []
    assert conn["pageInfo"]["hasNextPage"] is False
    assert conn["pageInfo"]["startCursor"] is None
    assert conn["pageInfo"]["endCursor"] is None

    # exp-11 has zero observations
    query2 = """
    query ($id: String!) {
      experiment(id: $id) {
        observations(first: 5) {
          edges { node { id } }
          pageInfo { hasNextPage }
          totalCount
        }
      }
    }
    """
    _, body2 = await post(
        server_url, {"query": query2, "variables": {"id": "exp-11"}}
    )
    assert body2["data"]["experiment"]["observations"]["totalCount"] == 0


@pytest.mark.asyncio
async def test_cross_scope_cursor_is_rejected(server_url):
    query = """
    query ($first: Int) {
      institutions(first: $first) {
        edges { cursor }
      }
    }
    """
    _, body = await post(server_url, {"query": query, "variables": {"first": 2}})
    root_cursor = body["data"]["institutions"]["edges"][0]["cursor"]

    misuse = """
    query ($id: String!, $after: String) {
      institution(id: $id) {
        experiments(first: 2, after: $after) { edges { node { id } } }
      }
    }
    """
    status, body2 = await post(
        server_url,
        {
            "query": misuse,
            "variables": {"id": "inst-1", "after": root_cursor},
        },
    )
    # HTTP 200 with an error payload — never a transport failure
    assert status == 200
    assert body2["errors"]
    assert "scope mismatch" in body2["errors"][0]["message"]
    assert body2["errors"][0]["path"] == ["institution", "experiments"]
    assert body2["data"]["institution"] is None


@pytest.mark.asyncio
async def test_page_size_is_capped_for_complexity_control(server_url):
    query = "{ institutions(first: 999) { totalCount } }"
    status, body = await post(server_url, {"query": query})
    assert status == 200
    assert body["errors"]
    assert "MAX_PAGE_SIZE" in body["errors"][0]["message"]


@pytest.mark.asyncio
async def test_partial_response_keeps_data_and_errors_together(server_url):
    # fail one edge node inside the first page of exp-1 observations;
    # sibling edges and the connection wrapper survive.
    rules = [
        {
            "path": ["experiment", "observations", "edges", 1, "node"],
            "id": "exp-1",
            "nodeId": "obs-02",
            "times": 1,
        }
    ]
    query = """
    query ($id: String!) {
      experiment(id: $id) {
        id
        observations(first: 5) {
          edges { cursor node { id name value } }
          pageInfo { hasNextPage }
          totalCount
        }
      }
    }
    """
    status, body = await post(
        server_url,
        {"query": query, "variables": {"id": "exp-1"}},
        headers={"X-Fail-Rules": __import__("json").dumps(rules)},
    )
    assert status == 200
    # both data and errors present in one HTTP-200 payload
    assert body["data"] is not None
    assert body["errors"]
    error = body["errors"][0]
    assert error["path"] == [
        "experiment",
        "observations",
        "edges",
        1,
        "node",
    ]
    edges = body["data"]["experiment"]["observations"]["edges"]
    # the failed edge node is null, its neighbours are intact
    assert edges[0]["node"]["id"] == "obs-01"
    assert edges[1]["node"] is None
    assert edges[2]["node"]["id"] == "obs-05"
    assert body["data"]["experiment"]["observations"]["totalCount"] == 6


@pytest.mark.asyncio
async def test_connection_level_partial_error_nulls_only_that_field(server_url):
    rules = [
        {
            "path": ["institution", "experiments"],
            "id": "inst-2",
            "times": 1,
        }
    ]
    query = """
    query ($id: String!) {
      institution(id: $id) {
        id
        name
        experiments(first: 5) { edges { node { id } } totalCount }
      }
    }
    """
    status, body = await post(
        server_url,
        {"query": query, "variables": {"id": "inst-2"}},
        headers={"X-Fail-Rules": __import__("json").dumps(rules)},
    )
    assert status == 200
    assert body["errors"]
    # The experiments field is NonNull, so its null bubbles to the nearest
    # nullable parent: the whole institution object becomes null, while the
    # error path pinpoints the failed connection.
    assert body["data"]["institution"] is None
    assert body["errors"][0]["path"] == ["institution", "experiments"]
    assert "injected failure" in body["errors"][0]["message"]


@pytest.mark.asyncio
async def test_malformed_json_is_400(server_url):
    async with aiohttp.ClientSession() as session:
        async with session.post(server_url, data="{not json") as resp:
            assert resp.status == 400
