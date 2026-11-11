"""Programmatic graphql-core schema for the three-tier connection API.

Pagination model (Relay-style, deliberately minimal):

* only forward pagination: ``first`` / ``after``
* every connection owns an independent opaque cursor whose payload carries the
  connection scope; the server rejects a cursor presented to another scope
* ``first`` is capped (``MAX_PAGE_SIZE``) so a single query cannot pull an
  unbounded amount of data — query-complexity control on the server side
* resolver failures surface as GraphQL errors with real ``path`` entries; the
  HTTP layer still returns 200 with partial ``data`` alongside ``errors``
"""

from __future__ import annotations

from typing import Any, Callable

from graphql import (
    GraphQLBoolean,
    GraphQLError,
    GraphQLField,
    GraphQLFloat,
    GraphQLInt,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLSchema,
    GraphQLString,
)

from .cursors import CursorError, decode_cursor, encode_cursor
from .failures import FailureEngine
from .seed import Dataset, dataset

DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 50


def _engine(info: Any) -> FailureEngine:
    return info.context["engine"]


# --------------------------------------------------------------------------- #
# pagination helper
# --------------------------------------------------------------------------- #

def paginate(
    ids: list[str],
    first: int | None,
    after: str | None,
    scope: str,
    owner_id: str = "*",
) -> dict[str, Any]:
    page_size = DEFAULT_PAGE_SIZE if first is None else first
    if page_size < 1:
        raise GraphQLError(f"argument 'first' must be >= 1 (got {page_size})")
    if page_size > MAX_PAGE_SIZE:
        raise GraphQLError(
            f"argument 'first'={page_size} exceeds MAX_PAGE_SIZE={MAX_PAGE_SIZE}; "
            "paginate with smaller pages"
        )
    start = 0
    if after is not None:
        try:
            start = decode_cursor(after, scope) + 1
        except CursorError as exc:
            raise GraphQLError(str(exc)) from exc

    end = start + page_size
    page = ids[start:end]
    edges = [
        {
            "cursor": encode_cursor(scope, index),
            "node_id": node_id,
            "owner_id": owner_id,
        }
        for index, node_id in enumerate(page, start=start)
    ]
    return {
        "edges": edges,
        "pageInfo": {
            "hasNextPage": end < len(ids),
            "hasPreviousPage": start > 0,
            "startCursor": edges[0]["cursor"] if edges else None,
            "endCursor": edges[-1]["cursor"] if edges else None,
        },
        "totalCount": len(ids),
    }


# --------------------------------------------------------------------------- #
# generic type builders
# --------------------------------------------------------------------------- #

def _resolve_node(kind: str) -> Callable[..., Any]:
    """Edge.node resolver shared by every connection.

    Edge objects carry the owner id so node-level failure rules can be matched
    against the full GraphQL error path (e.g.
    ``experiment.observations.edges[1].node``).
    """

    def resolve(edge: dict[str, Any], info: Any) -> dict[str, Any] | None:
        engine = _engine(info)
        engine.check_node(info.path.as_list(), edge["owner_id"], edge["node_id"])
        ds: Dataset = dataset()
        if kind == "institution":
            return ds.get_institution(edge["node_id"])
        if kind == "experiment":
            return ds.get_experiment(edge["node_id"])
        return ds.get_observation(edge["node_id"])

    return resolve


def _edge_type(name: str, node_type: GraphQLObjectType, kind: str):
    return GraphQLObjectType(
        name,
        {
            "cursor": GraphQLField(GraphQLNonNull(GraphQLString)),
            "node": GraphQLField(node_type, resolve=_resolve_node(kind)),
        },
    )


page_info_type = GraphQLObjectType(
    "PageInfo",
    {
        "hasNextPage": GraphQLField(GraphQLNonNull(GraphQLBoolean)),
        "hasPreviousPage": GraphQLField(GraphQLNonNull(GraphQLBoolean)),
        "startCursor": GraphQLField(GraphQLString),
        "endCursor": GraphQLField(GraphQLString),
    },
)


def _connection_type(name: str, edge_type: GraphQLObjectType) -> GraphQLObjectType:
    return GraphQLObjectType(
        name,
        {
            "edges": GraphQLField(GraphQLList(edge_type)),
            "pageInfo": GraphQLField(GraphQLNonNull(page_info_type)),
            "totalCount": GraphQLField(GraphQLNonNull(GraphQLInt)),
        },
    )


def _connection_args() -> dict[str, Any]:
    # Field arguments are plain GraphQL types (or GraphQLArgument), never
    # GraphQLField which is reserved for object fields.
    return {
        "first": GraphQLInt,
        "after": GraphQLString,
    }


