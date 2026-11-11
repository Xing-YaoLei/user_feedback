"""结构化导出：JSON（含坐标与置信度）与扁平 CSV（空白保持空值）。"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from .database import list_pages, load_page, list_revisions
from .models import PageResult


def page_to_record(page: PageResult, include_meta: bool = True) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "page_id": page.page_id,
        "source_path": page.source_path,
        "template_id": page.template_id,
        "template_name": page.template_name,
        "fields": {},
    }
    for key, f in page.fields.items():
        # 空白字段输出 null，绝不输出 0
        entry = {
            "value": f.value,
            "status": f.status,
            "confidence": f.confidence,
            "manual": f.manual,
            "review_reasons": f.review_reasons,
        }
        if include_meta:
            entry.update({
                "label": f.label,
                "ftype": f.ftype,
                "raw_text": f.raw_text,
                "unit": f.unit,
                "detected_unit": f.detected_unit,
                "region_norm": list(f.region_norm),
                "source_polygon": f.source_polygon,
                "updated_at": f.updated_at,
            })
        rec["fields"][key] = entry
    if include_meta:
        rec["correction"] = {
            "rotate_angle": page.rotate_angle,
            "homography": page.homography,
            "page_corners": page.page_corners,
            "reprocessed_count": page.reprocessed_count,
        }
    return rec


def export_json(page: PageResult, out_path: str | Path,
                with_revisions: bool = True) -> Path:
    out_path = Path(out_path)
    rec = page_to_record(page)
    if with_revisions:
        rec["revisions"] = list_revisions(page.page_id)
    out_path.write_text(
        json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    return out_path


def export_batch_json(out_path: str | Path) -> Path:
    out_path = Path(out_path)
    records = []
    for summary in list_pages():
        page = load_page(summary["page_id"])
        if page:
            records.append(page_to_record(page))
    out_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    return out_path


def export_batch_csv(out_path: str | Path) -> Path:
    """每个字段一列；空白为 None -> 空字符串，数值 0 仅在真实识别为 0 时出现。"""
    out_path = Path(out_path)
    pages = [load_page(s["page_id"]) for s in list_pages()]
    pages = [p for p in pages if p is not None]
    # 汇总所有字段键，保持稳定顺序
    field_keys: list[str] = []
    for p in pages:
        for k in p.fields:
            if k not in field_keys:
                field_keys.append(k)
    with out_path.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(["page_id", "template_id", "source_path", *field_keys])
        for p in pages:
            row = [p.page_id, p.template_id, p.source_path]
            for k in field_keys:
                f = p.fields.get(k)
                if f is None or f.value is None:
                    row.append("")  # 空白保持空，不写 0
                elif isinstance(f.value, list):
                    row.append("|".join(f.value))
                else:
                    row.append(f.value)
            writer.writerow(row)
    return out_path
