"""详情页解析：公告编号/版次提取、表格校验、停水时段记录生成。"""

from __future__ import annotations

import re

from .html import parse_html
from .tables import expand_table, resolve_columns
from .timeparse import iso_format, parse_time

_VERSION_RE = re.compile(r"第\s*(\d+)\s*版")
_NOTICE_ID_RE = re.compile(r"公告编号[::]?\s*([A-Za-z0-9\-_]+)")
REQUIRED_COLUMNS = ("region", "start", "end")


def _meta_value(root, key):
    for meta in root.find_all("meta"):
        if (meta.get("name") or "").lower() == key:
            return meta.get("content", "").strip()
    return None


def _body_text(root):
    """正文文本：排除 head 内的 meta/title 属性值干扰。"""
    parts = []
    for node in root.iter_nodes():
        if node.tag is not None:
            continue
        parent = node.parent
        in_head = False
        while parent is not None:
            if parent.tag == "head":
                in_head = True
                break
            parent = parent.parent
        if not in_head and node.text.strip():
            parts.append(node.text)
    return "\n".join(parts)


def extract_notice_id(root, fallback=None):
    value = _meta_value(root, "notice-id")
    if value:
        return value
    match = _NOTICE_ID_RE.search(_body_text(root))
    if match:
        return match.group(1)
    return fallback


def extract_version(root, fallback=None):
    value = _meta_value(root, "notice-version")
    if value:
        digits = re.search(r"\d+", value)
        if digits:
            return int(digits.group())
    match = _VERSION_RE.search(_body_text(root))
    if match:
        return int(match.group(1))
    if fallback is not None:
        digits = re.search(r"\d+", str(fallback))
        if digits:
            return int(digits.group())
    return None


def _anomaly(notice_id, version, url, error_type, location, detail):
    return {
        "notice_id": notice_id,
        "version": version,
        "source_url": url,
        "error_type": error_type,
        "location": location,
        "detail": detail,
    }


def parse_notice(markup, url, fallback_notice_id=None, fallback_version=None):
    """解析一则公告详情页。

    返回 (records, anomalies)：
    - records: 每行一个区域的停水时段；整则公告有异常时为空列表
    - anomalies: 异常清单条目（缺列 / 时间不合法 / 行顺序颠倒）
    """
    root = parse_html(markup)
    notice_id = extract_notice_id(root, fallback_notice_id)
    version = extract_version(root, fallback_version)

    tables = root.find_all("table")
    if not tables:
        return [], [_anomaly(notice_id, version, url, "no_table",
                             "页面", "详情页未找到任何数据表格")]

    label = {"region": "区域列", "start": "开始时间列", "end": "结束时间列"}
    candidate_seen = False
    for table_index, table in enumerate(tables, start=1):
        grid = expand_table(table)
        if not grid:
            continue
        mapping, header_count = resolve_columns(grid, table)
        recognized = [name for name in REQUIRED_COLUMNS if name in mapping]
        if not recognized:
            # 不含任何可识别表头：视为布局表/无关表，跳过
            continue
        candidate_seen = True
        missing = [name for name in REQUIRED_COLUMNS if name not in mapping]
        if missing:
            # 最新版缺列：记录异常并跳过整则公告的全部时段
            return [], [_anomaly(
                notice_id, version, url, "missing_columns",
                f"表{table_index} 表头",
                "缺少必需列: " + "、".join(label[m] for m in missing),
            )]

        # 第一张含完整列的表即目标表
        anomalies = []
        records = []
        for offset, row in enumerate(grid[header_count:], start=1):
            region = row[mapping["region"]]["text"]
            start_raw = row[mapping["start"]]["text"]
            end_raw = row[mapping["end"]]["text"]
            location = f"表{table_index} 第{header_count + offset}行"

            if not region and not start_raw and not end_raw:
                continue  # 展开后产生的全空行直接跳过

            try:
                start_time = parse_time(start_raw)
            except ValueError as exc:
                anomalies.append(_anomaly(
                    notice_id, version, url, "invalid_time",
                    f"{location} 开始时间", str(exc)))
                continue
            try:
                end_time = parse_time(end_raw)
            except ValueError as exc:
                anomalies.append(_anomaly(
                    notice_id, version, url, "invalid_time",
                    f"{location} 结束时间", str(exc)))
                continue

            if end_time <= start_time:
                # 任一行结束时间不晚于开始时间：整则公告全部时段跳过
                anomalies.append(_anomaly(
                    notice_id, version, url, "time_order",
                    location,
                    f"结束时间 {end_raw!r} 不晚于开始时间 {start_raw!r}",
                ))
                return [], anomalies

            records.append({
                "region": region,
                "start_time": iso_format(start_time),
                "end_time": iso_format(end_time),
                "start_raw": start_raw,
                "end_raw": end_raw,
            })
        return records, anomalies

    error_type = "empty_table" if candidate_seen else "unrecognized_table"
    detail = ("数据表格没有可解析的行" if candidate_seen
              else "所有表格均未识别出区域/开始时间/结束时间表头")
    return [], [_anomaly(notice_id, version, url, error_type, "页面", detail)]


def build_output_records(records, notice_id, version, url):
    """补上公告编号、版次与来源链接，生成 JSONL 记录。"""
    result = []
    for row in records:
        result.append({
            "notice_id": notice_id,
            "version": version,
            "region": row["region"],
            "start_time": row["start_time"],
            "end_time": row["end_time"],
            "source_url": url,
        })
    return result
