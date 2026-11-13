"""时间处理：全部归一化为 UTC 文本，格式可直接按字典序比较。"""

from __future__ import annotations

from datetime import datetime, timezone

# 远大于任何真实时间的哨兵，用于开放区间（valid_to IS NULL）的比较。
INFINITY = "9999-12-31T23:59:59.999999Z"


def parse_ts(value: str) -> datetime:
    """把 ISO-8601 文本解析为带时区的 UTC datetime。

    接受 ``2026-01-01T08:00:00Z``、``2026-01-01 08:00:00+08:00`` 等形式；
    不带时区的时间戳按 UTC 处理。
    """
    if value is None:
        raise ValueError("时间不能为空")
    text = str(value).strip()
    if not text:
        raise ValueError("时间不能为空")
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    # 兼容 "2026-01-01 08:00:00" 这种空格分隔
    try:
        dt = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"无法解析时间: {value!r}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fmt_ts(dt: datetime) -> str:
    """归一化为 ``YYYY-MM-DDTHH:MM:SS[.ffffff]Z``。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    if dt.microsecond:
        base += f".{dt.microsecond:06d}"
    return base + "Z"


def normalize_ts(value: str) -> str:
    """解析并归一化时间文本。"""
    return fmt_ts(parse_ts(value))


def now_utc() -> str:
    return fmt_ts(datetime.now(timezone.utc))
