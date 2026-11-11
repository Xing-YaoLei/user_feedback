"""aiohttp application exposing the schema over HTTP POST.

Response semantics on purpose:

* well-formed GraphQL requests always answer **HTTP 200**, even when the
  payload contains ``errors`` (standard GraphQL-over-HTTP behaviour)
* a partial execution yields both ``data`` (with ``null`` at the failed field)
  and ``errors`` (with the field ``path``); the collector uses the paths to
  retry only the failed subtree
* malformed JSON / missing query -> HTTP 400
* failure rules live in one process-wide :class:`FailureEngine` stored on the
  app, so a rule's ``times`` budget counts across requests (and therefore
  across collector retries); per-request rules from the ``X-Fail-Rules``
  header are merged into that same engine
"""

from __future__ import annotations

import json
from typing import Any

from aiohttp import web
from graphql import ExecutionResult, execute, parse, validate

from .failures import FailureEngine, parse_rules, rules_from_env
from .schema import SCHEMA

FAIL_RULES_HEADER = "X-Fail-Rules"
FAILURE_ENGINE_KEY = web.AppKey("failure_engine", FailureEngine)


def _format_result(result: ExecutionResult) -> dict[str, Any]:
    payload: dict[str, Any] = {"data": result.data}
    if result.errors:
        payload["errors"] = [
            {"message": str(e), "path": e.path} for e in result.errors
        ]
    return payload


async def handle_graphql(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response(
            {"errors": [{"message": "request body must be valid JSON"}]},
            status=400,
        )
    if not isinstance(body, dict) or "query" not in body:
        return web.json_response(
            {"errors": [{"message": "missing 'query' string in JSON body"}]},
            status=400,
        )

    query = body["query"]
    variables = body.get("variables") or None
    operation_name = body.get("operationName")

    try:
        document = parse(query)
    except Exception as exc:  # GraphQLError on syntax problems
        return web.json_response(
            {"data": None, "errors": [{"message": str(exc), "path": None}]},
            status=200,
        )

    validation_errors = validate(SCHEMA, document)
    if validation_errors:
        return web.json_response(
            _format_result(ExecutionResult(data=None, errors=validation_errors)),
            status=200,
        )

    # process-wide engine: failure budgets span requests/retries
    engine = request.app[FAILURE_ENGINE_KEY]
    header_raw = request.headers.get(FAIL_RULES_HEADER)
    try:
        for rule in parse_rules(header_raw):
            engine.add_rule(rule)
    except ValueError as exc:
        return web.json_response(
            {"errors": [{"message": str(exc), "path": None}]}, status=400
        )

    result = execute(
        SCHEMA,
        document,
        variable_values=variables,
        operation_name=operation_name,
        context_value={"engine": engine},
    )
    # execute() is synchronous with graphql-core; all our resolvers are sync.
    return web.json_response(_format_result(result), status=200)


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


def create_app() -> web.Application:
    app = web.Application()
    app[FAILURE_ENGINE_KEY] = FailureEngine(rules_from_env())
    app.router.add_post("/graphql", handle_graphql)
    app.router.add_get("/health", handle_health)
    return app


def run(host: str = "127.0.0.1", port: int = 8080) -> None:
    web.run_app(create_app(), host=host, port=port)


if __name__ == "__main__":
    run()
