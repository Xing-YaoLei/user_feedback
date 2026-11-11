"""集中配置：所有可调参数都在这里，命令行可覆盖。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class BrokerConfig:
    host: str = "127.0.0.1"
    port: int = 1883
    keepalive: int = 20
    # 采集器用固定 client_id 才能拿到自己的持久会话（离线期间 broker 排队消息）
    client_id: str = "telemetry-collector"
    clean_session: bool = False


@dataclass
class CollectorConfig:
    topic: str = "telemetry/+/up"
    db_path: str = "data/telemetry.db"
    # 有界接收队列容量；满了以后新消息被过载丢弃并计数，绝不阻塞网络线程
    queue_max: int = 256
    # 单条消息处理超过该耗时（秒）会在日志里提示处理缓慢
    slow_process_ms: int = 50
    # >0 时每条消息落库前额外 sleep 这么多秒，用于演示慢下游导致的背压过载
    inject_process_delay: float = 0.0
    web_host: str = "127.0.0.1"
    web_port: int = 8080


@dataclass
class DeviceConfig:
    broker: BrokerConfig = field(default_factory=BrokerConfig)
    topic_prefix: str = "telemetry"
    interval: float = 1.0
    count: int = 0  # 0 表示一直发
    jitter: float = 0.0
    # 模拟丢包/重发的概率，便于制造重复投递与缺口
    duplicate_prob: float = 0.0
    # 单位切换计划：在第 N 条（seq 从 1 开始）发布前切换到指定单位，例如 {5: "degF"}
    unit_schedule: dict | None = None
    # 时钟回拨计划：在第 N 条发布前把设备时钟往回拨多少秒
    clock_skew_schedule: dict | None = None
    # 是否在每条消息上置 retained（默认只有最后一条/快照才 retain）
    always_retain: bool = False


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default
