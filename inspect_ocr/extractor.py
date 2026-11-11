"""区域级字段提取与规则校验。

关键约束
--------
* 每个字段只在模板规定的区域内 OCR / 几何检测，区域之间互不串值；
* 空白区域 -> status=blank、value=None，绝不自动写 0；
* 低置信度、编号格式错误、数值单位冲突 -> needs_review；
* 勾选项用填充比例几何判定，不依赖 OCR 识别勾号字符。
"""

from __future__ import annotations

import re

import cv2
import numpy as np

from . import config
from .models import (
    FieldResult,
    STATUS_BLANK,
    STATUS_NEEDS_REVIEW,
)
from .ocr import build_cn_candidates, image_words, image_words_vote
from .preprocess import Correction, norm_region_to_canvas, norm_region_to_source_polygon
from .templates import FieldSpec

# 数值前缀提取：整数或小数，允许千分位
_NUM_RE = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")


def _crop(canvas: np.ndarray, region) -> np.ndarray:
    x0, y0, x1, y1 = norm_region_to_canvas(region)
    x0, y0 = max(0, x0), max(0, y0)
    x1 = min(canvas.shape[1], x1)
    y1 = min(canvas.shape[0], y1)
    return canvas[max(0, y0):y1, max(0, x0):x1]


def _field_components(gray: np.ndarray) -> tuple[float, float]:
    """返回 (有效墨迹占比, 最大内部连通域占比)，已剔除单元格边框与椒盐。

    单元格边框是一个铺满区域、贴边的超大连通域，会污染墨迹统计，因此先
    按"贴边且面积占比极高"特征识别并排除，再统计内部笔画/噪声。
    真实笔画形成面积显著的内部连通体；空白区内部只剩孤立小斑点。
    """
    if len(gray.shape) == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    med = cv2.medianBlur(gray, 3)
    inv = cv2.threshold(med, 0, 255,
                        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    n_labels, _lab, stats, _ = cv2.connectedComponentsWithStats(inv, 8)
    if n_labels <= 1:
        return 0.0, 0.0
    inner_areas = []
    frame_area = 0.45 * h * w  # 边框连通域通常占整框面积一半以上
    for i in range(1, n_labels):
        x, y, cw, ch, area = stats[i]
        touches_border = x <= 2 or y <= 2 or x + cw >= w - 2 or y + ch >= h - 2
        if touches_border and area >= frame_area:
            continue  # 单元格边框，剔除
        inner_areas.append(int(area))
    if not inner_areas:
        return 0.0, 0.0
    arr = np.array(inner_areas)
    valid = arr[arr >= 15]  # 剔除椒盐小点
    total = inv.size
    ink = float(valid.sum()) / total
    biggest = float(arr.max()) / total
    return ink, biggest


def _clean_text(raw: str) -> str:
    return re.sub(r"\s+", "", raw).replace("|", "").replace("`", "")


def _extract_pattern(text: str, pattern: str) -> str | None:
    """从含噪 OCR 文本中抽取与字段正则匹配的子串；抽不到返回 None。

    用非贪婪通配把锚定模式转为可搜索模式，兼容 }、Oo 等首尾误识字符。
    """
    search_pattern = ".*?(" + pattern.strip("^$") + ").*?"
    m = re.fullmatch(search_pattern, text)
    return m.group(1) if m else None


def _recover_decimal(gray: np.ndarray, raw_text: str) -> str:
    """几何恢复小数点：检测数字行底部的孤立小点，插入到相邻数字之间。

    Tesseract 在噪声/小字号下常漏掉小数点（7.7 -> 77、19848.2 -> 198482）。
    先剔除单元格边框连通域，再把"位于字形下半部、尺寸远小于数字"的孤立
    组件判为小数点，按其横向位置插入到对应数字之间。
    仅当 OCR 文本本身不含小数点时才尝试，避免重复插入。
    """
    digits = re.sub(r"\D", "", raw_text)
    if "." in raw_text or len(digits) < 2:
        return raw_text
    h, w = gray.shape
    med = cv2.medianBlur(gray, 3)
    inv = cv2.threshold(med, 0, 255,
                        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    n, _lab, stats, cent = cv2.connectedComponentsWithStats(inv, 8)
    digit_comps, dot_comps = [], []
    for i in range(1, n):
        x, y, cw, ch, area = stats[i]
        cx, cy = cent[i]
        # 剔除单元格边框：贴边且面积占比极高，或宽度/高度铺满整个区域
        is_frame = (
            ((x <= 2 or y <= 2 or x + cw >= w - 2 or y + ch >= h - 2)
             and area >= 0.45 * h * w)
            or cw >= 0.92 * w or ch >= 0.92 * h)
        if is_frame:
            continue
        # 小数点：小尺寸、宽高接近，位于字形中下部（阈值放宽到 0.40h）
        is_dot = (
            area <= 0.012 * h * w
            and cw <= 0.05 * w and ch <= 0.22 * h
            and cy >= h * 0.30
            and abs(cw - ch) <= max(cw, ch) * 0.8
        )
        if is_dot:
            dot_comps.append((float(cx), float(cy), int(area)))
        elif (ch >= h * 0.18 and cw >= w * 0.015
              and x > 2 and x + cw < w - 2):  # 数字主体：内部、宽度合理
            digit_comps.append((float(cx), int(x), int(cw)))
    if not dot_comps or len(digit_comps) < 2:
        return raw_text
    digit_comps.sort()
    digit_xs = [d[0] for d in digit_comps]
    x_lo, x_hi = min(digit_xs), max(digit_xs)
    # 小数点必须落在数字主体的横向跨度内（排除右侧单位字母上的点）
    candidates = [d for d in dot_comps if x_lo <= d[0] <= x_hi]
    if not candidates:
        return raw_text
    # 小数点通常是候选中位置最靠下（基线附近）的点；取 y 最大者，
    # 同 y 取面积较大的，避免选到数字上部的噪点/笔画残块
    dx, _dy, _area = max(candidates, key=lambda t: (t[1], t[2]))
    insert_idx = 0
    for idx, (dcx, _x, _cw) in enumerate(digit_comps):
        if dcx < dx:
            insert_idx = idx + 1
    if 0 < insert_idx < len(digits):
        digits = digits[:insert_idx] + "." + digits[insert_idx:]
    unit_part = re.sub(r"[\d\.,]", " ", raw_text).strip()
    return (digits + " " + unit_part).strip()


def _recover_space_decimal(raw: str) -> str:
    """恢复被 OCR 识别成空格的小数点。

    高频误识模式："19848 2 kWh" 实为 "19848.2 kWh"、"7 7 MPa" 实为
    "7.7 MPa"。当数字 token 之间以单空格分隔、且后段为 1~2 位短数字、
    再后面跟单位字母时，把该空格还原为小数点。
    """
    # 数字 空格 1~2位数字 空格 字母单位
    m = re.search(r"(\d+)\s+(\d{1,2})\s*([A-Za-z°℃%])", raw)
    if m and "." not in raw:
        return raw[:m.start()] + f"{m.group(1)}.{m.group(2)} " + raw[m.start(3):]
    # 数字 空格 单数字（无单位，纯数字区域）
    m2 = re.fullmatch(r"\s*(\d+)\s+(\d{1,2})\s*", raw)
    if m2 and "." not in raw:
        return f"{m2.group(1)}.{m2.group(2)}"
    return raw


def _split_number_unit(raw: str, spec: FieldSpec) -> tuple[float | None, str | None]:
    """从 OCR 文本中提取数值，并检测书写单位。"""
    raw = _recover_space_decimal(raw)
    compact = _clean_text(raw).replace("，", ",")
    m = _NUM_RE.search(compact)
    if not m:
        return None, None
    num_text = m.group(0).replace(",", "")
    value = float(num_text)
    tail = compact[m.end():] + compact[:m.start()]
    detected_unit = None
    for u in spec.allowed_units:
        if u and u in tail:
            detected_unit = u
            break
    # 未在白名单内、但尾部带字母/单位符号 -> 记录原始单位用于冲突判定
    if detected_unit is None:
        u_match = re.search(r"[A-Za-z°℃%]+", tail)
        if u_match:
            detected_unit = u_match.group(0)
    return value, detected_unit


def _checkbox_fill(bgr: np.ndarray, box_region) -> float:
    """单个勾选框内深色像素占比（几何判定，不 OCR）。"""
    crop = _crop(bgr, box_region)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # 去掉外框线：裁掉边缘 15%
    h, w = gray.shape
    pad_x, pad_y = int(w * 0.18), int(h * 0.18)
    inner = gray[pad_y:h - pad_y, pad_x:w - pad_x]
    if inner.size == 0:
        inner = gray
    thr = cv2.threshold(inner, 0, 255,
                        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    return float(np.count_nonzero(thr)) / thr.size


def _base_result(spec: FieldSpec, corr: Correction) -> FieldResult:
    return FieldResult(
        key=spec.key, label=spec.label, ftype=spec.ftype,
        region_norm=spec.region,
        source_polygon=norm_region_to_source_polygon(corr, spec.region),
        unit=spec.unit,
    )


def extract_field(canvas: np.ndarray, corr: Correction,
                  spec: FieldSpec) -> FieldResult:
    result = _base_result(spec, corr)

    # ---- 勾选组：几何检测 ----
    if spec.ftype == "checkbox_group":
        names = [n for n, _ in spec.options]
        ratios = [_checkbox_fill(canvas, box) for _, box in spec.options]
        result.confidence = round(100.0 * max(ratios), 1) if ratios else 0.0
        if not ratios or max(ratios) < 0.03:
            # 所有小框都几乎无墨迹 -> 源图空白
            result.value = []
            result.status = STATUS_BLANK
            result.review_reasons.append("blank_field")
            return result
        order = sorted(range(len(ratios)), key=lambda i: ratios[i], reverse=True)
        top, second = ratios[order[0]], (ratios[order[1]]
                                         if len(ratios) > 1 else 0.0)
        checked = []
        for i, ratio in enumerate(ratios):
            # 绝对占比达标，且明显高于未勾选框（相对判据），二者其一兜底
            if ratio >= config.CHECKBOX_FILL_RATIO and (
                    ratio >= top / config.CHECKBOX_REL_RATIO
                    or (second < 0.03 and i == order[0])):
                checked.append(names[i])
        result.value = checked
        return result

    crop = _crop(canvas, spec.region)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    ink, biggest = _field_components(gray)

    # 数值/编号/日期走 eng，中文文本走 chi_sim（组合语言会产生拉丁乱码）
    # 数值类关闭形态学开运算以保留小数点
    is_numeric = spec.ftype in ("device_id", "date", "number")
    lang = config.TESS_LANG_NUM if is_numeric else config.TESS_LANG_CN
    # 中文短文本字段多为左对齐+大片留白：多预处理/PSM 假设投票
    if spec.ftype == "text":
        raw, conf, _votes, _total = image_words_vote(
            gray, config.TESS_LANG_CN, build_cn_candidates(gray))
    else:
        # 数值/编号/日期不做紧裁（易切掉数字），数值用稀疏文本 PSM 抗留白
        psm = "--psm 11" if spec.ftype == "number" else spec.psm
        raw, conf = image_words(crop, lang=lang, psm=psm,
                                remove_speckles=not is_numeric)
    if spec.ftype == "number":
        # 数字白名单 OCR 仅在全字符结果缺失小数点时作为补充，避免其丢点
        # 后覆盖全字符结果中本已正确的小数点（如 44.6 被改写成 446）
        if "." not in raw:
            digit_text, digit_conf = image_words(
                crop, lang=lang,
                psm=f"{spec.psm} -c tessedit_char_whitelist=0123456789.,-",
                remove_speckles=False)
            if digit_text:
                unit_part = re.sub(r"[\d\.,\-]", " ", raw).strip()
                raw = (digit_text + " " + unit_part).strip()
                conf = max(conf, digit_conf)
    result.raw_text = raw
    result.confidence = round(conf, 1)

    # ---- 空白判定：几何与 OCR 双路交叉，二者皆空才定空白，禁止填 0 ----
    # 几何阈值：噪声区最大连通域占比普遍 < 0.013；OCR 无有效文本
    geometrically_empty = biggest < 0.013 and ink < 0.02
    ocr_empty = not _clean_text(raw)
    if geometrically_empty and ocr_empty:
        result.status = STATUS_BLANK
        result.review_reasons.append("blank_field")
        if not spec.allow_blank:
            result.status = STATUS_NEEDS_REVIEW
        return result
    # 几何看似空白但 OCR 读到内容：以 OCR 为准继续走校验（短中文场景）
    if ocr_empty:
        result.status = STATUS_NEEDS_REVIEW
        result.review_reasons.append(
            "blank_field" if geometrically_empty else "no_ocr_result")
        return result

    if not raw:
        result.status = STATUS_NEEDS_REVIEW
        result.review_reasons.append("no_ocr_result")
        return result

    cleaned = _clean_text(raw)

    # ---- 文本类 ----
    if spec.ftype in ("text",):
        result.value = cleaned
        if conf < config.FIELD_MIN_CONF:
            result.status = STATUS_NEEDS_REVIEW
            result.review_reasons.append("low_confidence")
        return result

    # ---- 编号 / 日期：正则强校验 ----
    if spec.ftype in ("device_id", "date"):
        if spec.ftype == "device_id":
            # 编号含强结构（前缀 + 6 位数字），用宽松正则容忍 £0/E0/c- 等
            # 前缀混淆与 }、Oo 等首尾垃圾，直接抽取候选
            m = re.search(r"([A-Za-z]{2})\s*[-—]\s*(\d[\dOoSs]{5})", cleaned)
            value = None
            if m:
                prefix = m.group(1).upper().replace("0", "O")
                digits = m.group(2).replace("O", "0").replace("S", "5")
                if digits.isdigit():
                    value = f"{prefix}-{digits}"
            result.value = value if value is not None else cleaned
        else:
            # 日期：抽取 4 位年 + 分隔 + 月日 的结构
            dm = re.search(r"(\d{4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})",
                           cleaned)
            if dm:
                sep = "-" if "-" in spec.pattern else "/"
                result.value = (f"{dm.group(1)}{sep}"
                                f"{int(dm.group(2)):02d}{sep}"
                                f"{int(dm.group(3)):02d}")
            else:
                match = _extract_pattern(cleaned, spec.pattern) if spec.pattern else None
                result.value = match if match is not None else cleaned
        if spec.pattern and not re.fullmatch(spec.pattern, str(result.value)):
            result.status = STATUS_NEEDS_REVIEW
            result.review_reasons.append("id_format_error")
        elif conf < config.FIELD_MIN_CONF:
            result.status = STATUS_NEEDS_REVIEW
            result.review_reasons.append("low_confidence")
        return result

    # ---- 数值类：取值 + 单位冲突检测 ----
    if spec.ftype == "number":
        recovered = _recover_decimal(gray, raw)
        if recovered != raw:
            result.raw_text = raw + " -> " + recovered
        value, detected = _split_number_unit(recovered, spec)
        result.detected_unit = detected
        if value is None:
            result.status = STATUS_NEEDS_REVIEW
            result.review_reasons.append("no_ocr_result")
            return result
        result.value = value
        # 单位白名单冲突（检测到单位且不在允许集合内）
        if detected and spec.allowed_units and detected not in spec.allowed_units:
            result.status = STATUS_NEEDS_REVIEW
            result.review_reasons.append("unit_conflict")
        elif conf < config.FIELD_MIN_CONF:
            result.status = STATUS_NEEDS_REVIEW
            result.review_reasons.append("low_confidence")
        return result

    result.status = STATUS_NEEDS_REVIEW
    return result


def extract_page(canvas: np.ndarray, corr: Correction, template) -> dict[str, FieldResult]:
    """按模板逐区域提取；返回 key -> FieldResult。"""
    return {
        spec.key: extract_field(canvas, corr, spec)
        for spec in template.fields
    }
