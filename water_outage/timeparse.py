"""停水时间字符串解析，支持常见中英文格式，输出统一的 datetime。"""

from __future__ import annotations

import re
from datetime import datetime

# 2026-11-15 22:00[:00] / 2026/11/15 22:00
_ISO_LIKE = re.compile(
    r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?"
)
# 2026年11月15日22时00分[00秒]
_CHINESE = re.compile(
    r"(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})时(\d{1,2})分(?:(\d{1,2})秒)?"
)
# 仅有日期时按当天 00:00 处理
_DATE_ONLY = re.compile(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?")


def parse_time(raw):
    """把时间文本解析为 datetime；无法识别时抛出 ValueError。"""
    if raw is None:
        raise ValueError("时间为空")
    text = raw.strip()
    if not text:
        raise ValueError("时间为空")

    for pattern in (_ISO_LIKE, _CHINESE):
        match = pattern.search(text)
        if match:
            year, month, day, hour, minute = (int(g) for g in match.groups()[:5])
            second = int(match.group(6)) if match.group(6) else 0
            return datetime(year, month, day, hour, minute, second)

    match = _DATE_ONLY.search(text)
    if match:
        year, month, day = (int(g) for g in match.groups())
        return datetime(year, month, day)

    raise ValueError(f"无法识别的时间格式: {raw!r}")


def iso_format(value):
    """统一输出为秒级 ISO 字符串。"""
    return value.strftime("%Y-%m-%dT%H:%M:%S")
