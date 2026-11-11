"""采集主管线：版式识别 -> 旋转/透视校正 -> 区域字段提取 -> 结构化结果。

重识别（reprocess）规则：
* 重新跑完整识别管线；
* 已被人工确认/修改的字段（manual=True）保留人工值与状态，
  仅刷新来源坐标，并写入修订历史说明；
* 其余字段以新识别结果覆盖。
"""

from __future__ import annotations

import uuid
from pathlib import Path


from .classifier import classify
from .extractor import extract_page
from .models import (
    FieldResult,
    PageResult,
    Revision,
    STATUS_AUTO,
    STATUS_CONFIRMED,
    STATUS_NEEDS_REVIEW,
)
from .preprocess import correct_image, load_image


def process_image(path: str, *, skip_orientation: bool = False) -> PageResult:
    bgr = load_image(path)
    # 1) 先做方向旋转，保证标题可读后再识别版式
    corr = correct_image(bgr, skip_orientation=skip_orientation)
    # 2) 版式识别（锚点匹配），识别不出版本时不猜测、转人工
    template, score, _page_text = classify(corr.canvas)
    page = PageResult(
        page_id=str(uuid.uuid4()),
        source_path=str(Path(path).resolve()),
        template_id=template.template_id if template else None,
        template_name=template.name if template else None,
        rotate_angle=corr.rotate_angle,
        homography=corr.homography.flatten().tolist(),
        page_corners=corr.page_corners.astype(float).round(1).tolist(),
    )
    if template is None:
        # 无法识别版式：不产生任何字段猜测，整页待人工处理
        page.fields = {}
        return page

    # 3) 按模板区域逐字段提取（区域绑定，不按 OCR 文本顺序）
    page.fields = extract_page(corr.canvas, corr, template)
    return page


def reprocess(page: PageResult, *, skip_orientation: bool = False
              ) -> tuple[PageResult, list[Revision]]:
    """重新识别同一张图，保留人工确认值，返回 (新页结果, 修订记录)。"""
    fresh = process_image(page.source_path, skip_orientation=skip_orientation)
    fresh.page_id = page.page_id
    fresh.created_at = page.created_at
    fresh.reprocessed_count = page.reprocessed_count + 1
    revisions: list[Revision] = []

    for key, old in page.fields.items():
        new = fresh.fields.get(key)
        if new is None:
            fresh.fields[key] = old
            continue
        if old.manual:
            # 保留人工值/状态，只刷新坐标与变换信息
            preserved = FieldResult(**old.to_dict())
            preserved.source_polygon = new.source_polygon
            preserved.region_norm = new.region_norm
            fresh.fields[key] = preserved
            revisions.append(Revision.create(
                page_id=page.page_id, field_key=key,
                old_value=new.value, new_value=old.value,
                old_status=new.status, new_status=STATUS_CONFIRMED,
                note="重识别：保留人工确认值，仅刷新来源坐标",
            ))
        elif old.status == STATUS_CONFIRMED and not old.manual:
            fresh.fields[key].status = STATUS_CONFIRMED
    return fresh, revisions


def page_overall_status(page: PageResult) -> str:
    if page.template_id is None:
        return STATUS_NEEDS_REVIEW
    if any(f.status == STATUS_NEEDS_REVIEW for f in page.fields.values()):
        return STATUS_NEEDS_REVIEW
    if any(f.manual for f in page.fields.values()):
        return STATUS_CONFIRMED
    return STATUS_AUTO
