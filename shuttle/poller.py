"""班车到站数据轮询调度器。

并发模型：
- max_concurrency（需求为 3）个工作线程，同时在途请求总数不超过该值
- 每个园区同一时刻最多一个请求在途：到期堆中每个园区只保留最新一代条目，
  工作线程弹出条目后置 in_flight，请求结束才重新排期
- 多个园区同时到期时按 next_due 从小到大（等待最久）依次领取，
  同时间由入堆序号保证确定性

HTTP 语义：
- 携带 If-None-Match 做 ETag 条件请求
- 200：发布新快照（替换最近一次成功快照），恢复常规间隔
- 304：快照不变，只记录检查时间，按常规间隔继续
- 429：按响应 Retry-After 秒数安排下一次请求；头缺失时退回有上限退避
- 超时 / 5xx / 连接错误：有上限的指数退避，成功后清零并恢复常规间隔
"""

from __future__ import annotations

import heapq
import json
import logging
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

from .backoff import next_backoff, parse_retry_after
from .config import Config
from .model import ParkState, Snapshot

LOGGER = logging.getLogger("shuttle.poller")
MAX_EVENTS = 500


@dataclass
class TransportResult:
    """一次 HTTP 请求的结果。status 为 None 表示网络层失败。"""

    status: int | None
    etag: str | None = None
    body: Any = None
    retry_after: str | None = None
    error: str | None = None
    timed_out: bool = False


def http_transport(url: str, timeout: float, etag: str | None) -> TransportResult:
    """基于 urllib 的条件 GET，无第三方依赖。"""
    headers = {"Accept": "application/json"}
    if etag:
        headers["If-None-Match"] = etag
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return TransportResult(
                status=response.status,
                etag=response.headers.get("ETag"),
                body=json.loads(raw.decode("utf-8")) if raw else None,
            )
    except urllib.error.HTTPError as exc:
        # 429/5xx 也是合法响应，需要读取 Retry-After 等头
        return TransportResult(
            status=exc.code,
            etag=exc.headers.get("ETag") if exc.headers else None,
            retry_after=exc.headers.get("Retry-After") if exc.headers else None,
            error=exc.reason,
        )
    except (TimeoutError, socket.timeout) as exc:
        return TransportResult(status=None, error=f"timeout: {exc}", timed_out=True)
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return TransportResult(status=None, error=f"timeout: {reason}", timed_out=True)
        return TransportResult(status=None, error=f"request error: {reason}")


Transport = Callable[[str, float, str | None], TransportResult]


