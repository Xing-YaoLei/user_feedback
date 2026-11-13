"""批次文件读取：支持 CSV 与 JSON Lines。

校准记录字段：cal_id, instrument, registered_at, valid_from, valid_to, coefficient
（valid_to 可空，表示开放区间；coefficient 支持乘数或公式，见 engine.apply_coefficient）

测量明细字段：measurement_id, instrument, measured_at, raw_reading
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from typing import Iterator, List, Sequence

from .timeutil import normalize_ts

CAL_FIELDS = (
    "cal_id",
    "instrument",
    "registered_at",
    "valid_from",
    "valid_to",
    "coefficient",
)
MEAS_FIELDS = ("measurement_id", "instrument", "measured_at", "raw_reading")


@dataclass(frozen=True)
class CalibrationRow:
    cal_id: str
    instrument: str
    registered_at: str
    valid_from: str
    valid_to: str | None
    coefficient: str


@dataclass(frozen=True)
class MeasurementRow:
    measurement_id: str
    instrument: str
    measured_at: str
    raw_reading: float


class InputError(ValueError):
    """输入文件格式或字段错误。"""


def _detect_format(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        return "csv"
    if ext in (".jsonl", ".ndjson"):
        return "jsonl"
    raise InputError(f"不支持的文件类型 {ext}，请使用 .csv / .jsonl")


def _iter_raw(path: str) -> Iterator[dict]:
    fmt = _detect_format(path)
    if fmt == "csv":
        with open(path, newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                yield {(k or "").strip(): (v.strip() if isinstance(v, str) else v)
                       for k, v in row.items() if k}
        return
    with open(path, encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise InputError(f"{path}:{lineno} 不是合法 JSON: {exc}") from exc
            if not isinstance(obj, dict):
                raise InputError(f"{path}:{lineno} 每行必须是 JSON 对象")
            yield obj


def _check_fields(row: dict, required: Sequence[str], path: str) -> None:
    missing = [f for f in required if f not in row or row[f] in (None, "")]
    if missing:
        raise InputError(f"{path} 缺少必填字段: {', '.join(missing)}；当前行: {row}")


def read_calibrations(path: str) -> List[CalibrationRow]:
    """读取并校验一个校准记录批次，时间字段归一化为 UTC。"""
    rows: List[CalibrationRow] = []
    seen: set[str] = set()
    for raw in _iter_raw(path):
        _check_fields(raw, ("cal_id", "instrument", "registered_at",
                            "valid_from", "coefficient"), path)
        cal_id = str(raw["cal_id"]).strip()
        if cal_id in seen:
            raise InputError(f"{path} 批次内校准编号重复: {cal_id}")
        seen.add(cal_id)
        valid_to_raw = raw.get("valid_to")
        try:
            registered_at = normalize_ts(raw["registered_at"])
            valid_from = normalize_ts(raw["valid_from"])
            valid_to = (normalize_ts(valid_to_raw)
                        if valid_to_raw not in (None, "") else None)
        except ValueError as exc:
            raise InputError(f"{path} 校准 {cal_id}: {exc}") from exc
        if valid_to is not None and valid_to <= valid_from:
            raise InputError(
                f"{path} 校准 {cal_id} 的 valid_to 必须晚于 valid_from"
                f"（生效区间为左闭右开 [valid_from, valid_to)）")
        rows.append(CalibrationRow(
            cal_id=cal_id,
            instrument=str(raw["instrument"]).strip(),
            registered_at=normalize_ts(raw["registered_at"]),
            valid_from=valid_from,
            valid_to=valid_to,
            coefficient=str(raw["coefficient"]).strip(),
        ))
    return rows


def read_measurements(path: str) -> List[MeasurementRow]:
    """读取并校验一个测量明细批次。"""
    rows: List[MeasurementRow] = []
    seen: set[str] = set()
    for raw in _iter_raw(path):
        _check_fields(raw, ("measurement_id", "instrument",
                            "measured_at", "raw_reading"), path)
        mid = str(raw["measurement_id"]).strip()
        if mid in seen:
            raise InputError(f"{path} 批次内测量编号重复: {mid}")
        seen.add(mid)
        try:
            reading = float(raw["raw_reading"])
        except (TypeError, ValueError) as exc:
            raise InputError(f"{path} 测量 {mid} 的原始读数不是数字: "
                             f"{raw['raw_reading']!r}") from exc
        try:
            measured_at = normalize_ts(raw["measured_at"])
        except ValueError as exc:
            raise InputError(f"{path} 测量 {mid}: {exc}") from exc
        rows.append(MeasurementRow(
            measurement_id=mid,
            instrument=str(raw["instrument"]).strip(),
            measured_at=measured_at,
            raw_reading=reading,
        ))
    return rows
