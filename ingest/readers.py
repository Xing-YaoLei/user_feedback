"""输入文件读取器：JSONL、JSON 数组、CSV。

读取阶段只负责把文件变成带原始位置的原始记录，不做任何映射或类型转换
（CSV 的来源类型转换在 transform 层按来源 schema 完成，保持职责单一）。

每条 RawRecord 都记录：
- source_file / position：失败记录里的「原始位置」，重试时可据此找回原文
- fmt：json 还是 csv，决定空值语义（CSV 空单元格 = 缺失，JSON null = 显式 null）
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, field
from typing import Any, Iterator

from .errors import IngestError

JSON_FORMATS = frozenset({"jsonl", "json", "ndjson"})
CSV_FORMATS = frozenset({"csv"})
SUPPORTED_FORMATS = JSON_FORMATS | CSV_FORMATS


@dataclass
class RawRecord:
    """一条待处理的原始记录。"""

    record: dict[str, Any]
    source_file: str
    position: str  # 人类可读且可定位，如 "line 12"、"row 5"、"array[3]"
    fmt: str
    # 文件级默认来源/版本（清单提供），记录内自带同名字段时以记录为准
    file_source: str | None = None
    file_version: str | None = None
    # 供失败重试时使用的原始位置元数据
    extras: dict[str, Any] = field(default_factory=dict)


def detect_format(path: str, explicit_fmt: str | None = None) -> str:
    if explicit_fmt:
        fmt = explicit_fmt.lower()
        if fmt not in SUPPORTED_FORMATS:
            raise IngestError(
                f"不支持的文件格式 {explicit_fmt!r}，支持：{sorted(SUPPORTED_FORMATS)}"
            )
        return "jsonl" if fmt == "ndjson" else fmt
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jsonl", ".ndjson"):
        return "jsonl"
    if ext == ".json":
        return "json"
    if ext == ".csv":
        return "csv"
    raise IngestError(
        f"无法从扩展名判断 {path} 的格式，请在批次清单中用 format 显式指定"
    )


def read_file(
    path: str,
    *,
    fmt: str | None = None,
    file_source: str | None = None,
    file_version: str | None = None,
) -> Iterator[RawRecord]:
    """按格式读取一个文件，逐条产出 RawRecord。"""
    resolved_fmt = detect_format(path, fmt)
    if resolved_fmt == "jsonl":
        yield from _read_jsonl(path, file_source, file_version)
    elif resolved_fmt == "json":
        yield from _read_json_array(path, file_source, file_version)
    else:
        yield from _read_csv(path, file_source, file_version)


def _read_jsonl(
    path: str, file_source: str | None, file_version: str | None
) -> Iterator[RawRecord]:
    with open(path, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            stripped = line.strip()
            if not stripped:  # 容忍空行
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise IngestError(
                    f"{path} 第 {line_no} 行不是合法 JSON：{exc.msg}"
                ) from exc
            if not isinstance(obj, dict):
                raise IngestError(
                    f"{path} 第 {line_no} 行的顶层结构必须是对象，实际为 "
                    f"{type(obj).__name__}"
                )
            yield RawRecord(
                record=obj,
                source_file=path,
                position=f"line {line_no}",
                fmt="jsonl",
                file_source=file_source,
                file_version=file_version,
            )


def _read_json_array(
    path: str, file_source: str | None, file_version: str | None
) -> Iterator[RawRecord]:
    with open(path, "r", encoding="utf-8") as fh:
        try:
            payload = json.load(fh)
        except json.JSONDecodeError as exc:
            raise IngestError(f"{path} 不是合法 JSON：{exc.msg}") from exc
    if not isinstance(payload, list):
        raise IngestError(
            f"{path} 的顶层结构必须是事件数组，实际为 {type(payload).__name__}"
        )
    for index, obj in enumerate(payload):
        if not isinstance(obj, dict):
            raise IngestError(
                f"{path} 数组下标 {index} 的元素必须是对象，实际为 "
                f"{type(obj).__name__}"
            )
        yield RawRecord(
            record=obj,
            source_file=path,
            position=f"array[{index}]",
            fmt="json",
            file_source=file_source,
            file_version=file_version,
        )


def _read_csv(
    path: str, file_source: str | None, file_version: str | None
) -> Iterator[RawRecord]:
    # utf-8-sig 自动剥掉 Excel 常见的 BOM
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise IngestError(f"{path} 是空 CSV，缺少表头")
        for row_index, row in enumerate(reader, start=2):  # 表头占第 1 行
            cleaned: dict[str, Any] = {}
            for key, value in row.items():
                if key is None:
                    # 行内字段多于表头时 DictReader 用 None 收纳，直接忽略并提示
                    raise IngestError(
                        f"{path} 第 {row_index} 行出现了表头之外的额外列"
                    )
                # CSV 没有 null 概念：空单元格统一视为「字段缺失」，
                # 与 JSON 的显式 null 区分开
                if value is None or value == "":
                    continue
                cleaned[key] = value
            yield RawRecord(
                record=cleaned,
                source_file=path,
                position=f"row {row_index}",
                fmt="csv",
                file_source=file_source,
                file_version=file_version,
            )
