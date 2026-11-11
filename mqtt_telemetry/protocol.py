"""消息协议与领域规则。

上报报文（JSON）::

    {
      "boot_id": "b7f3...",      # 每次启动生成的唯一编号，重启即变
      "seq": 12,                 # 本启动周期内单调递增序号，从 1 开始
      "device_ts": 1731283200.5, # 设备时钟（Unix 秒）
      "value": 21.4,             # 测量值
      "unit": "degC"             # 测量单位
    }

消息身份 = (device_id, boot_id, seq)。
- 网络重发：三元组完全相同（含 broker 重投、clean_session=false 的排队消息）。
- 设备重启后 seq 重用：seq 相同但 boot_id 不同，属于合法的新一轮测量，
  绝不能仅按 (device_id, seq) 判重。
"""
from __future__ import annotations

import json
from dataclasses import dataclass

PROTOCOL_VERSION = 1

# 采集器内部统一使用的标准单位
CANONICAL_TEMPERATURE = "degC"
CANONICAL_PRESSURE = "hPa"
CANONICAL_HUMIDITY = "percent"

# 各物理量的可接受单位 -> 标准单位
UNIT_FAMILIES: dict[str, tuple[str, dict[str, float]]] = {
    "temperature": (
        CANONICAL_TEMPERATURE,
        {"degC": 1.0, "degF": 1.0, "kelvin": 1.0},
    ),
    "pressure": (CANONICAL_PRESSURE, {"hPa": 1.0, "kPa": 10.0, "Pa": 0.01}),
    "humidity": (CANONICAL_HUMIDITY, {"percent": 1.0, "ratio": 100.0}),
}

# unit -> (family, 线性换算系数与偏移： canonical = value * a + b)
UNIT_TABLE: dict[str, tuple[str, float, float]] = {
    "degC": ("temperature", 1.0, 0.0),
    "degF": ("temperature", 5.0 / 9.0, -32.0 * 5.0 / 9.0),
    "kelvin": ("temperature", 1.0, -273.15),
    "hPa": ("pressure", 1.0, 0.0),
    "kPa": ("pressure", 10.0, 0.0),
    "Pa": ("pressure", 0.01, 0.0),
    "percent": ("humidity", 1.0, 0.0),
    "ratio": ("humidity", 100.0, 0.0),
}


class ProtocolError(Exception):
    """报文无法解析或字段非法。"""


@dataclass(frozen=True)
class Measurement:
    device_id: str
    boot_id: str
    seq: int
    device_ts: float
    value: float
    unit: str
    retained: bool
    topic: str
    raw: str

    @property
    def identity(self) -> tuple[str, str, int]:
        return self.device_id, self.boot_id, self.seq


def parse_payload(topic: str, payload: bytes, retained: bool = False) -> Measurement:
    """解析并校验一条 MQTT 报文，失败抛 ProtocolError。"""
    device_id = _device_from_topic(topic)
    try:
        doc = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"payload 不是合法 JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise ProtocolError("payload 顶层必须是对象")

    try:
        boot_id = str(doc["boot_id"])
        seq = int(doc["seq"])
        device_ts = float(doc["device_ts"])
        value = float(doc["value"])
        unit = str(doc["unit"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ProtocolError(f"字段缺失或类型错误: {exc}") from exc

    if not boot_id:
        raise ProtocolError("boot_id 不能为空")
    if seq < 1:
        raise ProtocolError(f"seq 必须 >= 1，收到 {seq}")
    if unit not in UNIT_TABLE:
        raise ProtocolError(f"未知单位 {unit!r}，支持: {sorted(UNIT_TABLE)}")

    return Measurement(
        device_id=device_id,
        boot_id=boot_id,
        seq=seq,
        device_ts=device_ts,
        value=value,
        unit=unit,
        retained=retained,
        topic=topic,
        raw=payload.decode("utf-8", errors="replace"),
    )


def _device_from_topic(topic: str) -> str:
    # telemetry/<device_id>/up
    parts = topic.split("/")
    if len(parts) != 3 or parts[0] != "telemetry" or parts[2] != "up" or not parts[1]:
        raise ProtocolError(f"主题 {topic!r} 不符合 telemetry/<device_id>/up")
    return parts[1]


def to_canonical(value: float, unit: str) -> tuple[float, str]:
    """换算到标准单位，返回 (标准值, 标准单位)。"""
    family, factor, offset = UNIT_TABLE[unit]
    canonical_unit = UNIT_FAMILIES[family][0]
    return value * factor + offset, canonical_unit
