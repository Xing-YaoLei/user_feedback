"""轮询程序配置：从 JSON 文件读取各园区 URL 与刷新间隔。"""

from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class ParkConfig:
    park_id: str
    url: str
    interval_seconds: float
    timeout_seconds: float


@dataclass(frozen=True)
class DispatcherConfig:
    host: str
    port: int


@dataclass(frozen=True)
class Config:
    max_concurrency: int
    backoff_base_seconds: float
    backoff_cap_seconds: float
    parks: list[ParkConfig]
    dispatcher: DispatcherConfig | None = None
    logfile: str | None = None


def _require_number(obj: dict, key: str, *, positive: bool = True) -> float:
    if key not in obj:
        raise ValueError(f"配置缺少字段: {key}")
    value = obj[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"字段 {key} 必须是数字，实际为: {value!r}")
    if positive and value <= 0:
        raise ValueError(f"字段 {key} 必须大于 0，实际为: {value!r}")
    return float(value)


def load_config(path: str) -> Config:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    max_concurrency = int(_require_number(raw, "max_concurrency"))
    base = _require_number(raw, "backoff_base_seconds")
    cap = _require_number(raw, "backoff_cap_seconds")
    if cap < base:
        raise ValueError("backoff_cap_seconds 不能小于 backoff_base_seconds")

    parks_raw = raw.get("parks")
    if not isinstance(parks_raw, list) or not parks_raw:
        raise ValueError("parks 必须是非空数组")

    parks: list[ParkConfig] = []
    seen_ids: set[str] = set()
    for item in parks_raw:
        if not isinstance(item, dict):
            raise ValueError(f"园区配置必须是对象: {item!r}")
        park_id = item.get("id")
        url = item.get("url")
        if not isinstance(park_id, str) or not park_id:
            raise ValueError(f"园区 id 必须是非空字符串: {item!r}")
        if park_id in seen_ids:
            raise ValueError(f"园区 id 重复: {park_id}")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise ValueError(f"园区 {park_id} 的 url 非法: {url!r}")
        interval = _require_number(item, "interval_seconds")
        timeout = _require_number(item, "timeout_seconds")
        seen_ids.add(park_id)
        parks.append(ParkConfig(park_id, url, interval, timeout))

    dispatcher = None
    d = raw.get("dispatcher")
    if d is not None:
        if not isinstance(d, dict):
            raise ValueError("dispatcher 必须是对象")
        port = int(_require_number(d, "port"))
        dispatcher = DispatcherConfig(host=str(d.get("host", "127.0.0.1")), port=port)

    logfile = raw.get("logfile")
    if logfile is not None and not isinstance(logfile, str):
        raise ValueError("logfile 必须是字符串路径")

    return Config(
        max_concurrency=max_concurrency,
        backoff_base_seconds=base,
        backoff_cap_seconds=cap,
        parks=parks,
        dispatcher=dispatcher,
        logfile=logfile,
    )
