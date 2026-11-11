"""Async GraphQL HTTP client.

Responsibilities (intentionally narrow):

* bound concurrency with an :class:`asyncio.Semaphore` — the collector may have
  many parent connections in flight, but only ``max_concurrency`` HTTP requests
  are ever outstanding
* optional minimum interval between requests (simple rate limiter)
* retry only **transport-level** failures (connection reset, 5xx, timeouts).
  HTTP 200 payloads containing GraphQL ``errors`` are returned untouched:
  those are partial responses the traversal engine must interpret, not
  transport errors
* expose per-request paths through an optional callback for demos/tests
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import aiohttp

RequestCallback = Callable[[str, dict[str, Any]], Awaitable[None] | None]


class TransportError(RuntimeError):
    """Raised when a request cannot be completed at the HTTP level."""


@dataclass
class GQLResponse:
    data: dict[str, Any] | None
    errors: list[dict[str, Any]]
    status: int
    attempts: int

    @property
    def has_graphql_errors(self) -> bool:
        return bool(self.errors)


@dataclass
class GQLClient:
    endpoint: str
    max_concurrency: int = 4
    min_interval: float = 0.0
    transport_retries: int = 3
    fail_rules: list[dict[str, Any]] | None = None
    on_request: RequestCallback | None = None
    request_count: int = 0
    _semaphore: asyncio.Semaphore = field(init=False, repr=False)
    _rate_lock: asyncio.Lock = field(init=False, repr=False)
    _last_request: float = field(init=False, repr=False, default=0.0)
    _session: aiohttp.ClientSession | None = field(
        init=False, repr=False, default=None
    )

    def __post_init__(self) -> None:
        self._semaphore = asyncio.Semaphore(self.max_concurrency)
        self._rate_lock = asyncio.Lock()

    async def __aenter__(self) -> "GQLClient":
        headers = {"Content-Type": "application/json"}
        if self.fail_rules:
            headers["X-Fail-Rules"] = json.dumps(self.fail_rules)
        timeout = aiohttp.ClientTimeout(total=20)
        self._session = aiohttp.ClientSession(headers=headers, timeout=timeout)
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def _throttle(self) -> None:
        if self.min_interval <= 0:
            return
        async with self._rate_lock:
            loop = asyncio.get_running_loop()
            now = loop.time()
            wait = self._last_request + self.min_interval - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request = loop.time()

    async def execute(
        self, query: str, variables: dict[str, Any] | None = None
    ) -> GQLResponse:
        assert self._session is not None, "client must be used as an async context"
        payload = {"query": query, "variables": variables or {}}
        last_exc: Exception | None = None
        attempts = 0

        for attempt in range(1, self.transport_retries + 1):
            attempts = attempt
            async with self._semaphore:
                await self._throttle()
                self.request_count += 1
                if self.on_request is not None:
                    maybe = self.on_request(query, variables or {})
                    if asyncio.iscoroutine(maybe):
                        await maybe
                try:
                    async with self._session.post(
                        self.endpoint, json=payload
                    ) as resp:
                        text = await resp.text()
                except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                    last_exc = exc
                    await asyncio.sleep(0.05 * attempt)
                    continue

            # 5xx/429 are transport problems worth retrying; everything else
            # (including 200-with-errors) is handed back to the caller.
            if resp.status in (429,) or 500 <= resp.status < 600:
                last_exc = TransportError(
                    f"HTTP {resp.status} on attempt {attempt}: {text[:200]}"
                )
                await asyncio.sleep(0.05 * attempt)
                continue

            try:
                body = json.loads(text)
            except json.JSONDecodeError as exc:
                last_exc = TransportError(f"non-JSON response: {text[:200]}")
                if attempt < self.transport_retries:
                    await asyncio.sleep(0.05 * attempt)
                    continue
                raise TransportError(str(last_exc)) from exc

            if not isinstance(body, dict):
                raise TransportError(f"unexpected response body: {body!r}")
            return GQLResponse(
                data=body.get("data"),
                errors=body.get("errors") or [],
                status=resp.status,
                attempts=attempts,
            )

        raise TransportError(
            f"request failed after {attempts} attempts: {last_exc}"
        )
