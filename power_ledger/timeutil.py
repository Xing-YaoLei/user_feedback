"""北京时间解析与业务日工具。

* 不带时区的时间戳按北京时间（UTC+8）解释；
* 带偏移（含 ``Z``）的时间戳换算到北京时间；
* 业务日 = 发生时刻在北京时区下的日历日。
"""

from datetime import datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8))


def parse_beijing(value):
    """把 CSV 中的时间字符串解析为带北京时区的 ``datetime``。"""
    text = value.strip()
    if not text:
        raise ValueError("时间为空")
    if text[-1] in ("Z", "z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING)
    return dt.astimezone(BEIJING)


def business_day(dt_aware):
    """返回 ``YYYY-MM-DD`` 形式的北京业务日。"""
    return dt_aware.astimezone(BEIJING).date().isoformat()


def iso(dt_aware):
    """统一的 ISO 输出（带 +08:00 偏移）。"""
    return dt_aware.astimezone(BEIJING).isoformat()
