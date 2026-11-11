"""设备模拟器。

每个 DeviceSimulator 实例就是一台设备：
- 每次（重新）启动生成新的 boot_id（uuid），seq 从 1 重新计数；
- 设备时钟 = 真实时间 + 可注入的 clock_offset，可按计划回拨；
- QoS1 发布；duplicate_prob 概率把同一条报文再发一次，模拟应用层/网络重发；
- restart() 模拟设备重启；go_offline()/come_back() 模拟断网。
"""
from __future__ import annotations

import argparse
import json
import logging
import random
import threading
import time
import uuid

import paho.mqtt.client as mqtt

from .config import BrokerConfig, DeviceConfig

log = logging.getLogger("simulator")


class DeviceSimulator:
    def __init__(self, device_id: str, cfg: DeviceConfig, unit: str = "degC",
                 broker: BrokerConfig | None = None, value_fn=None):
        self.device_id = device_id
        self.cfg = cfg
        self.unit = unit
        self.clock_offset = 0.0
        self._value_fn = value_fn or (lambda seq: round(20 + seq * 0.1, 3))
        self.boot_id = self._new_boot_id()
        self.seq = 0
        self.topic = f"{cfg.topic_prefix}/{device_id}/up"
        self.restart_count = 0
        self.published = 0
        self.duplicates_sent = 0
        self._online = threading.Event()

        broker = broker or cfg.broker
        # 设备端用 clean session + 随机 client_id：重连即新会话，不依赖 broker 排队
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"sim-{device_id}-{uuid.uuid4().hex[:8]}",
            clean_session=True,
        )
        self.client.reconnect_delay_set(min_delay=1, max_delay=10)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.connect(broker.host, broker.port, broker.keepalive)
        self.client.loop_start()

    # ------------------------------------------------------------ 生命周期
    def _on_connect(self, *args):
        self._online.set()
        log.info("[%s] mqtt connected, boot_id=%s", self.device_id, self.boot_id)

    def _on_disconnect(self, *args):
        self._online.clear()
        log.info("[%s] mqtt disconnected", self.device_id)

    @staticmethod
    def _new_boot_id() -> str:
        return uuid.uuid4().hex

    def restart(self) -> None:
        """模拟设备重启：新 boot_id，seq 归 1。"""
        self.restart_count += 1
        self.boot_id = self._new_boot_id()
        self.seq = 0
        log.info("[%s] RESTART -> boot_id=%s", self.device_id, self.boot_id)

    def go_offline(self) -> None:
        """模拟断网：断开 MQTT（paho 会自动重试连接）。"""
        log.info("[%s] going OFFLINE", self.device_id)
        try:
            self.client.disconnect()
        except Exception:
            pass

    def come_back(self) -> None:
        """模拟网络恢复：主动重连。"""
        log.info("[%s] coming BACK online", self.device_id)
        self.client.reconnect()

    def wait_online(self, timeout: float = 5.0) -> bool:
        return self._online.wait(timeout)

    # ------------------------------------------------------------ 发布
    def tick(self, retain: bool | None = None) -> dict:
        """生成并发布一条测量，返回发送的 payload。"""
        self.seq += 1
        seq = self.seq

        # 事件计划：单位切换 / 时钟回拨
        if self.cfg.unit_schedule and seq in self.cfg.unit_schedule:
            new_unit = self.cfg.unit_schedule[seq]
            log.info("[%s] unit switch %s -> %s at seq=%d",
                     self.device_id, self.unit, new_unit, seq)
            self.unit = new_unit
        if self.cfg.clock_skew_schedule and seq in self.cfg.clock_skew_schedule:
            skew = self.cfg.clock_skew_schedule[seq]
            self.clock_offset += skew
            log.info("[%s] clock skew %.3fs at seq=%d", self.device_id, skew, seq)

        payload = {
            "boot_id": self.boot_id,
            "seq": seq,
            "device_ts": round(time.time() + self.clock_offset, 3),
            "value": self._value_fn(seq),
            "unit": self.unit,
        }
        body = json.dumps(payload)
        do_retain = self.cfg.always_retain if retain is None else retain
        self._publish(body, do_retain)
        self.published += 1

        # 模拟重复投递：同身份报文原样再发一次（QoS1 重发的应用层等价物）
        if random.random() < self.cfg.duplicate_prob:
            time.sleep(0.02)
            self._publish(body, False)
            self.duplicates_sent += 1
        return payload

    def _publish(self, body: str, retain: bool) -> None:
        info = self.client.publish(self.topic, body, qos=1, retain=retain)
        # 不阻塞等待 PUBACK，仅在进程退出时统一 wait_for_publish
        info.rc  # noqa: B018 — 触发 rc 读取便于调试
        self._last_info = info

    def run(self, count: int | None = None, interval: float | None = None,
            stop_event: threading.Event | None = None) -> None:
        count = self.cfg.count if count is None else count
        interval = self.cfg.interval if interval is None else interval
        n = 0
        try:
            while not (stop_event and stop_event.is_set()):
                if count and n >= count:
                    break
                self.tick()
                n += 1
                if interval:
                    jitter = random.uniform(-self.cfg.jitter, self.cfg.jitter)
                    time.sleep(max(0.01, interval + jitter))
        finally:
            self.stop()

    def stop(self) -> None:
        try:
            if hasattr(self, "_last_info"):
                self._last_info.wait_for_publish(timeout=3)
        except Exception:
            pass
        self.client.loop_stop()
        self.client.disconnect()


def main() -> None:
    ap = argparse.ArgumentParser(description="MQTT 设备模拟器")
    ap.add_argument("--device", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--unit", default="degC")
    ap.add_argument("--duplicate-prob", type=float, default=0.0)
    ap.add_argument("--always-retain", action="store_true")
    ap.add_argument("--restart-at", type=int, default=0,
                    help=">0 时在第 N 条之后重启一次设备")
    ap.add_argument("--unit-switch-at", type=int, default=0)
    ap.add_argument("--unit-switch-to", default="degF")
    ap.add_argument("--skew-at", type=int, default=0)
    ap.add_argument("--skew-seconds", type=float, default=-60.0)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    cfg = DeviceConfig(
        broker=BrokerConfig(host=args.host, port=args.port),
        interval=args.interval, count=args.count,
        duplicate_prob=args.duplicate_prob, always_retain=args.always_retain,
        unit_schedule={args.unit_switch_at: args.unit_switch_to}
        if args.unit_switch_at else None,
        clock_skew_schedule={args.skew_at: args.skew_seconds}
        if args.skew_at else None,
    )
    sim = DeviceSimulator(args.device, cfg, unit=args.unit)
    sim.wait_online()
    for i in range(args.count):
        sim.tick()
        if args.restart_at and i + 1 == args.restart_at:
            sim.restart()
        time.sleep(args.interval)
    sim.stop()


if __name__ == "__main__":
    main()
