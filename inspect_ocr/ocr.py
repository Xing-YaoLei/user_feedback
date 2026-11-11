"""本地 OCR 统一封装：去噪预处理、按内容选语言、置信度返回。

语言策略（实测 eng+chi_sim 组合会让中文误走 eng 产生乱码）：
* 中文整页/文本字段 -> chi_sim
* 数值/编号/日期字段 -> eng（数字与拉丁符号更稳）
全程仅调用本地 Tesseract，无任何网络请求。
"""

from __future__ import annotations

import os

import cv2
import numpy as np

from . import config


def set_tessdata() -> None:
    os.environ["TESSDATA_PREFIX"] = str(config.TESSDATA_DIR)


def tight_crop(gray: np.ndarray, pad_frac: float = 0.10) -> np.ndarray:
    """按墨迹包围盒裁掉大片空白与单元格边框，避免宽高比失衡导致 PSM 误判。

    巡检单字段常为左对齐、右侧大片留白，且四周有单元格黑线。先裁掉边缘
    边框，再用中值滤波+连通域求墨迹包围盒（不做形态学开运算，避免滤掉
    细笔画与小数点），找不到墨迹时返回去掉边框后的图。
    """
    if len(gray.shape) == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    # 先裁掉单元格四周边框
    px, py = int(w * 0.06), int(h * 0.16)
    base = gray[py:h - py, px:w - px]
    med = cv2.medianBlur(base, 3)
    inv = cv2.threshold(med, 0, 255,
                        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    n, _lab, stats, _ = cv2.connectedComponentsWithStats(inv, 8)
    bh, bw = base.shape
    keep = []
    for i in range(1, n):
        x, y, cw, ch, area = stats[i]
        if area >= max(20, 0.0008 * bh * bw) or ch >= bh * 0.25:
            keep.append((x, y, x + cw, y + ch))
    if not keep:
        return base
    x0 = min(k[0] for k in keep)
    y0 = min(k[1] for k in keep)
    x1 = max(k[2] for k in keep)
    y1 = max(k[3] for k in keep)
    gx, gy = int(bw * pad_frac), int(bh * pad_frac)
    return base[max(0, y0 - gy):min(bh, y1 + gy),
                max(0, x0 - gx):min(bw, x1 + gx)]


def denoise_for_ocr(gray: np.ndarray, *, remove_speckles: bool = True
                    ) -> np.ndarray:
    """裁掉单元格边框 + 二值化 + 中值去椒盐，返回白底黑字图。

    巡检单每个字段都有黑色矩形边框，若不裁掉，Tesseract 易受框线干扰
    而放弃识别。数值字段不开运算：2x2 核会误删小数点。
    """
    if len(gray.shape) == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    # 裁掉四周单元格边框：边框线仅 2~3px，用固定小像素内缩避免切掉首字符
    px, py = 5, max(4, int(h * 0.14))
    gray = gray[py:max(py + 1, h - py), px:max(px + 1, w - px)]
    med = cv2.medianBlur(gray, 3)
    binary = cv2.threshold(med, 0, 255,
                           cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    if remove_speckles:
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                                  np.ones((2, 2), np.uint8))
    return binary


def image_text(bgr_or_gray: np.ndarray, lang: str, psm: str = "--psm 6",
               upscale: float = 2.0, *, remove_speckles: bool = True) -> str:
    """纯文本识别。"""
    import pytesseract
    from PIL import Image

    set_tessdata()
    img = denoise_for_ocr(bgr_or_gray, remove_speckles=remove_speckles)
    if upscale and upscale != 1.0:
        img = cv2.resize(img, None, fx=upscale, fy=upscale,
                         interpolation=cv2.INTER_CUBIC)
    return pytesseract.image_to_string(
        Image.fromarray(img), lang=lang, config=psm).strip()


def _tesseract(img: np.ndarray, lang: str, psm: str) -> dict:
    import pytesseract
    from PIL import Image

    set_tessdata()
    return pytesseract.image_to_data(
        Image.fromarray(img), lang=lang, config=psm,
        output_type=pytesseract.Output.DICT,
    )


def image_words(bgr_or_gray: np.ndarray, lang: str, psm: str = "--psm 6",
                upscale: float = 2.0, *,
                remove_speckles: bool = True,
                tight: bool = False) -> tuple[str, float]:
    """词级识别，返回 (拼接文本, 平均置信度)。无文字时置信度为 0。

    tight=True 时先按墨迹包围盒裁掉空白（适用于左对齐短文本字段），
    并对中文短文本启用多假设投票以抵抗噪声。
    """
    set_tessdata()
    src = bgr_or_gray
    if tight:
        src = tight_crop(src if len(src.shape) == 2
                         else cv2.cvtColor(src, cv2.COLOR_BGR2GRAY))
    img = denoise_for_ocr(src, remove_speckles=remove_speckles)
    if upscale and upscale != 1.0:
        img = cv2.resize(img, None, fx=upscale, fy=upscale,
                         interpolation=cv2.INTER_CUBIC)
    data = _tesseract(img, lang, psm)
    words, confs = [], []
    for txt, c in zip(data["text"], data["conf"]):
        txt = txt.strip()
        if txt and c != -1:
            words.append(txt)
            confs.append(float(c))
    text = " ".join(words).strip()
    conf = float(np.mean(confs)) if confs else 0.0
    return text, conf


def image_words_vote(bgr_or_gray: np.ndarray, lang: str,
                     candidates: list[tuple[np.ndarray, str]],
                     ) -> tuple[str, float, int, int]:
    """多假设投票识别：对同一裁剪图的多种 (预处理图, psm) 结果取众数。

    噪声扫描件下单一预处理组合不稳定（同一字段在不同 PSM 下结果漂移），
    多组合投票可显著降低偶发误识。
    返回 (最高票文本, 平均置信度, 最高票数, 有效票数)。
    """
    set_tessdata()
    votes: dict[str, list[float]] = {}
    for img, psm in candidates:
        data = _tesseract(img, lang, psm)
        words, confs = [], []
        for txt, c in zip(data["text"], data["conf"]):
            txt = txt.strip()
            if txt and c != -1:
                words.append(txt)
                confs.append(float(c))
        text = "".join(words).strip()
        if not text:
            continue
        avg = float(np.mean(confs)) if confs else 0.0
        votes.setdefault(text, []).append(avg)
    if not votes:
        return "", 0.0, 0, 0
    total_votes = sum(len(v) for v in votes.values())
    # 先按票数、再按平均置信度排序
    best = max(votes.items(), key=lambda kv: (len(kv[1]), max(kv[1])))
    return (best[0], round(float(np.mean(best[1])), 1),
            len(best[1]), total_votes)


def build_cn_candidates(gray: np.ndarray) -> list[tuple[np.ndarray, str]]:
    """为中文短文本构造多组 (预处理图, psm) 投票候选。"""
    t = tight_crop(gray)
    cands = []
    # NLM 保边去噪 + 两档放大 + 稀疏/单行 PSM
    for h in (10, 18):
        dn = cv2.fastNlMeansDenoising(
            t, None, h=h, templateWindowSize=7, searchWindowSize=21)
        for fx in (3.0, 4.0):
            up = cv2.resize(dn, None, fx=fx, fy=fx,
                            interpolation=cv2.INTER_CUBIC)
            for psm in ("--psm 11", "--psm 7"):
                cands.append((up, psm))
    # 中值+二值兜底
    med = cv2.medianBlur(t, 3)
    b = cv2.threshold(med, 0, 255,
                      cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    up = cv2.resize(b, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
    cands.append((up, "--psm 11"))
    return cands
