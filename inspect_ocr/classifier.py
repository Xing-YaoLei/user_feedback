"""版式识别：在整页 OCR 文本上用各模板锚点匹配，返回最相似模板。"""

from __future__ import annotations

from difflib import SequenceMatcher

import numpy as np

from . import config
from .ocr import image_text
from .templates import TEMPLATES, TemplateSpec


def full_page_text(canvas: np.ndarray) -> str:
    """对校正后的画布做整页 OCR，仅用于版式识别，不用于字段填充。"""
    return image_text(canvas, lang=config.TESS_LANG_CN, psm="--psm 6",
                      upscale=1.5)


def title_band_text(canvas: np.ndarray) -> str:
    """识别画布顶部标题带，标题是最可靠的版式锚点。"""
    band = canvas[int(0.045 * config.CANVAS_H):int(0.125 * config.CANVAS_H), :]
    return image_text(band, lang=config.TESS_LANG_CN, psm="--psm 7",
                      upscale=2.0)


def _anchor_score(text: str, anchor: str) -> float:
    """锚点命中分：子串包含优先，否则用最长相似块比例。"""
    compact = "".join(text.split())
    key = "".join(anchor.split())
    if key in compact:
        return 1.0
    # 滑动窗口取最高相似度，避免长文本拉低 SequenceMatcher 比例
    best = 0.0
    step = max(1, len(key) // 2)
    for i in range(0, max(1, len(compact) - len(key) + 1), step):
        window = compact[i:i + len(key) + 2]
        if not window:
            continue
        best = max(best, SequenceMatcher(None, key, window).ratio())
    return best


def classify(canvas: np.ndarray) -> tuple[TemplateSpec | None, float, str]:
    """返回 (最佳模板, 置信分, 整页 OCR 文本)；无模板达标时模板为 None。

    综合整页文本与顶部标题带两路 OCR 取最高锚点分，提升噪声下的稳健性。
    """
    text = full_page_text(canvas)
    title = title_band_text(canvas)
    combined = text + " " + title
    best_tpl: TemplateSpec | None = None
    best_score = 0.0
    for tpl in TEMPLATES.values():
        score = max(_anchor_score(combined, a) for a in tpl.anchors)
        if score > best_score:
            best_score = score
            best_tpl = tpl
    if best_tpl is not None and best_score >= best_tpl.anchor_min_ratio:
        return best_tpl, round(best_score, 3), combined
    return None, round(best_score, 3), combined
