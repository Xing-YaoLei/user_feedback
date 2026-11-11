"""SQLite persistence for harvested data and traversal state.

Design points required by the task:

* **Nodes and links live in different tables.**  A shared observation is
  upserted once into ``observations`` while every parent/child link gets its
  own row in ``experiment_observations`` (with a UNIQUE constraint enforcing
  no duplicate relationship).
* **Checkpoints are per connection.**  One row per parent connection
  (``root`` / ``inst:<id>`` / ``exp:<id>``) holding that connection's own
  cursor — cursors are never shared across parents.
* **Page ingest + checkpoint advance are one transaction.**  If the process
  dies mid-page, the next run re-requests the same page; idempotent upserts
  make the re-fetch harmless (no duplicate nodes or links).
* **Failed edges are remembered separately** in ``failed_edges`` so a
  partially successful page keeps its good rows while only the failed path is
  retried.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# --------------------------------------------------------------------------- #
# dataclasses
# --------------------------------------------------------------------------- #

@dataclass
class Checkpoint:
    scope: str
    parent_id: str | None
    layer: str  # institutions | experiments | observations
    cursor: str | None
    done: int
    has_next: int
    updated_at: str


@dataclass
class FailedEdge:
    scope: str
    parent_id: str | None
    node_id: str
    position: int
    layer: str
    attempts: int
    last_error: str


@dataclass
class DeadLetter:
    job_key: str
    layer: str
    parent_id: str | None
    scope: str
    kind: str  # connection | node
    attempts: int
    last_error: str


@dataclass
class ObservationPath:
    observation_id: str
    observation_name: str
    institution_id: str
    institution_name: str
    experiment_id: str
    experiment_name: str
    position: int


# --------------------------------------------------------------------------- #
# store
# --------------------------------------------------------------------------- #

class Store:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._create_schema()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _create_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS institutions (
                id   TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT
            );

            CREATE TABLE IF NOT EXISTS experiments (
                id             TEXT PRIMARY KEY,
                name           TEXT NOT NULL,
                kind           TEXT,
                institution_id TEXT NOT NULL
            );

            -- shared nodes: one row per observation, regardless of how many
            -- experiments link to it
            CREATE TABLE IF NOT EXISTS observations (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                kind        TEXT,
                value       REAL,
                measured_at TEXT
            );

            -- relationships stored separately; UNIQUE prevents duplicates
            CREATE TABLE IF NOT EXISTS institution_experiments (
                institution_id TEXT NOT NULL,
                experiment_id  TEXT NOT NULL,
                position       INTEGER NOT NULL,
                PRIMARY KEY (institution_id, experiment_id)
            );

            CREATE TABLE IF NOT EXISTS experiment_observations (
                experiment_id  TEXT NOT NULL,
                observation_id TEXT NOT NULL,
                position       INTEGER NOT NULL,
                PRIMARY KEY (experiment_id, observation_id)
            );

            -- one independent cursor per parent connection
            CREATE TABLE IF NOT EXISTS checkpoints (
                scope     TEXT PRIMARY KEY,
                parent_id TEXT,
                layer     TEXT NOT NULL,
                cursor    TEXT,
                done      INTEGER NOT NULL DEFAULT 0,
                has_next  INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- edges whose node resolver failed inside an otherwise good page.
            -- position is the edge's stable index inside its connection, so
            -- the record is identifiable even when the node comes back null.
            CREATE TABLE IF NOT EXISTS failed_edges (
                scope      TEXT NOT NULL,
                parent_id  TEXT,
                node_id    TEXT,
                position   INTEGER NOT NULL,
                layer      TEXT NOT NULL,
                attempts   INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                PRIMARY KEY (scope, position)
            );

            -- paths that exhausted the retry budget
            CREATE TABLE IF NOT EXISTS dead_letters (
                job_key    TEXT PRIMARY KEY,
                layer      TEXT NOT NULL,
                parent_id  TEXT,
                scope      TEXT NOT NULL,
                kind       TEXT NOT NULL,
                attempts   INTEGER NOT NULL,
                last_error TEXT
            );

            CREATE TABLE IF NOT EXISTS request_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                layer      TEXT NOT NULL,
                parent_id  TEXT,
                scope      TEXT NOT NULL,
                status     INTEGER NOT NULL,
                has_errors INTEGER NOT NULL,
                error_paths TEXT,
                attempts   INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            """
        )
        self._conn.commit()

    # ------------------------------------------------------------------ #
    # node / link ingestion (idempotent)
    # ------------------------------------------------------------------ #

    def upsert_institution(self, node: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT INTO institutions(id, name, kind) VALUES (?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind",
            (node["id"], node.get("name"), node.get("kind")),
        )

    def upsert_experiment(self, node: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT INTO experiments(id, name, kind, institution_id) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, "
            "institution_id=excluded.institution_id",
            (
                node["id"],
                node.get("name"),
                node.get("kind"),
                node.get("institutionId"),
            ),
        )

    def upsert_observation(self, node: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT INTO observations(id, name, kind, value, measured_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, "
            "value=excluded.value, measured_at=excluded.measured_at",
            (
                node["id"],
                node.get("name"),
                node.get("kind"),
                node.get("value"),
                node.get("measuredAt"),
            ),
        )

    def link_institution_experiment(
        self, institution_id: str, experiment_id: str, position: int
    ) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO institution_experiments"
            "(institution_id, experiment_id, position) VALUES (?, ?, ?)",
            (institution_id, experiment_id, position),
        )

    def link_experiment_observation(
        self, experiment_id: str, observation_id: str, position: int
    ) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO experiment_observations"
            "(experiment_id, observation_id, position) VALUES (?, ?, ?)",
            (experiment_id, observation_id, position),
        )

    # ------------------------------------------------------------------ #
    # checkpoints
    # ------------------------------------------------------------------ #

    def get_checkpoint(self, scope: str) -> Checkpoint | None:
        row = self._conn.execute(
            "SELECT * FROM checkpoints WHERE scope=?", (scope,)
        ).fetchone()
        if row is None:
            return None
        return Checkpoint(**dict(row))

    def ensure_checkpoint(self, scope: str, parent_id: str | None, layer: str) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO checkpoints(scope, parent_id, layer) "
            "VALUES (?, ?, ?)",
            (scope, parent_id, layer),
        )

    def advance_checkpoint(
        self, scope: str, cursor: str | None, done: int, has_next: bool
    ) -> None:
        self._conn.execute(
            "UPDATE checkpoints SET cursor=?, done=?, has_next=?, "
            "updated_at=datetime('now') WHERE scope=?",
            (cursor, done, int(has_next), scope),
        )

    def list_checkpoints(self) -> list[Checkpoint]:
        rows = self._conn.execute(
            "SELECT * FROM checkpoints ORDER BY scope"
        ).fetchall()
        return [Checkpoint(**dict(r)) for r in rows]

    def unfinished_scopes(self) -> list[Checkpoint]:
        """Connections that were started but never reached the last page."""
        return [
            cp
            for cp in self.list_checkpoints()
            if cp.has_next == 1
        ]

    # ------------------------------------------------------------------ #
    # failed edges
    # ------------------------------------------------------------------ #

    def record_failed_edge(
        self,
        scope: str,
        parent_id: str | None,
        node_id: str | None,
        position: int,
        layer: str,
        error: str,
    ) -> None:
        self._conn.execute(
            "INSERT INTO failed_edges(scope, parent_id, node_id, position, layer, "
            "attempts, last_error) VALUES (?, ?, ?, ?, ?, 1, ?) "
            "ON CONFLICT(scope, position) DO UPDATE SET attempts=attempts+1, "
            "node_id=COALESCE(excluded.node_id, failed_edges.node_id), "
            "last_error=excluded.last_error",
            (scope, parent_id, node_id, position, layer, error),
        )

    def clear_failed_edge(self, scope: str, node_id: str) -> None:
        self._conn.execute(
            "DELETE FROM failed_edges WHERE scope=? AND node_id=?",
            (scope, node_id),
        )

    def clear_failed_edges_for_scope(self, scope: str) -> None:
        """All edges of this connection were fetched successfully."""
        self._conn.execute("DELETE FROM failed_edges WHERE scope=?", (scope,))

    def list_failed_edges(self) -> list[FailedEdge]:
        rows = self._conn.execute("SELECT * FROM failed_edges").fetchall()
        return [FailedEdge(**dict(r)) for r in rows]

    # ------------------------------------------------------------------ #
    # dead letters
    # ------------------------------------------------------------------ #

    def upsert_dead_letter(
        self,
        job_key: str,
        layer: str,
        parent_id: str | None,
        scope: str,
        kind: str,
        attempts: int,
        last_error: str,
    ) -> None:
        self._conn.execute(
            "INSERT INTO dead_letters(job_key, layer, parent_id, scope, kind, "
            "attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(job_key) DO UPDATE SET attempts=excluded.attempts, "
            "last_error=excluded.last_error",
            (job_key, layer, parent_id, scope, kind, attempts, last_error),
        )

    def clear_dead_letter(self, job_key: str) -> None:
        self._conn.execute("DELETE FROM dead_letters WHERE job_key=?", (job_key,))

    def list_dead_letters(self) -> list[DeadLetter]:
        rows = self._conn.execute("SELECT * FROM dead_letters").fetchall()
        return [DeadLetter(**dict(r)) for r in rows]

    # ------------------------------------------------------------------ #
    # request log
    # ------------------------------------------------------------------ #

    def log_request(
        self,
        layer: str,
        parent_id: str | None,
        scope: str,
        status: int,
        has_errors: bool,
        error_paths: list[list[Any]],
        attempts: int,
    ) -> None:
        self._conn.execute(
            "INSERT INTO request_log(layer, parent_id, scope, status, has_errors, "
            "error_paths, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                layer,
                parent_id,
                scope,
                status,
                int(has_errors),
                json.dumps(error_paths),
                attempts,
            ),
        )

    # ------------------------------------------------------------------ #
    # queries for verification / trace CLI
    # ------------------------------------------------------------------ #

    def counts(self) -> dict[str, int]:
        def scalar(sql: str) -> int:
            return self._conn.execute(sql).fetchone()[0]

        return {
            "institutions": scalar("SELECT count(*) FROM institutions"),
            "experiments": scalar("SELECT count(*) FROM experiments"),
            "observations": scalar("SELECT count(*) FROM observations"),
            "institution_experiment_links": scalar(
                "SELECT count(*) FROM institution_experiments"
            ),
            "experiment_observation_links": scalar(
                "SELECT count(*) FROM experiment_observations"
            ),
            "checkpoints": scalar("SELECT count(*) FROM checkpoints"),
            "failed_edges": scalar("SELECT count(*) FROM failed_edges"),
            "dead_letters": scalar("SELECT count(*) FROM dead_letters"),
            "requests": scalar("SELECT count(*) FROM request_log"),
        }

    def duplicate_link_count(self) -> int:
        """Rows that would be duplicates if the UNIQUE constraint didn't exist."""
        rows = self._conn.execute(
            "SELECT experiment_id, observation_id, count(*) c "
            "FROM experiment_observations GROUP BY 1, 2 HAVING c > 1"
        ).fetchall()
        return sum(r["c"] - 1 for r in rows)

    def observation_paths(self, observation_id: str) -> list[ObservationPath]:
        rows = self._conn.execute(
            """
            SELECT o.id AS observation_id, o.name AS observation_name,
                   i.id AS institution_id, i.name AS institution_name,
                   e.id AS experiment_id, e.name AS experiment_name,
                   eo.position AS position
            FROM observations o
            JOIN experiment_observations eo ON eo.observation_id = o.id
            JOIN experiments e ON e.id = eo.experiment_id
            JOIN institutions i ON i.id = e.institution_id
            WHERE o.id = ?
            ORDER BY i.id, e.id
            """,
            (observation_id,),
        ).fetchall()
        return [ObservationPath(**dict(r)) for r in rows]

    def experiment_parent(self, experiment_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM experiments WHERE id=?", (experiment_id,)
        ).fetchone()

    def parent_ids(self, table: str) -> list[str]:
        if table not in ("institutions", "experiments"):
            raise ValueError(table)
        rows = self._conn.execute(f"SELECT id FROM {table} ORDER BY id").fetchall()
        return [r["id"] for r in rows]

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()
