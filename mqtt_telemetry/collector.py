"""采集服务。

线程模型：
- paho 网络线程只做两件事：解析报文、尝试放入有界队列。队列满时立即过载丢弃，
  绝不阻塞（阻塞网络线程会拖垮 MQTT keepalive，引发 broker 断连雪崩）。
- 单独的工作线程从队列取消息、写 SQLite；所有语义判定都在这一侧。

离线重连：
- client_id 固定 + clean_session=False，订阅 QoS1。客户端离线期间 broker 会
  缓存未送达消息，重连后（session_present=True）补投；补投的消息身份不变，
  落库时走 UNIQUE 约束命中 duplicate_network 分支，天然幂等。
- paho 内置自动重连，退避 1~15s。
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field

import paho.mqtt.client as mqtt

from .config import BrokerConfig, CollectorConfig
from .protocol import Measurement, ProtocolError, parse_payload
from .storage import Storage

log = logging.getLogger("collector")


@dataclass
class CollectorCounters:
    received: int = 0
    enqueued: int = 0
    overload_dropped: int = 0
    protocol_errors: int = 0
    new_measurements: int = 0
    duplicates: int = 0
    snapshots: int = 0
    last_event_ts: float = 0.0
    connected: bool = False
    session_present: bool = False
    connect_count: int = 0
    recent_events: list = field(default_factory=list)

    def note(self, text: str) -> None:
        self.last_event_ts = time.time()
        self.recent_events.append((self.last_event_ts, text))
        del self.recent_events[:-100]


class Collector:
    def __init__(self, broker: BrokerConfig, cfg: CollectorConfig, storage: Storage):
        self.broker = broker
        self.cfg = cfg
        self.storage = storage
        self._queue: queue.Queue[Measurement] = queue.Queue(maxsize=cfg.queue_max)
        self.counters = CollectorCounters()
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self._consume, name="db-worker", daemon=True)

        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=broker.client_id,
            clean_session=broker.clean_session,
        )
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        # 自动重连退避：1s 起步，上限 15s
        self.client.reconnect_delay_set(min_delay=1, max_delay=15)

    # ------------------------------------------------------------- paho 回调
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        self.counters.connected = True
        self.counters.connect_count += 1
        # VERSION2 中 flags 是 ConnectFlags，session_present 在其上
        self.counters.session_present = bool(getattr(flags, "session_present", False))
        if reason_code == 0:
            client.subscribe(self.cfg.topic, qos=1)
            self.counters.note(
                f"已连接 broker（第 {self.counters.connect_count} 次，"
                f"session_present={self.counters.session_present}），订阅 {self.cfg.topic} QoS1"
            )
            log.info("connected rc=%s session_present=%s", reason_code,
                     self.counters.session_present)
        else:
            log.error("connect failed rc=%s", reason_code)

    def _on_disconnect(self, client, userdata, *args, **kwargs):
        self.counters.connected = False
        self.counters.note("与 broker 断开，paho 将自动退避重连（1~15s）")
        log.warning("disconnected, auto-reconnect scheduled")

    def _on_message(self, client, userdata, msg):
        self.counters.received += 1
        try:
            measurement = parse_payload(msg.topic, msg.payload, msg.retain)
        except ProtocolError as exc:
            self.counters.protocol_errors += 1
            self.counters.note(f"协议错误丢弃: {exc}")
            log.warning("bad message on %s: %s", msg.topic, exc)
            return

        # 背压核心：有界队列，满即丢新来的，并把过载事件落库
        try:
            self._queue.put_nowait(measurement)
            self.counters.enqueued += 1
        except queue.Full:
            self.counters.overload_dropped += 1
            self.storage.record_overload(
                queue_size=self.cfg.queue_max,
                identity="/".join(map(str, measurement.identity)),
            )
            self.counters.note(
                f"过载丢弃：队列满({self.cfg.queue_max})，丢 {measurement.identity}"
            )
            log.error("backpressure: queue full, dropped %s", measurement.identity)

    # ------------------------------------------------------------- 工作线程
    def _consume(self):
        while not self._stop.is_set():
            try:
                measurement = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            t0 = time.time()
            try:
                if self.cfg.inject_process_delay > 0:
                    # 模拟慢下游（数据库卡顿/同步 IO 等），让有界队列真实堆积
                    time.sleep(self.cfg.inject_process_delay)
                result = self.storage.ingest(measurement)
            except Exception:
                log.exception("ingest failed for %s", measurement.identity)
                self.counters.note(f"落库异常: {measurement.identity}")
                continue
            finally:
                self._queue.task_done()

            if result.kind == "new":
                self.counters.new_measurements += 1
                if result.flags:
                    self.counters.note(
                        f"异常测量 {measurement.identity} flags={result.flags} "
                        f"{result.explanation}"
                    )
                if result.gap_missing:
                    self.counters.note(
                        f"缺口 {measurement.device_id}: 缺 {result.gap_missing} 条"
                    )
            elif result.kind == "duplicate_network":
                self.counters.duplicates += 1
                self.counters.note(f"网络重复，忽略: {measurement.identity}")
            else:
                self.counters.snapshots += 1
                self.counters.note(f"retained 快照，不计新测量: {measurement.identity}")

            cost_ms = (time.time() - t0) * 1000
            if cost_ms > self.cfg.slow_process_ms:
                log.warning("slow ingest %.1fms identity=%s", cost_ms,
                            measurement.identity)

    # ------------------------------------------------------------- 生命周期
    def start(self) -> None:
        self._worker.start()
        self.client.connect(self.broker.host, self.broker.port, self.broker.keepalive)
        self.client.loop_start()
        log.info("collector started, broker=%s:%s", self.broker.host, self.broker.port)

    def stop(self, drain_timeout: float = 5.0) -> None:
        # 先停网络循环，再把队列里剩余消息排空，避免关停丢数据
        self.client.loop_stop()
        self.client.disconnect()
        deadline = time.time() + drain_timeout
        while not self._queue.empty() and time.time() < deadline:
            time.sleep(0.05)
        self._stop.set()
        self._worker.join(timeout=2.0)
        self.storage.close()
        log.info("collector stopped, drained queue")

    def wait(self) -> None:
        try:
            while not self._stop.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
