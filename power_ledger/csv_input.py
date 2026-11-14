"""读取三张输入 CSV：电表读数、电表归属、电价。

读数支持两种模式（整表二选一）：

* 累计模式 ``meter_id, reading_time, meter_reading`` —— 增量由引擎按同表时间序计算；
* 增量模式 ``meter_id, reading_time, consumption_kwh`` —— 直接使用。
"""

import csv

from .errors import LedgerError
from .jsonutil import to_decimal
from .timeutil import parse_beijing


def _open_csv(path):
    # utf-8-sig 兼容带 BOM 的 Excel 导出
    return open(path, "r", encoding="utf-8-sig", newline="")


def _require_headers(reader, required, path, kind):
    headers = reader.fieldnames or []
    missing = [h for h in required if h not in headers]
    if missing:
        raise LedgerError(
            f"{kind} {path} 缺少必需列: {', '.join(missing)}；实际列为: {', '.join(headers)}"
        )


def load_readings(path):
    """返回 ``(mode, readings)``；mode 为 ``cumulative`` 或 ``incremental``。

    每条读数为 dict，保留原始行号，时间统一为带北京时区的 datetime。
    同一表计同一时刻重复出现直接判为输入错误。
    """
    with _open_csv(path) as fh:
        reader = csv.DictReader(fh)
        headers = reader.fieldnames or []
        if "meter_reading" in headers and "consumption_kwh" in headers:
            raise LedgerError(
                f"读数文件 {path} 同时包含 meter_reading 与 consumption_kwh，"
                "累计模式与增量模式必须二选一"
            )
        if "meter_reading" in headers:
            mode = "cumulative"
            _require_headers(reader, ["meter_id", "reading_time", "meter_reading"], path, "读数文件")
        elif "consumption_kwh" in headers:
            mode = "incremental"
            _require_headers(
                reader, ["meter_id", "reading_time", "consumption_kwh"], path, "读数文件"
            )
        else:
            raise LedgerError(
                f"读数文件 {path} 必须包含 meter_reading（累计模式）或 "
                "consumption_kwh（增量模式）列"
            )

        readings = []
        seen = set()
        for row_no, row in enumerate(reader, start=2):  # 表头是第 1 行
            meter_id = (row.get("meter_id") or "").strip()
            time_text = (row.get("reading_time") or "").strip()
            if not meter_id:
                raise LedgerError(f"读数文件 {path} 第 {row_no} 行 meter_id 为空")
            try:
                ts = parse_beijing(time_text)
            except Exception as exc:
                raise LedgerError(
                    f"读数文件 {path} 第 {row_no} 行 reading_time 无法解析: {time_text!r} ({exc})"
                )
            key = (meter_id, ts)
            if key in seen:
                raise LedgerError(
                    f"读数文件 {path} 第 {row_no} 行与同一表计 {meter_id} 的已有读数时刻重复: "
                    f"{ts.isoformat()}，同一表计同一时刻出现两条读数视为输入错误"
                )
            seen.add(key)
            item = {
                "meter_id": meter_id,
                "ts": ts,
                "row_no": row_no,
            }
            if mode == "cumulative":
                item["meter_reading"] = to_decimal(
                    row.get("meter_reading"), "meter_reading", row_no
                )
            else:
                item["consumption_kwh"] = to_decimal(
                    row.get("consumption_kwh"), "consumption_kwh", row_no
                )
            readings.append(item)

    if not readings:
        raise LedgerError(f"读数文件 {path} 没有任何数据行")
    return mode, readings


def _parse_rule_window(row, row_no, path, kind):
    from_text = (row.get("valid_from") or "").strip()
    to_text = (row.get("valid_to") or "").strip()
    if not from_text:
        raise LedgerError(f"{kind} {path} 第 {row_no} 行 valid_from 为空")
    try:
        valid_from = parse_beijing(from_text)
    except Exception as exc:
        raise LedgerError(f"{kind} {path} 第 {row_no} 行 valid_from 无法解析: {exc}")
    valid_to = None
    if to_text:
        try:
            valid_to = parse_beijing(to_text)
        except Exception as exc:
            raise LedgerError(f"{kind} {path} 第 {row_no} 行 valid_to 无法解析: {exc}")
        if valid_to <= valid_from:
            raise LedgerError(
                f"{kind} {path} 第 {row_no} 行区间非法: "
                f"valid_to {to_text} 必须晚于 valid_from {from_text}"
            )
    return valid_from, valid_to


def load_attribution(path):
    """读取归属表，返回规则 dict 列表（含 datetime 形式的区间端点）。"""
    rules = []
    with _open_csv(path) as fh:
        reader = csv.DictReader(fh)
        _require_headers(
            reader,
            ["meter_id", "workshop_id", "workshop_name", "valid_from"],
            path,
            "归属表",
        )
        for row_no, row in enumerate(reader, start=2):
            meter_id = (row.get("meter_id") or "").strip()
            workshop_id = (row.get("workshop_id") or "").strip()
            workshop_name = (row.get("workshop_name") or "").strip()
            if not meter_id or not workshop_id:
                raise LedgerError(
                    f"归属表 {path} 第 {row_no} 行 meter_id / workshop_id 不能为空"
                )
            valid_from, valid_to = _parse_rule_window(row, row_no, path, "归属表")
            rules.append(
                {
                    "rule_id": (row.get("rule_id") or "").strip(),
                    "kind": "attribution",
                    "meter_id": meter_id,
                    "workshop_id": workshop_id,
                    "workshop_name": workshop_name,
                    "valid_from": valid_from,
                    "valid_to": valid_to,
                }
            )
    if not rules:
        raise LedgerError(f"归属表 {path} 没有任何数据行")
    return rules


def load_tariff(path):
    """读取电价表，返回规则 dict 列表。workshop_id 为空表示全车间生效。"""
    rules = []
    with _open_csv(path) as fh:
        reader = csv.DictReader(fh)
        _require_headers(reader, ["valid_from", "price_per_kwh"], path, "电价表")
        for row_no, row in enumerate(reader, start=2):
            workshop_id = (row.get("workshop_id") or "").strip()
            valid_from, valid_to = _parse_rule_window(row, row_no, path, "电价表")
            price = to_decimal(row.get("price_per_kwh"), "price_per_kwh", row_no)
            if price < 0:
                raise LedgerError(
                    f"电价表 {path} 第 {row_no} 行 price_per_kwh 不能为负: {price}"
                )
            rules.append(
                {
                    "rule_id": (row.get("rule_id") or "").strip(),
                    "kind": "tariff",
                    "workshop_id": workshop_id,
                    "valid_from": valid_from,
                    "valid_to": valid_to,
                    "price_per_kwh": price,
                }
            )
    if not rules:
        raise LedgerError(f"电价表 {path} 没有任何数据行")
    return rules
