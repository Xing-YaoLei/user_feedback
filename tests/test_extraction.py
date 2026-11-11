"""字段提取与规则校验测试：区域定位、识别正确性、空白不填零、单位/格式冲突。"""

from __future__ import annotations

import random

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from inspect_ocr import extractor, generate, preprocess
from inspect_ocr.models import (
    STATUS_BLANK,
    STATUS_NEEDS_REVIEW,
)
from inspect_ocr.templates import TEMPLATE_A, TEMPLATE_B

_FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf"


def _draw_text_in_region(canvas, region_px, text, size=34):
    """用真实 TTF 字体在字段区域内居中绘制文字（比 Hershey 更易 OCR）。"""
    x0, y0, x1, y1 = region_px
    cv2.rectangle(canvas, (x0 + 3, y0 + 3), (x1 - 3, y1 - 3),
                  (255, 255, 255), -1)
    pil = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil)
    font = ImageFont.truetype(_FONT_PATH, size)
    bbox = draw.textbbox((0, 0), text, font=font)
    th = bbox[3] - bbox[1]
    # 水平靠左留足边距、垂直居中，避免紧裁剪切到字形
    tx = x0 + 16
    ty = y0 + max(4, ((y1 - y0) - th) // 2)
    draw.text((tx, ty), text, fill=(0, 0, 0), font=font)
    canvas[:] = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _run_pipeline(tpl_id: str, seed: int):
    rng = random.Random(seed)
    img, truth = (generate.render_template_a(rng) if tpl_id == "A"
                  else generate.render_template_b(rng))
    bgr = generate._to_cv(img)
    corr = preprocess.correct_image(bgr, skip_orientation=True)
    tpl = TEMPLATE_A if tpl_id == "A" else TEMPLATE_B
    fields = extractor.extract_page(corr.canvas, corr, tpl)
    return fields, truth, corr


# ---------------------------------------------------------------------------
# 干净样本：字段定位 + 识别结果 vs 真值
# ---------------------------------------------------------------------------

def test_clean_template_a_field_values():
    fields, truth, _ = _run_pipeline("A", 11)
    assert fields["device_id"].value == truth["device_id"]
    assert fields["inspect_date"].value == truth["inspect_date"]
    assert fields["meter_reading"].value == pytest_approx(truth["meter_reading"])
    assert fields["voltage"].value == pytest_approx(truth["voltage"])
    assert fields["current"].value == pytest_approx(truth["current"])
    assert fields["status"].value == truth["status"]


def test_clean_template_b_field_values():
    fields, truth, _ = _run_pipeline("B", 12)
    assert fields["device_id"].value == truth["device_id"]
    assert fields["inspect_date"].value == truth["inspect_date"]
    assert fields["oil_pressure"].value == pytest_approx(truth["oil_pressure"])
    assert fields["temperature"].value == pytest_approx(truth["temperature"])
    assert fields["run_hours"].value == pytest_approx(truth["run_hours"])
    assert sorted(fields["check_items"].value) == truth["check_items"]


def pytest_approx(v):
    import pytest
    return pytest.approx(v, abs=0.11)


def test_every_field_carries_source_polygon():
    fields, _, _ = _run_pipeline("A", 13)
    for key, f in fields.items():
        assert len(f.source_polygon) == 4, f"{key} 必须带来源坐标"
        assert all(len(p) == 2 for p in f.source_polygon)


def test_checkbox_detection_is_geometric_not_text_order():
    fields, truth, _ = _run_pipeline("B", 14)
    # 勾选组值是选项名称列表，与 OCR 文本顺序无关
    assert isinstance(fields["check_items"].value, list)
    assert set(fields["check_items"].value).issubset(
        {n for n, _ in TEMPLATE_B.field_map()["check_items"].options})


# ---------------------------------------------------------------------------
# 规则校验
# ---------------------------------------------------------------------------

def test_blank_field_is_none_never_zero(tmp_path):
    """合成空白字段：value 必须为 None 且状态 blank，绝不允许 0。"""
    rng = random.Random(21)
    img, _ = generate.render_template_a(rng)
    bgr = generate._to_cv(img)
    blanks = generate.blank_out_fields(bgr, TEMPLATE_A, random.Random(22))
    assert blanks
    corr = preprocess.correct_image(bgr, skip_orientation=True)
    fields = extractor.extract_page(corr.canvas, corr, TEMPLATE_A)
    for key in blanks:
        f = fields[key]
        assert f.value is None, f"空白字段 {key} 不得填任何值（含 0）"
        # 判空白或转人工均可，关键是 None 且绝不自动产出数值
        assert f.status in (STATUS_BLANK, STATUS_NEEDS_REVIEW)
        assert f.review_reasons


def test_id_format_error_goes_to_review():
    rng = random.Random(31)
    img, _ = generate.render_template_a(rng)
    bgr = generate._to_cv(img)
    corr = preprocess.correct_image(bgr, skip_orientation=True)
    spec = TEMPLATE_A.field_map()["device_id"]
    bad = corr.canvas.copy()
    region = preprocess.norm_region_to_canvas(spec.region)
    _draw_text_in_region(bad, region, "EQX-12")
    corr2 = preprocess.Correction(
        corr.rotate_angle, corr.page_corners, corr.homography,
        bad, corr.rotated, corr.rot_matrix)
    f = extractor.extract_field(corr2.canvas, corr2, spec)
    assert f.status == STATUS_NEEDS_REVIEW
    assert "id_format_error" in f.review_reasons


def test_unit_conflict_goes_to_review():
    rng = random.Random(32)
    img, _ = generate.render_template_a(rng)
    bgr = generate._to_cv(img)
    corr = preprocess.correct_image(bgr, skip_orientation=True)
    spec = TEMPLATE_A.field_map()["voltage"]  # 规定单位 V
    bad = corr.canvas.copy()
    region = preprocess.norm_region_to_canvas(spec.region)
    _draw_text_in_region(bad, region, "220.5 MPa")
    corr2 = preprocess.Correction(
        corr.rotate_angle, corr.page_corners, corr.homography,
        bad, corr.rotated, corr.rot_matrix)
    f = extractor.extract_field(corr2.canvas, corr2, spec)
    assert f.value == 220.5  # 数值仍提取
    assert f.status == STATUS_NEEDS_REVIEW
    assert "unit_conflict" in f.review_reasons


def test_low_confidence_flagged_when_ocr_weak():
    # 全噪声区域：OCR 要么无结果，要么低置信度，两者都必须进人工
    rng = np.random.RandomState(33)
    noise = rng.randint(0, 256, (120, 300, 3)).astype(np.uint8)
    canvas = np.full((1754, 1240, 3), 255, np.uint8)
    canvas[400:520, 200:500] = noise
    corr = preprocess.Correction(
        0.0,
        np.array([[0, 0], [1239, 0], [1239, 1753], [0, 1753]], np.float32),
        np.eye(3), canvas, canvas, np.eye(2, 3))
    spec = TEMPLATE_A.field_map()["inspector"]
    f = extractor.extract_field(canvas, corr, spec)
    # 噪声区不得自动产出可信值：进人工或判空白均可，关键是不能 status=auto
    assert f.status in (STATUS_NEEDS_REVIEW, STATUS_BLANK)
    assert f.value is None or f.status == STATUS_NEEDS_REVIEW
    assert f.review_reasons or f.status == STATUS_BLANK


def test_number_zero_is_preserved_when_actually_read(tmp_path):
    """真实读数为 0 时保留 0；区别于空白 None。"""
    rng = random.Random(34)
    img, _ = generate.render_template_a(rng)
    bgr = generate._to_cv(img)
    corr = preprocess.correct_image(bgr, skip_orientation=True)
    spec = TEMPLATE_A.field_map()["voltage"]
    edited = corr.canvas.copy()
    region = preprocess.norm_region_to_canvas(spec.region)
    _draw_text_in_region(edited, region, "0.0 V")
    corr2 = preprocess.Correction(
        corr.rotate_angle, corr.page_corners, corr.homography,
        edited, corr.rotated, corr.rot_matrix)
    f = extractor.extract_field(corr2.canvas, corr2, spec)
    assert f.value == 0.0
    assert f.status != STATUS_BLANK
