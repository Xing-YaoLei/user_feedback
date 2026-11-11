"""预处理测试：方向检测、透视校正、坐标反算、版式识别。"""

from __future__ import annotations

import random

import numpy as np

from inspect_ocr import classifier, generate, preprocess
from inspect_ocr.config import CANVAS_H, CANVAS_W
from inspect_ocr.templates import TEMPLATE_A, TEMPLATE_B


def _clean_sheet(tpl_id: str):
    rng = random.Random(7)
    img, truth = (generate.render_template_a(rng) if tpl_id == "A"
                  else generate.render_template_b(rng))
    return generate._to_cv(img), truth


def test_orientation_detection_90_and_270():
    # OSD 角度约定可能与 numpy.rot90 相反，验证最终旋转后页面恢复正向
    # （宽高回到竖版比例）即可，而非依赖具体角度数值
    bgr, _ = _clean_sheet("A")
    h0, w0 = bgr.shape[:2]
    for k in (0, 1, 3):
        rotated = np.ascontiguousarray(np.rot90(bgr, k)) if k else bgr
        angle = preprocess.detect_orientation(rotated)
        upright, _ = preprocess.rotate_upright(rotated, angle)
        uh, uw = upright.shape[:2]
        assert uh > uw, f"k={k} 校正后应为竖版，实际 {uw}x{uh}"
        # 尺寸应与原图一致（仅方向不同）
        assert sorted((uh, uw)) == sorted((h0, w0))


def test_correction_returns_canvas_size():
    bgr, _ = _clean_sheet("B")
    degraded = generate.apply_perspective(
        generate.apply_rotation(bgr, random.Random(2))[0],
        random.Random(2))
    corr = preprocess.correct_image(degraded, skip_orientation=True)
    assert corr.canvas.shape[:2] == (CANVAS_H, CANVAS_W)
    assert corr.homography.shape == (3, 3)
    assert corr.page_corners.shape == (4, 2)


def test_coordinate_roundtrip():
    """画布点 -> 原图 -> 画布，误差应在 2 像素内。"""
    bgr, _ = _clean_sheet("A")
    degraded = generate.apply_perspective(bgr, random.Random(5))
    corr = preprocess.correct_image(degraded, skip_orientation=True)
    test_pts = np.array([[200.0, 300.0], [900.0, 1200.0], [500.0, 700.0]])
    for p in test_pts:
        orig = preprocess.canvas_point_to_original(corr, p)
        q = corr.homography @ np.array([orig[0], orig[1], 1.0])
        back = q[:2] / q[2]
        assert np.linalg.norm(back - p) < 2.0


def test_source_polygon_lies_inside_original_image():
    bgr, _ = _clean_sheet("B")
    degraded = generate.apply_perspective(bgr, random.Random(9))
    corr = preprocess.correct_image(degraded, skip_orientation=True)
    h, w = degraded.shape[:2]
    poly = preprocess.norm_region_to_source_polygon(
        corr, TEMPLATE_B.field_map()["device_id"].region)
    assert len(poly) == 4
    for x, y in poly:
        assert -5 <= x <= w + 5 and -5 <= y <= h + 5


def test_classify_identifies_both_templates():
    for tpl_id, spec in (("A", TEMPLATE_A), ("B", TEMPLATE_B)):
        bgr, _ = _clean_sheet(tpl_id)
        corr = preprocess.correct_image(bgr, skip_orientation=True)
        tpl, score, _ = classifier.classify(corr.canvas)
        assert tpl is not None, "干净样本必须识别出版式"
        assert tpl.template_id == tpl_id
        assert score >= spec.anchor_min_ratio


def test_classify_unknown_page_returns_none():
    blank = np.full((CANVAS_H, CANVAS_W, 3), 255, np.uint8)
    tpl, score, _ = classifier.classify(blank)
    assert tpl is None
