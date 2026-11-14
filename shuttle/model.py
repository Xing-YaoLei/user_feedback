"""轮询运行时的数据模型：园区状态与最近一次成功快照。"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Snapshot:
    """一次 200 响应发布的整份到站快照。"""

    etag: str
    body: Any
    fetched_at: float  # wall-clock 时间戳（time.time()）


def _new_counters() -> dict[str, int]:
    return {
        "requests": 0,
        "ok": 0,            # 200
        "not_modified": 0,  # 304
        "rate_limited": 0,  # 429
        "server_error": 0,  # 5xx
        "timeout": 0,
        "error": 0,         # 连接错误等
    }


@dataclass
class ParkState:
    """单个园区的全部运行时状态；所有读写都应持有 lock。"""

    park_id: str
    url: str
    interval: float
    timeout: float
    lock: threading.RLock = field(default_factory=threading.RLock)

    # ETag 条件请求与快照保留
    etag: str | None = None
    last_snapshot: Snapshot | None = None

    # 检查记录
    last_check_at: float | None = None   # 200/304 都会更新
    last_status: int | str | None = None
    last_error: str | None = None

    # 调度
    next_due: float = 0.0                # monotonic 时钟
    generation: int = 0                  # 每次重新排期 +1，使堆中的旧条目失效
    in_flight: bool = False              # 同一园区同一时刻最多一个请求在途

    # 退避（仅统计超时/5xx/连接错误；429 走 Retry-After 自己的轨道）
    consecutive_failures: int = 0

    counters: dict[str, int] = field(default_factory=_new_counters)
