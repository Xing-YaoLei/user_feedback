"""结构化数据模型：字段结果、整页结果、人工修订历史。"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

# 字段状态机
STATUS_AUTO = "auto"            # 自动识别且通过全部校验
STATUS_NEEDS_REVIEW = "needs_review"
STATUS_CONFIRMED = "confirmed"  # 经人工确认/修改
STATUS_BLANK = "blank"          # 源图该区域为空（保留 None，不填 0）


@dataclass
class FieldResult:
    key: str
    label: str
    ftype: str
    # 识别值：数值字段为 float/int，勾选组为 list[str]，文本为 str；空 -> None
    value: Any = None
    raw_text: str = ""                 # OCR 原始文本（未清洗）
    confidence: Optional[float] = None # OCR 平均置信度 0~100；勾选组为几何得分
    status: str = STATUS_AUTO
    review_reasons: list[str] = field(default_factory=list)
    # 来源坐标：归一化画布上的区域 + 原图（透视/旋转校正前）上的多边形
    region_norm: tuple[float, float, float, float] = (0, 0, 0, 0)
    source_polygon: list[list[float]] = field(default_factory=list)
    unit: Optional[str] = None
    detected_unit: Optional[str] = None
    manual: bool = False               # 是否含人工修改
    updated_at: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PageResult:
    page_id: str
    source_path: str
    template_id: Optional[str]
    template_name: Optional[str]
    # 校正参数，用于坐标反算与前端叠加
    rotate_angle: float = 0.0
    homography: Optional[list[float]] = None  # 3x3 展平
    page_corners: list[list[float]] = field(default_factory=list)
    fields: dict[str, FieldResult] = field(default_factory=dict)
    created_at: float = field(default_factory=lambda: time.time())
    reprocessed_count: int = 0

    @property
    def needs_review(self) -> bool:
        return any(f.status == STATUS_NEEDS_REVIEW for f in self.fields.values())

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["needs_review"] = self.needs_review
        return d


@dataclass
class Revision:
    """人工修改历史条目。"""

    rev_id: str
    page_id: str
    field_key: str
    old_value: Any
    new_value: Any
    old_status: str
    new_status: str
    editor: str
    note: str
    ts: float = field(default_factory=lambda: time.time())

    @staticmethod
    def create(page_id: str, field_key: str, old_value: Any, new_value: Any,
               old_status: str, new_status: str, editor: str = "operator",
               note: str = "") -> "Revision":
        return Revision(
            rev_id=str(uuid.uuid4()), page_id=page_id, field_key=field_key,
            old_value=old_value, new_value=new_value,
            old_status=old_status, new_status=new_status,
            editor=editor, note=note,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
