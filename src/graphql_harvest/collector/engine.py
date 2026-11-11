"""Traversal engine.

The engine walks the full institution -> experiment -> observation graph one
connection page at a time.  Guarantees implemented here:

1. **Independent cursors.**  A :class:`Job` identifies one parent connection
   (``root`` / ``inst:<id>`` / ``exp:<id>``); its cursor is loaded from and
   saved to that connection's own checkpoint row.  A cursor is never copied
   between jobs, and the server additionally rejects cross-scope cursors.
2. **Bounded complexity & concurrency.**  Each request fetches one page of one
   connection; ``page_size`` is capped client-side as well, HTTP concurrency is
   limited by the client semaphore and the number of workers is bounded.
3. **Partial responses are split.**  HTTP 200 payloads with both ``data`` and
   ``errors`` are classified by error ``path``:
   * connection-level error -> the whole page is retried from the same cursor,
     nothing from that page is committed;
   * edge/``node`` error    -> surviving edges are ingested and child jobs are
     scheduled for them; only the failed edge is recorded for retry.  The
     checkpoint is not advanced until the page completes, so the good rows are
     never fetched again on restart (idempotent upserts) while the failed edge
     keeps being retried.
4. **Restart recovery.**  Checkpoints, failed edges and dead letters are
   durable.  On startup every unfinished connection is re-enqueued from its own
   cursor; completed connections are skipped.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any

from ..server.cursors import decode_cursor
from .client import GQLClient, TransportError
from .queries import EXPERIMENTS_QUERY, INSTITUTIONS_QUERY, OBSERVATIONS_QUERY
from .store import Store

# --------------------------------------------------------------------------- #
# layer configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class LayerSpec:
    name: str
    query: str
    # response data navigation segments from the root
    connection_path: tuple[str, ...]
    scope_prefix: str | None  # None => root connection
    parent_field: str | None  # field holding the parent object ("institution"/"experiment")


LAYERS: dict[str, LayerSpec] = {
    "institutions": LayerSpec(
        name="institutions",
        query=INSTITUTIONS_QUERY,
        connection_path=("institutions",),
        scope_prefix=None,
        parent_field=None,
    ),
    "experiments": LayerSpec(
        name="experiments",
        query=EXPERIMENTS_QUERY,
        connection_path=("institution", "experiments"),
        scope_prefix="inst",
        parent_field="institution",
    ),
    "observations": LayerSpec(
        name="observations",
        query=OBSERVATIONS_QUERY,
        connection_path=("experiment", "observations"),
        scope_prefix="exp",
        parent_field="experiment",
    ),
}

CHILD_LAYER = {
    "institutions": "experiments",
    "experiments": "observations",
    "observations": None,
}


@dataclass
class Job:
    layer: str
    parent_id: str | None  # None for the root institutions connection
    attempts: int = 0

    @property
    def scope(self) -> str:
        spec = LAYERS[self.layer]
        if spec.scope_prefix is None:
            return "root"
        return f"{spec.scope_prefix}:{self.parent_id}"

    @property
    def key(self) -> str:
        return f"{self.layer}:{self.scope}"


@dataclass
class HarvestSummary:
    requests: int
    pages_ok: int
    pages_retried: int
    dead_letters: list[dict[str, Any]]
    counts: dict[str, int]
    stopped: bool = False
    error: str | None = None


# --------------------------------------------------------------------------- #
# engine
# --------------------------------------------------------------------------- #


@dataclass
class HarvestEngine:
    client: GQLClient
    store: Store
    page_size: int = 5
    max_workers: int = 4
    max_attempts: int = 8
    base_backoff: float = 0.1
    max_backoff: float = 5.0
    on_event: Any = None  # optional callable(str, dict)
    _queue: asyncio.Queue[Job | None] = field(init=False, repr=False)
    _scheduled: set[str] = field(init=False, repr=False, default_factory=set)
    _pages_ok: int = field(init=False, repr=False, default=0)
    _pages_retried: int = field(init=False, repr=False, default=0)
    _stop: bool = field(init=False, repr=False, default=False)
    _workers: list[asyncio.Task[Any]] = field(
        init=False, repr=False, default_factory=list
    )

    def __post_init__(self) -> None:
        # Unbounded queue: concurrency is bounded by the worker pool and the
        # client semaphore; the queue only holds jobs waiting for a worker.
        self._queue = asyncio.Queue()

    def emit(self, event: str, payload: dict[str, Any]) -> None:
        if self.on_event is not None:
            self.on_event(event, payload)

    # ------------------------------------------------------------------ #
    # startup / recovery
    # ------------------------------------------------------------------ #

    def _enqueue(self, job: Job) -> None:
        if job.key in self._scheduled:
            return
        self._scheduled.add(job.key)
        self._queue.put_nowait(job)
        self.emit("enqueue", {"layer": job.layer, "scope": job.scope})

    def _seed_from_checkpoints(self) -> None:
        """Re-enqueue every unfinished connection found in the durable state."""
        for cp in self.store.list_checkpoints():
            layer = cp.layer
            if layer not in LAYERS:
                continue
            parent_id = cp.parent_id
            job = Job(layer=layer, parent_id=parent_id)
            if cp.has_next == 1:
                self._enqueue(job)
            else:
                # finished connection: still mark as scheduled so it is not
                # recreated when its parent is scanned below
                self._scheduled.add(job.key)

        # parents that have rows but no child connection checkpoint yet
        # (process died before the child job ever ran)
        for inst in self.store.parent_ids("institutions"):
            self._enqueue(Job("experiments", inst))
        for exp in self.store.parent_ids("experiments"):
            self._enqueue(Job("observations", exp))

        # root always exists
        self._enqueue(Job("institutions", None))

    # ------------------------------------------------------------------ #
    # response classification
    # ------------------------------------------------------------------ #

    @staticmethod
    def _navigate(data: dict[str, Any] | None, path: tuple[str, ...]) -> Any:
        cur: Any = data
        for segment in path:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(segment)
        return cur

    def _classify_errors(
        self, spec: LayerSpec, errors: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Split GraphQL errors into connection-level vs edge-node-level."""
        conn_errors: list[dict[str, Any]] = []
        edge_errors: list[dict[str, Any]] = []
        conn_path = spec.connection_path
        for err in errors:
            path = err.get("path") or []
            if (
                len(path) >= len(conn_path)
                and tuple(path[: len(conn_path)]) == conn_path
            ):
                tail = path[len(conn_path):]
                # edge node error shape: ["edges", <index>, "node"]
                if (
                    tail
                    and tail[0] == "edges"
                    and len(tail) >= 3
                    and tail[2] == "node"
                ):
                    edge_errors.append(err)
                else:
                    conn_errors.append(err)
            else:
                # unknown error shape: be conservative, retry the whole page
                conn_errors.append(err)
        return conn_errors, edge_errors

    # ------------------------------------------------------------------ #
    # page processing
    # ------------------------------------------------------------------ #

    async def _request_page(self, job: Job) -> Any:
        spec = LAYERS[job.layer]
        cp = self.store.get_checkpoint(job.scope)
        cursor = cp.cursor if cp is not None else None
        variables: dict[str, Any] = {"first": self.page_size, "after": cursor}
        if job.parent_id is not None:
            variables["id"] = job.parent_id
        response = await self.client.execute(spec.query, variables)
        return spec, variables, response

    async def _process_job(self, job: Job) -> None:
        spec, variables, response = await self._request_page(job)
        errors = response.errors
        conn_errors, edge_errors = self._classify_errors(spec, errors)
        error_paths = [e.get("path") for e in errors]
        self.store.log_request(
            job.layer,
            job.parent_id,
            job.scope,
            response.status,
            bool(errors),
            error_paths,
            response.attempts,
        )

        # ---- whole connection failed: nothing on this page is usable ----
        if conn_errors:
            job.attempts += 1
            self._pages_retried += 1
            message = "; ".join(e.get("message", "error") for e in conn_errors)
            self.emit(
                "connection_error",
                {"scope": job.scope, "attempt": job.attempts, "message": message},
            )
            if job.attempts >= self.max_attempts:
                self.store.upsert_dead_letter(
                    job.key,
                    job.layer,
                    job.parent_id,
                    job.scope,
                    "connection",
                    job.attempts,
                    message,
                )
                self.store.commit()
                self._scheduled.discard(job.key)
                return
            self.store.commit()
            await self._requeue_with_backoff(job)
            return

        connection = self._navigate(response.data, spec.connection_path)
        if connection is None:
            # defensive: no classified error but missing data -> retry page
            job.attempts += 1
            if job.attempts >= self.max_attempts:
                self.store.upsert_dead_letter(
                    job.key, job.layer, job.parent_id, job.scope,
                    "connection", job.attempts, "connection data missing",
                )
                self.store.commit()
                self._scheduled.discard(job.key)
                return
            await self._requeue_with_backoff(job)
            return

        edges = connection.get("edges") or []
        page_info = connection["pageInfo"]
        failed_indexes = {
            err["path"][len(spec.connection_path) + 1]
            for err in edge_errors
            if len(err["path"]) > len(spec.connection_path) + 1
        }

        # global (connection-wide) position of every edge, decoded from its
        # own cursor; page-local indexes are not stable across retries
        positions: list[int] = []
        for edge in edges:
            try:
                positions.append(decode_cursor(edge["cursor"], job.scope))
            except (KeyError, ValueError):
                positions.append(len(positions))

        good_edges = [
            (idx, edge)
            for idx, edge in enumerate(edges)
            if idx not in failed_indexes
        ]

        self.store.ensure_checkpoint(
            job.scope, job.parent_id, job.layer
        )

        # ---- ingest surviving edges inside one transaction --------------
        for idx, edge in good_edges:
            node = edge.get("node")
            if node is None:
                # server returned an edge without node and without a matching
                # error entry: treat as failed edge rather than crash
                failed_indexes.add(idx)
                continue
            self._ingest_node(job, edge, positions[idx])
            self._schedule_child(job, node["id"])

        # ---- remember failed edges for the page retry -------------------
        for idx in sorted(failed_indexes):
            err = next(
                (
                    e
                    for e in edge_errors
                    if len(e["path"]) > len(spec.connection_path) + 1
                    and e["path"][len(spec.connection_path) + 1] == idx
                ),
                {"message": "node failed without error entry"},
            )
            raw_node = edges[idx].get("node")
            node_id = raw_node["id"] if isinstance(raw_node, dict) else None
            self.store.record_failed_edge(
                job.scope,
                job.parent_id,
                node_id,
                positions[idx],
                job.layer,
                err.get("message", "error"),
            )
            self.emit(
                "edge_error",
                {
                    "scope": job.scope,
                    "position": positions[idx],
                    "node_id": node_id,
                    "message": err.get("message"),
                },
            )

        if failed_indexes:
            # checkpoint stays put: re-requesting the same page retries only
            # the failed node(s); good rows are upserted again harmlessly.
            job.attempts += 1
            self._pages_retried += 1
            if job.attempts >= self.max_attempts:
                self.store.upsert_dead_letter(
                    job.key, job.layer, job.parent_id, job.scope,
                    "node", job.attempts,
                    f"failed edge positions: {sorted(positions[i] for i in failed_indexes)}",
                )
                self.store.commit()
                self._scheduled.discard(job.key)
                return
            self.store.commit()
            await self._requeue_with_backoff(job)
            return

        # ---- page fully successful: advance this connection's cursor -----
        previous = self.store.get_checkpoint(job.scope)
        done_before = previous.done if previous is not None else 0
        self.store.advance_checkpoint(
            job.scope,
            page_info.get("endCursor"),
            done_before + len(good_edges),
            bool(page_info.get("hasNextPage")),
        )
        # every edge of this connection resolved: drop its failure records
        self.store.clear_failed_edges_for_scope(job.scope)
        self.store.clear_dead_letter(job.key)
        self.store.commit()
        self._pages_ok += 1
        self.emit(
            "page_ok",
            {
                "scope": job.scope,
                "edges": len(good_edges),
                "has_next": bool(page_info.get("hasNextPage")),
            },
        )

        if page_info.get("hasNextPage"):
            # same connection, next page: drop the scheduling lock so the
            # follow-up job can be enqueued
            self._scheduled.discard(job.key)
            self._enqueue(
                Job(layer=job.layer, parent_id=job.parent_id)
            )

    # ------------------------------------------------------------------ #
    # ingestion helpers
    # ------------------------------------------------------------------ #

    def _ingest_node(self, job: Job, edge: dict[str, Any], position: int) -> None:
        node = edge["node"]
        if job.layer == "institutions":
            self.store.upsert_institution(node)
        elif job.layer == "experiments":
            self.store.upsert_experiment(node)
            self.store.link_institution_experiment(
                job.parent_id, node["id"], position
            )
        else:
            self.store.upsert_observation(node)
            self.store.link_experiment_observation(
                job.parent_id, node["id"], position
            )

    def _schedule_child(self, job: Job, node_id: str) -> None:
        child = CHILD_LAYER[job.layer]
        if child is not None:
            self._enqueue(Job(layer=child, parent_id=node_id))

    async def _requeue_with_backoff(self, job: Job) -> None:
        backoff = min(
            self.max_backoff,
            self.base_backoff * (2 ** (job.attempts - 1)),
        )
        backoff *= 0.5 + random.random()
        await asyncio.sleep(backoff)
        self._scheduled.discard(job.key)
        self._enqueue(job)

    # ------------------------------------------------------------------ #
    # worker pool
    # ------------------------------------------------------------------ #

    async def _worker(self, name: int) -> None:
        while True:
            job = await self._queue.get()
            if job is None:  # sentinel: drain complete
                self._queue.task_done()
                return
            try:
                await self._process_job(job)
            except TransportError as exc:
                # transport exhaustion: back off and requeue, unless over budget
                job.attempts += 1
                if job.attempts >= self.max_attempts:
                    self.store.upsert_dead_letter(
                        job.key, job.layer, job.parent_id, job.scope,
                        "transport", job.attempts, str(exc),
                    )
                    self.store.commit()
                    self._scheduled.discard(job.key)
                else:
                    self.emit(
                        "transport_error",
                        {"scope": job.scope, "attempt": job.attempts, "error": str(exc)},
                    )
                    await self._requeue_with_backoff(job)
            except Exception as exc:  # pragma: no cover - defensive
                self.emit("fatal_error", {"scope": job.scope, "error": repr(exc)})
                self.store.upsert_dead_letter(
                    job.key, job.layer, job.parent_id, job.scope,
                    "fatal", job.attempts + 1, repr(exc),
                )
                self.store.commit()
                self._scheduled.discard(job.key)
            finally:
                self._queue.task_done()

    async def run(self) -> HarvestSummary:
        self._seed_from_checkpoints()
        self._workers = [
            asyncio.create_task(self._worker(i))
            for i in range(max(1, self.max_workers))
        ]
        error: str | None = None
        try:
            # queue.join() completes only when every enqueued job (including
            # retries and child jobs created during processing) is finished.
            await self._queue.join()
        except asyncio.CancelledError:
            self._stop = True
            error = "cancelled"
            raise
        finally:
            for _w in self._workers:
                self._queue.put_nowait(None)
            await asyncio.gather(*self._workers, return_exceptions=True)

        dead = [d.__dict__ for d in self.store.list_dead_letters()]
        return HarvestSummary(
            requests=self.client.request_count,
            pages_ok=self._pages_ok,
            pages_retried=self._pages_retried,
            dead_letters=dead,
            counts=self.store.counts(),
            stopped=self._stop,
            error=error,
        )
