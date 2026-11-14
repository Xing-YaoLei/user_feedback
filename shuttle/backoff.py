"""退避时间计算与 Retry-After 头解析。"""

from __future__ import annotations


def next_backoff(attempt: int, base_seconds: float, cap_seconds: float) -> float:
    """有上限的指数退避。

    attempt 从 1 开始：第 1 次失败退避 base，第 2 次 base*2，第 3 次 base*4，
    以此类推，最大不超过 cap_seconds。
    """
    if attempt < 1:
        attempt = 1
    if base_seconds < 0 or cap_seconds < 0:
        raise ValueError("backoff 参数不能为负数")
    return min(cap_seconds, base_seconds * (2 ** (attempt - 1)))


def parse_retry_after(header: str | None) -> int | None:
    """解析 Retry-After 头。

    仅支持 RFC 9110 的 delta-seconds 形式（纯整数秒）。
    HTTP-date 形式或非法值返回 None，由调用方退回到常规退避策略。
    """
    if header is None:
        return None
    header = header.strip()
    if not header:
        return None
    try:
        seconds = int(header)
    except ValueError:
        return None
    if seconds < 0:
        return None
    return seconds
