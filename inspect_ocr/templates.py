"""两种固定版式的模板定义。

设计要点
--------
1. 所有区域用归一化画布的相对比例 (x0, y0, x1, y1) 表示，取值 0~1，
   透视/旋转校正并归一化后直接换算为像素坐标，与扫描分辨率无关。
2. 字段与区域绑定（region-based），OCR 只在各自区域内执行，
   绝不把整页 OCR 文本按出现顺序塞入表格。
3. 每个模板带独立锚点（anchor），用于版式识别。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

FieldType = Literal["text", "device_id", "date", "number", "checkbox_group"]
ReviewReason = Literal[
    "low_confidence",
    "id_format_error",
    "unit_conflict",
    "blank_field",
    "no_ocr_result",
]


@dataclass(frozen=True)
class FieldSpec:
    """单个字段的区域定义与校验规则。"""

    key: str
    label: str
    ftype: FieldType
    # 相对区域 (x0, y0, x1, y1)，均为归一化画布比例
    region: tuple[float, float, float, float]
    unit: str | None = None
    # number 字段允许的单位集合（出现其它单位 -> unit_conflict）
    allowed_units: tuple[str, ...] = ()
    # 编号/日期的正则（在清洗后的文本上匹配）
    pattern: str | None = None
    # checkbox_group：候选项 -> 各自小框的相对区域
    options: tuple[tuple[str, tuple[float, float, float, float]], ...] = ()
    # 允许空白（空白字段不报错，但保持 None，绝不自动填 0）
    allow_blank: bool = True
    psm: str = "--psm 6"


@dataclass(frozen=True)
class TemplateSpec:
    template_id: str
    name: str
    # 版式识别锚点文本（OCR 整页后匹配其中任一即命中）
    anchors: tuple[str, ...]
    # 锚点匹配的最低相似度
    anchor_min_ratio: float
    fields: tuple[FieldSpec, ...] = field(default_factory=tuple)

    def field_map(self) -> dict[str, FieldSpec]:
        return {f.key: f for f in self.fields}


# ---------------------------------------------------------------------------
# 版式 A：电力设备巡检记录表（表头字段 + 读数表格，单位 kWh / V / A）
# ---------------------------------------------------------------------------

TEMPLATE_A = TemplateSpec(
    template_id="A",
    name="电力设备巡检记录表",
    anchors=("电力设备巡检记录表", "电力", "巡检记录"),
    anchor_min_ratio=0.6,
    fields=(
        FieldSpec(
            key="device_id",
            label="设备编号",
            ftype="device_id",
            region=(0.62, 0.135, 0.92, 0.175),
            pattern=r"^EQ-\d{6}$",
            allow_blank=False,
            psm="--psm 7",
        ),
        FieldSpec(
            key="inspect_date",
            label="巡检日期",
            ftype="date",
            region=(0.62, 0.195, 0.92, 0.235),
            pattern=r"^\d{4}-\d{2}-\d{2}$",
            allow_blank=False,
            psm="--psm 7",
        ),
        FieldSpec(
            key="inspector",
            label="巡检员",
            ftype="text",
            region=(0.62, 0.255, 0.92, 0.295),
            psm="--psm 7",
        ),
        FieldSpec(
            key="meter_reading",
            label="电能表读数",
            ftype="number",
            region=(0.30, 0.47, 0.52, 0.515),
            unit="kWh",
            allowed_units=("kWh", "kwh", "度"),
            psm="--psm 7",
        ),
        FieldSpec(
            key="voltage",
            label="电压",
            ftype="number",
            region=(0.30, 0.545, 0.52, 0.59),
            unit="V",
            allowed_units=("V", "v", "伏特"),
            psm="--psm 7",
        ),
        FieldSpec(
            key="current",
            label="电流",
            ftype="number",
            region=(0.30, 0.62, 0.52, 0.665),
            unit="A",
            allowed_units=("A", "a", "安培"),
            psm="--psm 7",
        ),
        FieldSpec(
            key="status",
            label="运行状态",
            ftype="checkbox_group",
            region=(0.28, 0.70, 0.92, 0.76),
            options=(
                ("正常运行", (0.30, 0.705, 0.345, 0.755)),
                ("待机", (0.52, 0.705, 0.565, 0.755)),
                ("故障", (0.72, 0.705, 0.765, 0.755)),
            ),
        ),
        FieldSpec(
            key="remark",
            label="备注",
            ftype="text",
            region=(0.20, 0.80, 0.92, 0.87),
            allow_blank=True,
            psm="--psm 6",
        ),
    ),
)

# ---------------------------------------------------------------------------
# 版式 B：机械设备日常点检表（纵向参数行，单位 MPa / °C / h，复选项目）
# ---------------------------------------------------------------------------

TEMPLATE_B = TemplateSpec(
    template_id="B",
    name="机械设备日常点检表",
    anchors=("机械设备日常点检表", "点检表", "机械"),
    anchor_min_ratio=0.6,
    fields=(
        FieldSpec(
            key="device_id",
            label="设备编号",
            ftype="device_id",
            region=(0.60, 0.135, 0.92, 0.175),
            pattern=r"^MC-\d{6}$",
            allow_blank=False,
            psm="--psm 7",
        ),
        FieldSpec(
            key="inspect_date",
            label="点检日期",
            ftype="date",
            region=(0.60, 0.195, 0.92, 0.235),
            pattern=r"^\d{4}/\d{2}/\d{2}$",
            allow_blank=False,
            psm="--psm 7",
        ),
        FieldSpec(
            key="team",
            label="作业班组",
            ftype="text",
            region=(0.60, 0.255, 0.92, 0.295),
            psm="--psm 7",
        ),
        FieldSpec(
            key="oil_pressure",
            label="润滑油压力",
            ftype="number",
            region=(0.55, 0.40, 0.80, 0.445),
            unit="MPa",
            allowed_units=("MPa", "mpa", "兆帕"),
            psm="--psm 7",
        ),
        FieldSpec(
            key="temperature",
            label="轴承温度",
            ftype="number",
            region=(0.55, 0.48, 0.80, 0.525),
            unit="°C",
            allowed_units=("°C", "℃", "C", "度"),
            psm="--psm 7",
        ),
        FieldSpec(
            key="run_hours",
            label="累计运行时长",
            ftype="number",
            region=(0.55, 0.56, 0.80, 0.605),
            unit="h",
            allowed_units=("h", "小时", "H"),
            psm="--psm 7",
        ),
        FieldSpec(
            key="check_items",
            label="点检项目",
            ftype="checkbox_group",
            region=(0.20, 0.65, 0.92, 0.80),
            options=(
                ("润滑良好", (0.24, 0.66, 0.285, 0.705)),
                ("紧固到位", (0.24, 0.725, 0.285, 0.77)),
                ("无异响", (0.60, 0.66, 0.645, 0.705)),
                ("无泄漏", (0.60, 0.725, 0.645, 0.77)),
            ),
        ),
        FieldSpec(
            key="remark",
            label="备注",
            ftype="text",
            region=(0.20, 0.82, 0.92, 0.88),
            allow_blank=True,
            psm="--psm 6",
        ),
    ),
)

TEMPLATES: dict[str, TemplateSpec] = {
    TEMPLATE_A.template_id: TEMPLATE_A,
    TEMPLATE_B.template_id: TEMPLATE_B,
}
