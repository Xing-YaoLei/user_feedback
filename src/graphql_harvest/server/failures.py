"""Deterministic failure injection.

Rules describe resolver failures so the service can answer HTTP 200 with a
GraphQL payload that contains **both** ``data`` and ``errors`` (the
field-level partial-response case) instead of a transport failure.

Rule JSON (sent per request via the ``X-Fail-Rules`` header, or baked into the
server through ``FAIL_RULES`` environment variable)::

    [
      {
        "path": ["institutions"],
        "times": 2,
        "message": "injected connection failure (root)"
      },
      {
        "path": ["node", "experiments"],
        "id": "inst-2",
        "times": 1
      },
      {
        "path": ["node", "observations"],
        "id": "exp-5",
        "times": 3
      },
      {
        "path": ["experiment", "observations", "edges", 1, "node"],
        "id": "exp-7",
        "nodeId": "obs-19",
        "times": 2
      }
    ]

* ``path`` is matched against the GraphQL error ``path`` (a list of strings
  and integers).  A rule path is a prefix match, which keeps it stable across
  page boundaries.
* A rule without ``nodeId`` fails the **connection field resolver**: the whole
  connection in that response is ``null`` while sibling fields survive.
* A rule with ``nodeId`` fails only that edge's node resolver; other edges of
  the same page survive (fine-grained partial error).
* ``times`` limits how many times the rule may fire; counters are kept in
  server memory.  After the budget is exhausted the same requests succeed,
  which makes the collector's retry behaviour observable and deterministic.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any


class InjectedFailure(Exception):
    """Raised inside a resolver; graphql-core converts it into an error entry."""

    def __init__(self, message: str, rule: dict[str, Any]) -> None:
        super().__init__(message)
        self.rule = rule


class FailureEngine:
    def __init__(self, rules: list[dict[str, Any]] | None = None) -> None:
        self._lock = threading.Lock()
        # rule key -> [rule dict, remaining times]
        self._rules: list[list[Any]] = []
        # signatures of already-registered rules: the client resends the
        # X-Fail-Rules header on every request (including retries), and the
        # same logical rule must not reset its own 'times' budget.
        self._signatures: set[tuple[Any, ...]] = set()
        for rule in rules or []:
            self.add_rule(rule)

    @staticmethod
    def _signature(rule: dict[str, Any]) -> tuple[Any, ...]:
        return (
            tuple(rule["path"]),
            rule.get("id", "*"),
            rule.get("nodeId"),
            rule.get("message"),
        )

    def add_rule(self, rule: dict[str, Any]) -> None:
        norm = {
            "path": list(rule["path"]),
            "id": rule.get("id", "*"),
            "nodeId": rule.get("nodeId"),
            "times": int(rule.get("times", 1)),
            "message": rule.get(
                "message",
                f"injected failure at {'.'.join(str(p) for p in rule['path'])}",
            ),
        }
        if norm["times"] < 0:
            raise ValueError("rule 'times' must be >= 0")
        signature = self._signature(norm)
        with self._lock:
            if signature in self._signatures:
                return
            self._signatures.add(signature)
            self._rules.append([norm, norm["times"]])

    def _take(self, rule_entry: list[Any]) -> bool:
        with self._lock:
            if rule_entry[1] <= 0:
                return False
            rule_entry[1] -= 1
            return True

    @staticmethod
    def _path_matches(rule_path: list[Any], error_path: list[Any]) -> bool:
        if len(rule_path) > len(error_path):
            return False
        for expected, actual in zip(rule_path, error_path):
            # integer segment in rule must match the same array index
            if isinstance(expected, int) and expected != actual:
                return False
            if isinstance(expected, str) and expected != actual:
                return False
        return True

    def _find(self, error_path: list[Any], owner_id: str, node_id: str | None):
        for entry in self._rules:
            rule, _remaining = entry
            if not self._path_matches(rule["path"], error_path):
                continue
            if rule["id"] not in ("*", owner_id):
                continue
            # node-scoped rules only fire from the edge-node resolver; a
            # connection-level check must never pick them up.
            if node_id is None and rule["nodeId"] is not None:
                continue
            if rule["nodeId"] is not None and rule["nodeId"] != node_id:
                continue
            if entry[1] <= 0:
                continue
            return entry
        return None

    def check_connection(self, error_path: list[Any], owner_id: str = "*") -> None:
        """Raise if a connection-level rule still has budget."""
        entry = self._find(error_path, owner_id, node_id=None)
        if entry is not None and self._take(entry):
            raise InjectedFailure(entry[0]["message"], entry[0])

    def check_node(
        self, error_path: list[Any], owner_id: str, node_id: str
    ) -> None:
        """Raise if an edge-node-level rule still has budget."""
        entry = self._find(error_path, owner_id, node_id=node_id)
        if entry is not None and self._take(entry):
            raise InjectedFailure(entry[0]["message"], entry[0])

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {"rule": dict(entry[0]), "remaining": entry[1]}
                for entry in self._rules
            ]


def parse_rules(raw: str | bytes | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid failure rules JSON: {exc}") from exc
    if not isinstance(data, list) or not all(isinstance(r, dict) for r in data):
        raise ValueError("failure rules must be a JSON array of rule objects")
    for rule in data:
        if "path" not in rule or not isinstance(rule["path"], list):
            raise ValueError("each failure rule needs a list 'path'")
    return data


def rules_from_env() -> list[dict[str, Any]]:
    return parse_rules(os.environ.get("FAIL_RULES"))
