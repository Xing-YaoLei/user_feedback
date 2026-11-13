"""类型系统与跨版本类型转换规则。

支持的目标/来源类型：
- string:   字符串
- integer:  整数
- number:   数值（整数或浮点）
- boolean:  布尔
- datetime: ISO 8601 日期时间（含时区时保留，无时区按原值保留）
- json:     任意 JSON 结构（对象/数组等，原样透传）

CSV 里所有值天然是字符串，读取后先按来源 schema 声明的类型做「源类型转换」；
映射时再按目标字段类型做「目标类型转换」。两阶段分开，报错时能指出
到底是原始值不符合来源 schema，还是映射后不符合目标格式。
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from .errors import TransformError

SUPPORTED_TYPES = frozenset(
    {"string", "integer", "number", "boolean", "datetime", "json"}
)

# CSV / 字符串形态下布尔的合法字面量（小写比较）
_BOOL_LITERALS = {
    "true": True,
    "false": False,
    "1": True,
    "0": False,
    "yes": True,
    "no": False,
    "y": True,
    "n": False,
}


def validate_type_name(type_name: str, where: str) -> None:
    if type_name not in SUPPORTED_TYPES:
        raise ValueError(
            f"{where} 使用了不支持的类型 {type_name!r}，"
            f"支持的类型：{sorted(SUPPORTED_TYPES)}"
        )


def convert(value: Any, target_type: str, *, where: str = "字段") -> Any:
    """把一个 Python 原生值转换为 target_type。

    显式 None 不在这里处理（null 的可空性由 transform 层判断）。
    转换失败抛 TransformError，reason_code 固定为 type_mismatch，
    错误信息同时给出实际值与目标类型，便于失败记录里展示原因。
    """
    validate_type_name(target_type, where)

    # json 类型：任何可 JSON 序列化的结构都接受，原样透传
    if target_type == "json":
        return value
    if target_type == "string":
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, str):
            return value
        if isinstance(value, (int, float)):
            return str(value)
        raise TransformError(
            f"{where} 的值 {value!r}（{type(value).__name__}）无法转换为 string",
            reason_code="type_mismatch",
        )
    if target_type == "integer":
        if isinstance(value, bool):  # bool 是 int 的子类，显式拒绝避免歧义
            raise TransformError(
                f"{where} 的布尔值 {value!r} 不应转换为 integer",
                reason_code="type_mismatch",
            )
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            if value.is_integer():
                return int(value)
            raise TransformError(
                f"{where} 的数值 {value!r} 含小数部分，无法转换为 integer",
                reason_code="type_mismatch",
            )
        if isinstance(value, str):
            text = value.strip()
            try:
                # 禁止 "3.5" 之类悄悄截断；只接受整数字面量
                return int(text, 10)
            except ValueError:
                raise TransformError(
                    f"{where} 的文本 {value!r} 不是合法整数，无法转换为 integer",
                    reason_code="type_mismatch",
                ) from None
        raise TransformError(
            f"{where} 的值 {value!r}（{type(value).__name__}）无法转换为 integer",
            reason_code="type_mismatch",
        )
    if target_type == "number":
        if isinstance(value, bool):
            raise TransformError(
                f"{where} 的布尔值 {value!r} 不应转换为 number",
                reason_code="type_mismatch",
            )
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            text = value.strip()
            try:
                return float(text)
            except ValueError:
                raise TransformError(
                    f"{where} 的文本 {value!r} 不是合法数值，无法转换为 number",
                    reason_code="type_mismatch",
                ) from None
        raise TransformError(
            f"{where} 的值 {value!r}（{type(value).__name__}）无法转换为 number",
            reason_code="type_mismatch",
        )
    if target_type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            literal = value.strip().lower()
            if literal in _BOOL_LITERALS:
                return _BOOL_LITERALS[literal]
            raise TransformError(
                f"{where} 的文本 {value!r} 不是合法布尔字面量"
                f"（允许 true/false/1/0/yes/no/y/n），无法转换为 boolean",
                reason_code="type_mismatch",
            )
        if isinstance(value, int) and value in (0, 1):
            return bool(value)
        raise TransformError(
            f"{where} 的值 {value!r}（{type(value).__name__}）无法转换为 boolean",
            reason_code="type_mismatch",
        )
    if target_type == "datetime":
        if isinstance(value, _dt.datetime):
            return value
        if isinstance(value, str):
            text = value.strip()
            try:
                # Python 3.11+ 原生支持结尾的 Z
                return _dt.datetime.fromisoformat(text)
            except ValueError:
                raise TransformError(
                    f"{where} 的文本 {value!r} 不是合法 ISO 8601 日期时间",
                    reason_code="type_mismatch",
                ) from None
        raise TransformError(
            f"{where} 的值 {value!r}（{type(value).__name__}）无法转换为 datetime",
            reason_code="type_mismatch",
        )
    # 理论上不可达，validate_type_name 已兜底
    raise TransformError(f"{where} 遇到未知目标类型 {target_type!r}")


def is_compatible(source_type: str | None, target_type: str) -> bool:
    """静态判断某来源类型是否可能转换到目标类型（供预检使用）。

    source_type 为 None 表示来源字段没有类型声明（自由 JSON），
    此时一律视为「运行时才能确定」，按兼容处理，风险留给单条记录的运行时校验。
    """
    if target_type == "json":
        return True
    if source_type is None:
        return True
    if source_type == target_type:
        return True
    # 整数可以安全拓宽为数值；反向（number -> integer）静态判不兼容，
    # 因为小数在运行时会丢精度/失败，预检应提前报出
    if source_type == "integer" and target_type == "number":
        return True
    # 各基础类型都允许经字符串形态互转（datetime/string、int/string 等），
    # 预检只拦截确定不可能的组合：布尔不进数值/时间，时间不进布尔/数值
    if target_type == "boolean":
        return source_type == "string" or source_type == "integer"
    if target_type == "datetime":
        return source_type == "string"
    if source_type == "boolean":
        return target_type == "string"
    if source_type == "datetime":
        return target_type == "string"
    # number -> integer 可能丢小数，静态判不兼容；string -> integer
    # 保留（整数字符串可转换，脏值在运行时拦截）
    if source_type == "number" and target_type == "integer":
        return False
    return True


def describe_json_type(value: Any) -> str:
    """把一个 Python 值的类型描述成 JSON 风格名称，用于错误信息。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    return type(value).__name__