class Scheduler:
    def __init__(
        self,
        config: Config,
        transport: Transport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._transport: Transport = transport or http_transport
        self._clock = clock
        self._states: dict[str, ParkState] = {
            p.park_id: ParkState(
                park_id=p.park_id,
                url=p.url,
                interval=p.interval_seconds,
                timeout=p.timeout_seconds,
                next_due=clock(),
            )
            for p in config.parks
        }
        self._heap: list[tuple[float, int, str]] = []
        self._seq = 0
        self._condition = threading.Condition()
        self._stop_event = threading.Event()
        self._workers = [
            threading.Thread(target=self._worker_loop, name=f"poller-{i + 1}", daemon=True)
            for i in range(max(1, config.max_concurrency))
        ]
        self._events: list[dict[str, Any]] = []
        self._events_lock = threading.Lock()

    # ---- 生命周期 -------------------------------------------------------
    def start(self) -> None:
        with self._condition:
            # next_due 在构造时已统一设为当前时间；测试可在 start 前预置不同到期时间
            for state in self._states.values():
                self._push_locked(state)
            self._condition.notify_all()
        for worker in self._workers:
            worker.start()
        LOGGER.info("scheduler started: %d parks, max concurrency %d",
                    len(self._states), len(self._workers))

    def stop(self) -> None:
        self._stop_event.set()
        with self._condition:
            self._condition.notify_all()
        for worker in self._workers:
            worker.join(timeout=10)
        LOGGER.info("scheduler stopped")

    def wait(self, seconds: float) -> None:
        """供外部驱动测试使用：等待指定时长（可被 stop 提前唤醒）。"""
        self._stop_event.wait(seconds)

    @property
    def states(self) -> dict[str, ParkState]:
        return self._states

    def snapshot_of(self, park_id: str) -> Snapshot | None:
        state = self._states[park_id]
        with state.lock:
            return state.last_snapshot

    def events(self) -> list[dict[str, Any]]:
        with self._events_lock:
            return list(self._events)

    # ---- 堆与线程同步 ---------------------------------------------------
    def _push_locked(self, state: ParkState) -> None:
        self._seq += 1
        heapq.heappush(self._heap, (state.next_due, self._seq, state.park_id))

    def _claim(self) -> ParkState | None:
        """领取一个已到期且无在途请求的园区；无到期园区返回 None。"""
        with self._condition:
            now = self._clock()
            while self._heap:
                due, _seq, park_id = self._heap[0]
                if due > now:
                    return None
                heapq.heappop(self._heap)
                state = self._states[park_id]
                with state.lock:
                    # 旧代条目（其到期时间已被后续排期覆盖）或已有请求在途：跳过
                    if due != state.next_due or state.in_flight:
                        continue
                    state.in_flight = True
                    return state
            return None

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            state = self._claim()
            if state is None:
                with self._condition:
                    if self._stop_event.is_set():
                        return
                    if self._heap:
                        delay = max(0.0, self._heap[0][0] - self._clock())
                        self._condition.wait(timeout=min(delay, 1.0))
                    else:
                        self._condition.wait(timeout=1.0)
                continue
            try:
                self._run_one(state)
            except Exception as exc:  # 工作线程不能因意外异常退出
                LOGGER.exception("unexpected error polling %s: %r", state.park_id, exc)
            finally:
                with state.lock:
                    state.in_flight = False

    # ---- 单次请求与排期 -------------------------------------------------
    def _run_one(self, state: ParkState) -> None:
        with state.lock:
            url = state.url
            timeout = state.timeout
            etag = state.etag
        park_id = state.park_id
        dispatch_mono = self._clock()
        self._record_event("dispatch", park_id, dispatch_mono)
        LOGGER.debug("dispatch %s etag=%s", park_id, etag)

        result = self._transport(url, timeout, etag)

        complete_mono = self._clock()
        self._record_event("complete", park_id, complete_mono, status=result.status,
                           timed_out=result.timed_out)
        self._apply_result(state, result, complete_mono)

    def _apply_result(self, state: ParkState, result: TransportResult, now_mono: float) -> None:
        park_id = state.park_id
        with state.lock:
            state.counters["requests"] += 1
            state.last_check_at = time.time()

            if result.status == 200:
                state.counters["ok"] += 1
                state.consecutive_failures = 0
                if result.etag:
                    state.etag = result.etag
                state.last_snapshot = Snapshot(
                    etag=result.etag or "",
                    body=result.body,
                    fetched_at=time.time(),
                )
                state.last_status = 200
                state.last_error = None
                LOGGER.info("%s 200 new snapshot etag=%s", park_id, state.etag)
                self._reschedule_locked(state, now_mono, state.interval)

            elif result.status == 304:
                state.counters["not_modified"] += 1
                state.consecutive_failures = 0
                state.last_status = 304
                state.last_error = None
                LOGGER.info("%s 304 not modified (check recorded)", park_id)
                self._reschedule_locked(state, now_mono, state.interval)

            elif result.status == 429:
                state.counters["rate_limited"] += 1
                state.last_status = 429
                state.last_error = "rate limited"
                retry_seconds = parse_retry_after(result.retry_after)
                if retry_seconds is not None:
                    # 需求关键点：按该响应的 Retry-After 安排本园区下一次请求，
                    # 不影响其他园区的排期。
                    state.consecutive_failures = 0
                    LOGGER.warning("%s 429 retry-after=%ss (other parks unaffected)",
                                   park_id, retry_seconds)
                    self._reschedule_locked(state, now_mono, float(retry_seconds))
                else:
                    state.consecutive_failures += 1
                    delay = self._backoff_locked(state)
                    LOGGER.warning("%s 429 without Retry-After, backoff %.1fs", park_id, delay)
                    self._reschedule_locked(state, now_mono, delay)

            elif result.status is not None and 500 <= result.status < 600:
                state.counters["server_error"] += 1
                state.consecutive_failures += 1
                state.last_status = result.status
                state.last_error = f"server error {result.status}"
                delay = self._backoff_locked(state)
                LOGGER.warning("%s %s backoff %.1fs", park_id, result.status, delay)
                self._reschedule_locked(state, now_mono, delay)

            elif result.timed_out:
                state.counters["timeout"] += 1
                state.consecutive_failures += 1
                state.last_status = "timeout"
                state.last_error = result.error
                delay = self._backoff_locked(state)
                LOGGER.warning("%s timeout backoff %.1fs", park_id, delay)
                self._reschedule_locked(state, now_mono, delay)

            else:
                # 连接错误或其他 4xx：记录为错误并走有上限退避
                state.counters["error"] += 1
                state.consecutive_failures += 1
                state.last_status = result.status if result.status is not None else "error"
                state.last_error = result.error or "unknown error"
                delay = self._backoff_locked(state)
                LOGGER.warning("%s error %r backoff %.1fs", park_id, state.last_error, delay)
                self._reschedule_locked(state, now_mono, delay)

    def _backoff_locked(self, state: ParkState) -> float:
        return next_backoff(
            state.consecutive_failures,
            self._config.backoff_base_seconds,
            self._config.backoff_cap_seconds,
        )

    def _reschedule_locked(self, state: ParkState, now_mono: float, delay: float) -> None:
        state.generation += 1
        state.next_due = now_mono + delay
        with self._condition:
            self._push_locked(state)
            self._condition.notify_all()

    def _record_event(self, kind: str, park_id: str, mono: float, **extra: Any) -> None:
        event = {"kind": kind, "park_id": park_id, "mono": round(mono, 4), **extra}
        with self._events_lock:
            self._events.append(event)
            if len(self._events) > MAX_EVENTS:
                del self._events[: len(self._events) - MAX_EVENTS]

    # ---- 状态视图（供 dispatcher / 测试） -------------------------------
    def active_count(self) -> int:
        return sum(1 for s in self._states.values() if s.in_flight)

    def status(self) -> list[dict[str, Any]]:
        now = self._clock()
        rows: list[dict[str, Any]] = []
        for park_id, state in self._states.items():
            with state.lock:
                rows.append(
                    {
                        "park_id": park_id,
                        "url": state.url,
                        "in_flight": state.in_flight,
                        "next_due_in_seconds": round(max(0.0, state.next_due - now), 2),
                        "etag": state.etag,
                        "last_status": state.last_status,
                        "last_check_at": state.last_check_at,
                        "last_error": state.last_error,
                        "consecutive_failures": state.consecutive_failures,
                        "has_snapshot": state.last_snapshot is not None,
                        "snapshot_fetched_at": (
                            state.last_snapshot.fetched_at if state.last_snapshot else None
                        ),
                        "counters": dict(state.counters),
                    }
                )
        rows.sort(key=lambda r: r["park_id"])
        return rows

    def snapshot_view(self) -> dict[str, dict[str, Any] | None]:
        """各园区最近一次成功快照（调度员查看用）。"""
        view: dict[str, dict[str, Any] | None] = {}
        for park_id, state in self._states.items():
            with state.lock:
                snap = state.last_snapshot
                view[park_id] = (
                    None
                    if snap is None
                    else {"etag": snap.etag, "fetched_at": snap.fetched_at, "body": snap.body}
                )
        return view