# --------------------------------------------------------------------------- #
# entity types (lambda fields -> forward references resolved lazily)
# --------------------------------------------------------------------------- #

institution_type: GraphQLObjectType
experiment_type: GraphQLObjectType
observation_type: GraphQLObjectType


def _resolve_institution_experiments(inst: Any, info: Any, first=None, after=None):
    engine = _engine(info)
    engine.check_connection(info.path.as_list(), inst.id)
    ds = dataset()
    return paginate(
        ds.experiment_ids_of(inst.id),
        first,
        after,
        scope=f"inst:{inst.id}",
        owner_id=inst.id,
    )


def _resolve_experiment_observations(exp: Any, info: Any, first=None, after=None):
    engine = _engine(info)
    engine.check_connection(info.path.as_list(), exp.id)
    ds = dataset()
    return paginate(
        ds.observation_ids_of(exp.id),
        first,
        after,
        scope=f"exp:{exp.id}",
        owner_id=exp.id,
    )


def _resolve_observation_experiments(obs: Any, info: Any, first=None, after=None):
    engine = _engine(info)
    engine.check_connection(info.path.as_list(), obs.id)
    ds = dataset()
    return paginate(
        ds.experiment_ids_of_observation(obs.id),
        first,
        after,
        scope=f"obs:{obs.id}",
        owner_id=obs.id,
    )


observation_type = GraphQLObjectType(
    "Observation",
    lambda: {
        "id": GraphQLField(GraphQLNonNull(GraphQLString)),
        "name": GraphQLField(GraphQLString),
        "kind": GraphQLField(GraphQLString),
        "value": GraphQLField(GraphQLFloat),
        "measuredAt": GraphQLField(
            GraphQLString, resolve=lambda o, info: o.measured_at
        ),
        # reverse link: which experiments share this observation
        "experiments": GraphQLField(
            GraphQLNonNull(experiment_connection_type),
            args=_connection_args(),
            resolve=_resolve_observation_experiments,
        ),
    },
)

experiment_type = GraphQLObjectType(
    "Experiment",
    lambda: {
        "id": GraphQLField(GraphQLNonNull(GraphQLString)),
        "name": GraphQLField(GraphQLString),
        "kind": GraphQLField(GraphQLString),
        "institutionId": GraphQLField(
            GraphQLString, resolve=lambda e, info: e.institution_id
        ),
        "observations": GraphQLField(
            GraphQLNonNull(observation_connection_type),
            args=_connection_args(),
            resolve=_resolve_experiment_observations,
        ),
    },
)

institution_type = GraphQLObjectType(
    "Institution",
    lambda: {
        "id": GraphQLField(GraphQLNonNull(GraphQLString)),
        "name": GraphQLField(GraphQLString),
        "kind": GraphQLField(GraphQLString),
        "experiments": GraphQLField(
            GraphQLNonNull(experiment_connection_type),
            args=_connection_args(),
            resolve=_resolve_institution_experiments,
        ),
    },
)

institution_edge_type = _edge_type(
    "InstitutionEdge", institution_type, "institution"
)
experiment_edge_type = _edge_type(
    "ExperimentEdge", experiment_type, "experiment"
)
observation_edge_type = _edge_type(
    "ObservationEdge", observation_type, "observation"
)

institution_connection_type = _connection_type(
    "InstitutionConnection", institution_edge_type
)
experiment_connection_type = _connection_type(
    "ExperimentConnection", experiment_edge_type
)
observation_connection_type = _connection_type(
    "ObservationConnection", observation_edge_type
)


# --------------------------------------------------------------------------- #
# root query
# --------------------------------------------------------------------------- #

def _resolve_root_institutions(_root, info, first=None, after=None):
    engine = _engine(info)
    engine.check_connection(info.path.as_list(), "*")
    ds = dataset()
    return paginate(
        [i.id for i in ds.institutions.values()],
        first,
        after,
        scope="root",
        owner_id="*",
    )


query_type = GraphQLObjectType(
    "Query",
    {
        "institutions": GraphQLField(
            GraphQLNonNull(institution_connection_type),
            args=_connection_args(),
            resolve=_resolve_root_institutions,
        ),
        "institution": GraphQLField(
            institution_type,
            args={"id": GraphQLNonNull(GraphQLString)},
            resolve=lambda _r, _i, id=None: dataset().get_institution(id),
        ),
        "experiment": GraphQLField(
            experiment_type,
            args={"id": GraphQLNonNull(GraphQLString)},
            resolve=lambda _r, _i, id=None: dataset().get_experiment(id),
        ),
    },
)

SCHEMA = GraphQLSchema(query=query_type)
