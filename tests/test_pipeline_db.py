"""端到端测试：批量采集、持久化、人工修订、重识别保留人工值与历史、导出。"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from inspect_ocr import database, exporter
from inspect_ocr.cli import cmd_collect
from inspect_ocr.models import STATUS_CONFIRMED
from inspect_ocr.pipeline import process_image, reprocess


def _first_page_id() -> str:
    # 选择一个成功识别版式、含字段的页面（跳过转人工的空页）
    pages = [p for p in database.list_pages() if p["template_id"] in ("A", "B")]
    assert pages, "至少应有一页成功识别版式"
    return pages[0]["page_id"]


def test_batch_collect_persists_pages(samples_dir, tmp_workspace):
    out, metas = samples_dir
    rc = cmd_collect(argparse_ns(out, tmp_workspace))
    assert rc == 0
    pages = database.list_pages()
    assert len(pages) == len(metas)
    # 绝大多数页面识别出版式；个别退化严重的页面允许转人工（template_id 为空）
    recognized = [p for p in pages if p["template_id"] in ("A", "B")]
    assert len(recognized) >= 0.8 * len(metas)
    # 未识别版式的页面不得编造字段
    for p in pages:
        if p["template_id"] not in ("A", "B"):
            assert p["n_fields"] == 0


def argparse_ns(img_dir, out_dir):
    import argparse
    return argparse.Namespace(path=str(img_dir), out=str(out_dir / "exports"))


def test_degraded_samples_localization_still_works(samples_dir, tmp_workspace):
    """含倾斜/透视/噪声/缺页角的样本：编号与日期仍按区域正确提取。"""
    out, metas = samples_dir
    cmd_collect(argparse_ns(out, tmp_workspace))
    ok = 0
    evaluated = 0
    for summary in database.list_pages():
        page = database.load_page(summary["page_id"])
        if "device_id" not in page.fields:
            continue  # 版式未识别的转人工页不参与定位准确率统计
        evaluated += 1
        meta = next(m for m in metas
                    if m["file"] == Path(page.source_path).name)
        truth = meta["ground_truth"]
        if (page.fields["device_id"].value == truth["device_id"]
                and page.fields["inspect_date"].value == truth["inspect_date"]):
            ok += 1
    assert evaluated >= 0.8 * len(metas)
    # 已识别版式的页面中，80% 以上编号/日期必须正确（区域定位正确的体现）
    assert ok / evaluated >= 0.8


def test_manual_update_writes_revision_and_status(samples_dir, tmp_workspace):
    out, _ = samples_dir
    cmd_collect(argparse_ns(out, tmp_workspace))
    pid = _first_page_id()
    page = database.load_page(pid)
    key = "device_id"
    old = page.fields[key].value
    rev = database.update_field(pid, key, "EQ-999999", note="测试人工修改")
    assert rev is not None
    again = database.load_page(pid)
    assert again.fields[key].value == "EQ-999999"
    assert again.fields[key].manual is True
    assert again.fields[key].status == STATUS_CONFIRMED
    history = database.list_revisions(pid)
    assert any(h["field_key"] == key and h["old_value"] == old for h in history)


def test_reprocess_preserves_manual_values(samples_dir, tmp_workspace):
    out, _ = samples_dir
    cmd_collect(argparse_ns(out, tmp_workspace))
    pid = _first_page_id()
    database.update_field(pid, "device_id", "EQ-111111", note="锁定人工值")
    page = database.load_page(pid)
    fresh, revs = reprocess(page)
    database.save_page(fresh)
    for r in revs:
        database.add_revision(r)
    reloaded = database.load_page(pid)
    assert reloaded.fields["device_id"].value == "EQ-111111"
    assert reloaded.fields["device_id"].manual is True
    assert reloaded.reprocessed_count == 1
    # 坐标随重识别刷新，但值不动
    assert reloaded.fields["device_id"].source_polygon
    # 修订历史包含重识别保留说明
    assert any("保留人工确认值" in r.note for r in revs)


def test_confirm_field_without_value_change(samples_dir, tmp_workspace):
    out, _ = samples_dir
    cmd_collect(argparse_ns(out, tmp_workspace))
    pid = _first_page_id()
    key = next(iter(database.load_page(pid).fields))
    database.confirm_field(pid, key)
    assert database.load_page(pid).fields[key].status == STATUS_CONFIRMED


def test_csv_export_keeps_blank_empty_not_zero(samples_dir, tmp_workspace):
    out, metas = samples_dir
    cmd_collect(argparse_ns(out, tmp_workspace))
    csv_path = exporter.export_batch_csv(tmp_workspace / "exports" / "b.csv")
    rows = list(csv.reader(csv_path.open(encoding="utf-8-sig")))
    header, body = rows[0], rows[1:]
    # 核心约束：数据库中 None 的字段导出必须是空字符串，绝不自动写 0
    # （"不把未识别字段自动填成零"）
    for summary in database.list_pages():
        page = database.load_page(summary["page_id"])
        row = next(r for r in body if r[0] == page.page_id)
        for i, key in enumerate(header):
            if key in page.fields and page.fields[key].value is None:
                assert row[i] == "", (
                    f"None 字段 {key} 导出必须为空，实际: {row[i]!r}")
    # 含空白字段的样本至少存在，且其空白列不会凭空出现 "0"
    blanked = [m for m in metas if m["blanked_fields"]]
    assert blanked
    for m in blanked:
        row = next(r for r in body if Path(r[2]).name == m["file"])
        for key in m["blanked_fields"]:
            idx = header.index(key)
            assert row[idx] != "0", f"空白字段 {key} 不得被自动填 0"


def test_json_export_contains_coords_and_revisions(samples_dir, tmp_workspace):
    out, _ = samples_dir
    cmd_collect(argparse_ns(out, tmp_workspace))
    pid = _first_page_id()
    database.update_field(pid, "remark", "人工备注", note="导出测试")
    page = database.load_page(pid)
    jp = exporter.export_json(page, tmp_workspace / "exports" / "one.json")
    data = json.loads(jp.read_text("utf-8"))
    assert data["page_id"] == pid
    sample_field = next(iter(data["fields"].values()))
    assert "source_polygon" in sample_field and len(sample_field["source_polygon"]) == 4
    assert any(r["note"] == "导出测试" for r in data["revisions"])


def test_unknown_template_page_has_no_guessed_fields(tmp_workspace):
    import cv2
    import numpy as np
    blank = np.full((1754, 1240, 3), 255, np.uint8)
    p = tmp_workspace / "blank.png"
    cv2.imencode(".png", blank)[1].tofile(str(p))
    page = process_image(str(p))
    assert page.template_id is None
    assert page.fields == {}  # 识别不出版式时绝不编造字段
