"""样本生成器测试：退化效果与真值文件完整性。"""

from __future__ import annotations

import json

import numpy as np

from inspect_ocr import generate


def test_dataset_contains_both_templates(samples_dir):
    out, metas = samples_dir
    tpls = {m["ground_truth"]["template_id"] for m in metas}
    assert tpls == {"A", "B"}


def test_each_sample_has_image_and_truth(samples_dir):
    out, metas = samples_dir
    for m in metas:
        img_path = out / m["file"]
        assert img_path.exists()
        meta = json.loads((out / m["file"].replace(".png", ".json")).read_text("utf-8"))
        assert meta["ground_truth"]["device_id"]
        assert "blanked_fields" in meta


def test_degradations_are_applied(samples_dir):
    out, metas = samples_dir
    # 至少部分样本带 90 度方向旋转 / 缺页角 / 空白注入
    assert any(m["orientation_90"] != 0 for m in metas)
    assert any(m["blanked_fields"] for m in metas)
    assert any(abs(m["rotation_deg"]) > 1.0 for m in metas)


def test_torn_corner_is_white_region(tmp_path):
    import random
    img = np.zeros((200, 160, 3), dtype=np.uint8)
    torn = generate.apply_torn_corner(img, random.Random(1), corner=0)
    # 左上角被白色覆盖
    assert torn[2, 2].tolist() == [255, 255, 255]
    # 画面中心仍为原色
    assert torn[100, 80].tolist() == [0, 0, 0]


def test_blank_out_fields_marks_region_white():
    import random
    rng = random.Random(3)
    img, _ = generate.render_template_a(rng)
    bgr = generate._to_cv(img)
    from inspect_ocr.templates import TEMPLATE_A
    blanks = generate.blank_out_fields(bgr, TEMPLATE_A, rng)
    assert blanks, "应至少置空一个字段"
    for key in blanks:
        spec = TEMPLATE_A.field_map()[key]
        x0, y0, x1, y1 = generate._region_px(spec.region)
        # 裁掉单元格边框，只检查内部填写区被涂白
        roi = bgr[y0 + 12:y1 - 12, x0 + 12:x1 - 12]
        assert roi.mean() > 245, f"字段 {key} 区域应被涂白"
