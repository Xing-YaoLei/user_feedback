import threading
import time
import unittest

from shuttle.config import Config, ParkConfig
from shuttle.model import Snapshot
from shuttle.poller import Scheduler, TransportResult


class FakeClock:
    """可手动推进的单调时钟，配合 Condition 唤醒等待中的工作线程。"""

    def __init__(self, start: float) -> None:
        self.now = start
        self.condition = threading.Condition()

    def time(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        with self.condition:
            self.now += seconds
            self.condition.notify_all()


def make_config(parks: list[ParkConfig], *, base: float = 1.0, cap: float = 30.0,
                concurrency: int = 3) -> Config:
    return Config(
        max_concurrency=concurrency,
        backoff_base_seconds=base,
        backoff_cap_seconds=cap,
        parks=parks,
    )


def park(pid: str, interval: float = 2.0, timeout: float = 5.0) -> ParkConfig:
    return ParkConfig(pid, f"http://local/{pid}", interval, timeout)


def wait_until(predicate, timeout: float = 3.0, interval: float = 0.01) -> bool:
    """轮询等待真实线程追上断言条件。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class ScriptedTransport:
    """按园区依次返回脚本结果；记录调用；可用 gate 阻塞指定园区的请求。"""

    def __init__(self, scripts: dict[str, list[TransportResult]],
                 clock: FakeClock | None = None, request_seconds: float = 0.0) -> None:
        self.scripts = {k: list(v) for k, v in scripts.items()}
        self.calls: list[tuple[str, str | None]] = []
        self.clock = clock
        self.request_seconds = request_seconds
        self.gates: dict[str, threading.Event] = {}
        self.lock = threading.Lock()

    def set_gate(self, park_id: str) -> threading.Event:
        event = threading.Event()
        self.gates[park_id] = event
        return event

    def __call__(self, url: str, timeout: float, etag: str | None) -> TransportResult:
        park_id = url.rsplit("/", 1)[-1]
        with self.lock:
            self.calls.append((park_id, etag))
        gate = self.gates.get(park_id)
        if gate is not None:
            gate.wait(5)
        if self.request_seconds and self.clock is not None:
            self.clock.advance(self.request_seconds)
        script = self.scripts.get(park_id)
        if not script:
            return TransportResult(status=200, etag='"e-1"', body={"ok": True})
        return script.pop(0)


def start_scheduler(config: Config, transport, clock: FakeClock) -> Scheduler:
    scheduler = Scheduler(config, transport=transport, clock=clock.time)
    # 让工作线程的等待挂在假时钟的 Condition 上，advance 即可唤醒
    scheduler._condition = threading.Condition(clock.condition)
    scheduler.start()
    return scheduler


def settle(scheduler: Scheduler, clock: FakeClock, *, advance: float = 0.0,
           expected_requests: int | None = None) -> None:
    """推进假时钟并等待工作线程把应做的请求处理完。"""
    if advance:
        clock.advance(advance)
    else:
        # 不推进时间也要唤醒工作线程，使其重新检查到期堆
        with clock.condition:
            clock.condition.notify_all()
    if expected_requests is None:
        time.sleep(0.05)
        return
    total = lambda: sum(s.counters["requests"] for s in scheduler.states.values())
    assert wait_until(lambda: total() >= expected_requests), \
        f"期望 {expected_requests} 次请求，实际 {total()}"


class SchedulerBasicTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(time.monotonic())

    def tearDown(self):
        self.scheduler.stop()

    def test_304_records_check_but_keeps_snapshot(self):
        transport = ScriptedTransport({"north": [
            TransportResult(status=200, etag='"e1"', body={"v": 1}),
            TransportResult(status=304, etag='"e1"'),
        ]}, clock=self.clock)
        cfg = make_config([park("north", interval=2.0)])
        self.scheduler = start_scheduler(cfg, transport, self.clock)

        settle(self.scheduler, self.clock, expected_requests=1)
        state = self.scheduler.states["north"]
        self.assertEqual(state.counters["ok"], 1)
        self.assertEqual(state.etag, '"e1"')
        first_snapshot = state.last_snapshot

        settle(self.scheduler, self.clock, advance=2.0, expected_requests=2)
        self.assertEqual(state.counters["not_modified"], 1)
        self.assertIsNotNone(state.last_check_at)
        # 快照对象不被 304 替换
        self.assertIs(state.last_snapshot, first_snapshot)
        # 第二次请求携带 ETag
        self.assertEqual(transport.calls[1][1], '"e1"')
        # 304 后按常规间隔排期
        self.assertAlmostEqual(state.next_due, self.clock.now + 2.0, places=3)

    def test_429_uses_retry_after(self):
        transport = ScriptedTransport({"north": [
            TransportResult(status=429, retry_after="6"),
            TransportResult(status=200, etag='"e2"', body={"v": 2}),
        ]}, clock=self.clock)
        cfg = make_config([park("north", interval=2.0)])
        self.scheduler = start_scheduler(cfg, transport, self.clock)

        settle(self.scheduler, self.clock, expected_requests=1)
        state = self.scheduler.states["north"]
        self.assertEqual(state.last_status, 429)
        self.assertEqual(state.counters["rate_limited"], 1)
        # 下一次到期 = Retry-After，而不是常规间隔
        self.assertAlmostEqual(state.next_due, self.clock.now + 6.0, places=3)

        # 只推进常规间隔：不应发起新请求
        settle(self.scheduler, self.clock, advance=2.0)
        self.assertEqual(state.counters["requests"], 1)

        # 推进到 Retry-After 到期：恢复请求并成功
        settle(self.scheduler, self.clock, advance=4.0, expected_requests=2)
        self.assertEqual(state.last_status, 200)
        self.assertEqual(state.etag, '"e2"')

    def test_429_without_retry_after_falls_back_to_backoff(self):
        transport = ScriptedTransport({"north": [
            TransportResult(status=429, retry_after=None),
        ]}, clock=self.clock)
        cfg = make_config([park("north")], base=1.0, cap=30.0)
        self.scheduler = start_scheduler(cfg, transport, self.clock)
        settle(self.scheduler, self.clock, expected_requests=1)
        state = self.scheduler.states["north"]
        self.assertAlmostEqual(state.next_due, self.clock.now + 1.0, places=3)
        self.assertEqual(state.consecutive_failures, 1)

    def test_5xx_backoff_then_success_resets(self):
        transport = ScriptedTransport({"north": [
            TransportResult(status=503, error="busy"),
            TransportResult(status=503, error="busy"),
            TransportResult(status=200, etag='"e3"', body={"v": 3}),
            TransportResult(status=304, etag='"e3"'),
        ]}, clock=self.clock)
        cfg = make_config([park("north", interval=2.0)], base=1.0, cap=4.0)
        self.scheduler = start_scheduler(cfg, transport, self.clock)
        state = self.scheduler.states["north"]

        settle(self.scheduler, self.clock, expected_requests=1)
        self.assertEqual(state.consecutive_failures, 1)
        self.assertAlmostEqual(state.next_due, self.clock.now + 1.0, places=3)

        settle(self.scheduler, self.clock, advance=1.0, expected_requests=2)
        self.assertEqual(state.consecutive_failures, 2)
        self.assertAlmostEqual(state.next_due, self.clock.now + 2.0, places=3)

        # 成功后失败计数清零，恢复常规间隔
        settle(self.scheduler, self.clock, advance=2.0, expected_requests=3)
        self.assertEqual(state.consecutive_failures, 0)
        self.assertAlmostEqual(state.next_due, self.clock.now + 2.0, places=3)

        settle(self.scheduler, self.clock, advance=2.0, expected_requests=4)
        self.assertEqual(state.counters["not_modified"], 1)

    def test_backoff_is_capped(self):
        transport = ScriptedTransport({"north": [TransportResult(status=500)]}, clock=self.clock)
        cfg = make_config([park("north")], base=2.0, cap=5.0)
        self.scheduler = start_scheduler(cfg, transport, self.clock)
        state = self.scheduler.states["north"]
        # 人为制造第 5 次失败的计数场景
        with state.lock:
            state.consecutive_failures = 4
        self.assertEqual(self.scheduler._backoff_locked(state), 5.0)

    def test_timeout_backoff(self):
        transport = ScriptedTransport({"north": [
            TransportResult(status=None, error="timeout: x", timed_out=True),
        ]}, clock=self.clock)
        cfg = make_config([park("north")], base=1.0, cap=30.0)
        self.scheduler = start_scheduler(cfg, transport, self.clock)
        settle(self.scheduler, self.clock, expected_requests=1)
        state = self.scheduler.states["north"]
        self.assertEqual(state.counters["timeout"], 1)
        self.assertEqual(state.last_status, "timeout")
        self.assertEqual(state.consecutive_failures, 1)
        self.assertAlmostEqual(state.next_due, self.clock.now + 1.0, places=3)

    def test_other_park_unaffected_by_retry_after(self):
        # 核心需求：north 收到 429(Retry-After=6) 期间，south 按自己的间隔继续
        transport = ScriptedTransport({
            "north": [TransportResult(status=429, retry_after="6")],
            "south": [
                TransportResult(status=200, etag='"s1"', body={}),
                TransportResult(status=304, etag='"s1"'),
                TransportResult(status=304, etag='"s1"'),
            ],
        }, clock=self.clock)
        cfg = make_config([park("north", 2.0), park("south", 2.0)])
        self.scheduler = start_scheduler(cfg, transport, self.clock)

        settle(self.scheduler, self.clock, expected_requests=2)
        north = self.scheduler.states["north"]
        south = self.scheduler.states["south"]
        self.assertEqual(north.counters["requests"], 1)
        self.assertEqual(south.counters["requests"], 1)

        # 推进 4 秒（south 再跑 2 轮），north 仍在 Retry-After 窗口内
        settle(self.scheduler, self.clock, advance=2.0,
               expected_requests=3)  # south 第 2 次
        settle(self.scheduler, self.clock, advance=2.0,
               expected_requests=4)  # south 第 3 次
        self.assertEqual(south.counters["requests"], 3)
        self.assertEqual(north.counters["requests"], 1)
        self.assertEqual(north.last_status, 429)


class SchedulerConcurrencyTests(unittest.TestCase):
    def _real_clock_scheduler(self, ids: list[str], transport: ScriptedTransport,
                              concurrency: int = 3, interval: float = 60.0) -> Scheduler:
        cfg = make_config([park(pid, interval) for pid in ids], concurrency=concurrency)
        scheduler = Scheduler(cfg, transport=transport)
        scheduler.start()
        return scheduler

    def test_same_park_never_overlaps(self):
        transport = ScriptedTransport({})
        gate = transport.set_gate("north")
        scheduler = self._real_clock_scheduler(
            ["north", "south"], transport, concurrency=3, interval=0.2
        )
        try:
            self.assertTrue(wait_until(lambda: scheduler.states["north"].in_flight))
            north = scheduler.states["north"]
            south = scheduler.states["south"]

            def dispatches(pid: str) -> int:
                return sum(1 for e in scheduler.events()
                           if e["park_id"] == pid and e["kind"] == "dispatch")

            # north 被门控阻塞期间，即使再次到期也不能发起第二个请求
            self.assertEqual(dispatches("north"), 1)
            time.sleep(0.5)
            self.assertEqual(dispatches("north"), 1)
            self.assertTrue(north.in_flight)
            self.assertEqual(north.counters["requests"], 0)  # 响应未返回，不计完成
            # south 不受影响
            self.assertGreaterEqual(south.counters["requests"], 1)
            gate.set()
            self.assertTrue(wait_until(lambda: not north.in_flight))
            self.assertEqual(north.counters["requests"], 1)
        finally:
            gate.set()
            scheduler.stop()

    def test_global_concurrency_cap_is_three(self):
        transport = ScriptedTransport({})
        # 五个园区全部门控，使补位园区也能稳定停在在途状态
        gates = {pid: transport.set_gate(pid) for pid in ("a", "b", "c", "d", "e")}
        scheduler = self._real_clock_scheduler(
            ["a", "b", "c", "d", "e"], transport, concurrency=3, interval=60.0
        )
        try:
            self.assertTrue(wait_until(lambda: scheduler.active_count() == 3))
            # 前三个占满在途名额，d/e 必须等待
            for pid in ("a", "b", "c"):
                self.assertTrue(scheduler.states[pid].in_flight)
            for pid in ("d", "e"):
                self.assertFalse(scheduler.states[pid].in_flight)
                self.assertEqual(scheduler.states[pid].counters["requests"], 0)

            gates["a"].set()
            # 释放一个名额后恰好补上一个，峰值仍为 3
            self.assertTrue(wait_until(
                lambda: scheduler.states["d"].in_flight or scheduler.states["e"].in_flight
            ))
            self.assertEqual(scheduler.active_count(), 3)
            for g in gates.values():
                g.set()
            self.assertTrue(wait_until(lambda: scheduler.active_count() == 0))
        finally:
            for g in gates.values():
                g.set()
            scheduler.stop()

    def test_due_order_longest_waiting_first(self):
        order: list[str] = []
        done = threading.Event()

        class OrderTransport:
            def __call__(self, url, timeout, etag):
                pid = url.rsplit("/", 1)[-1]
                order.append(pid)
                if len(order) == 3:
                    done.set()
                return TransportResult(status=304, etag=etag or '"x"')

        cfg = make_config([park(pid, interval=60.0) for pid in ("p1", "p2", "p3")],
                          concurrency=1)  # 单线程才能观察领取顺序
        scheduler = Scheduler(cfg, transport=OrderTransport())
        real_now = time.monotonic()
        with scheduler.states["p1"].lock:
            scheduler.states["p1"].next_due = real_now - 30  # 等待最久
        with scheduler.states["p2"].lock:
            scheduler.states["p2"].next_due = real_now - 20
        with scheduler.states["p3"].lock:
            scheduler.states["p3"].next_due = real_now - 10
        scheduler.start()
        try:
            self.assertTrue(done.wait(2))
            self.assertEqual(order, ["p1", "p2", "p3"])
        finally:
            scheduler.stop()


if __name__ == "__main__":
    unittest.main()
