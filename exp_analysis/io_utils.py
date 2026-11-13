"""输入读取与时间解析。

输入文件均为 UTF-8 CSV：

- 分流日志: user_id, layer, group, assigned_at
- 转化日志: user_id, converted_at[, coverage_at]
    每个用户可有多条转化记录；coverage_at 为可选的逐用户覆盖时间列。
- 层权重: layer, weight（可只覆盖部分层）
- 覆盖时间也可由 CLI 全局给定（时间戳字符串，或只含一个时间戳的文件）。
"""

from __future__ import annotations

import csv
import os
from datetime import datetime, timezone
from typing import Optional

TS_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d",
)


def parse_ts(value: str) -> datetime:
    """把时间字符串解析为带时区的 UTC datetime。

    兼容 ISO 8601（含 Z/偏移量）与常见空白分隔格式；
    不带时区的时间按 UTC 处理，保证混合输入时可比较。
    """
    s = value.strip()
    if not s:
        raise ValueError("空时间戳")
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        dt = None
        for fmt in TS_FORMATS:
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
        if dt is None:
            raise ValueError(f"无法解析时间戳: {value!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _read_csv(path: str) -> list[dict[str, str]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_assignments(path: str) -> list[dict]:
    """返回分流记录列表；重复用户保留最早一条（由调用方收集告警）。"""
    rows = []
    for raw in _read_csv(path):
        rows.append(
            {
                "user_id": raw["user_id"].strip(),
                "layer": raw["layer"].strip(),
                "group": raw["group"].strip(),
                "assigned_at": parse_ts(raw["assigned_at"]),
            }
        )
    return rows


def load_conversions(path: str) -> tuple[dict[str, datetime], dict[str, datetime]]:
    """返回 (每用户最早转化时间, 每用户覆盖时间)。"""
    earliest: dict[str, datetime] = {}
    coverage: dict[str, datetime] = {}
    for raw in _read_csv(path):
        uid = raw["user_id"].strip()
        ts = parse_ts(raw["converted_at"])
        if uid not in earliest or ts < earliest[uid]:
            earliest[uid] = ts
        cov = raw.get("coverage_at")
        if cov and cov.strip():
            cov_ts = parse_ts(cov)
            if uid not in coverage or cov_ts < coverage[uid]:
                coverage[uid] = cov_ts
    return earliest, coverage


def load_weights(path: str) -> dict[str, float]:
    weights: dict[str, float] = {}
    for raw in _read_csv(path):
        layer = raw["layer"].strip()
        w = float(raw["weight"])
        if w < 0:
            raise ValueError(f"层 {layer} 权重为负: {w}")
        weights[layer] = w
    return weights


def load_coverage(spec: str) -> datetime:
    """spec 可以是时间戳字符串，也可以是包含时间戳的文件路径。"""
    if os.path.exists(spec):
        with open(spec, "r", encoding="utf-8-sig") as f:
            text = f.read().strip()
        # 支持 CSV: 首行表头 coverage_at，次行值
        if "coverage_at" in text:
            import io

            reader = csv.DictReader(io.StringIO(text))
            first = next(reader, None)
            if first is None or not first.get("coverage_at"):
                raise ValueError("覆盖时间文件缺少 coverage_at 列")
            text = first["coverage_at"].strip()
        else:
            text = text.splitlines()[0].strip()
        return parse_ts(text)
    return parse_ts(spec)


def resolve_coverage(
    user_id: str,
    per_user: dict[str, datetime],
    global_coverage: Optional[datetime],
) -> Optional[datetime]:
    if user_id in per_user:
        return per_user[user_id]
    return global_coverage
