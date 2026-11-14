"""JSON 序列化、规范化哈希与十进制处理。

内部计算统一用 ``Decimal`` 保证金额、电量精确且可复现；
写入 JSON 时转为保留 6 位小数后的 float，展示干净且往返一致。
"""

import hashlib
import json
from datetime import datetime
from decimal import Decimal

Q6 = Decimal("0.000001")


class LedgerEncoder(json.JSONEncoder):
    """文件落盘用的编码器：Decimal→float，datetime→ISO 字符串。"""

    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, datetime):
            return o.isoformat()
        return super().default(o)


def _canonical_default(o):
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, datetime):
        return o.isoformat()
    raise TypeError(f"不可规范化的类型: {type(o)!r}")


def canonical_bytes(obj):
    """排序键、紧凑分隔的规范化 JSON 字节，用于内容哈希与逐字段比较。

    先经一次 JSON 往返（Decimal→float、datetime→字符串），保证内存对象与
    「落盘后再读回」的对象哈希一致。
    """
    round_tripped = json.loads(
        json.dumps(obj, ensure_ascii=False, default=_canonical_default)
    )
    return json.dumps(
        round_tripped,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def content_hash(obj):
    """返回 ``sha256:<hex>`` 形式的内容哈希。"""
    return "sha256:" + hashlib.sha256(canonical_bytes(obj)).hexdigest()


def dump_json(obj):
    """序列化为落盘字符串（缩进、UTF-8、Decimal/datetime 自定义编码）。"""
    return json.dumps(obj, indent=2, ensure_ascii=False, cls=LedgerEncoder)


def to_decimal(value, field, row_no):
    """把 CSV 单元格解析为 Decimal，空值/非法值抛中文错误。"""
    text = (value or "").strip()
    if text == "":
        raise ValueError(f"第 {row_no} 行字段 {field} 为空")
    try:
        return Decimal(text)
    except Exception:
        raise ValueError(f"第 {row_no} 行字段 {field} 不是数字: {text!r}")
