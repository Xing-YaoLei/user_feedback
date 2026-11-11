"""合成巡检单样本生成器。

用 Pillow 程序化绘制两种固定版式，再用 OpenCV 注入真实扫描退化：
旋转（含 90 度整向旋转）、透视扭曲、高斯/椒盐噪声、缺页角、空白字段。
每张样本同时输出 ground-truth JSON，供测试比对定位与识别结果。
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .templates import TEMPLATE_A, TEMPLATE_B, TemplateSpec

# 与归一化画布同尺寸绘制，保证模板区域坐标即设计坐标
from .config import CANVAS_W, CANVAS_H, MARGIN

_FONT_CANDIDATES = (
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Songti.ttc",
)


def _font(size: int) -> ImageFont.FreeTypeFont:
    for p in _FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


FONT_TITLE = _font(40)
FONT_H = _font(28)
FONT_TXT = _font(26)
FONT_SMALL = _font(22)


def _region_px(region):
    x0, y0, x1, y1 = region
    return (int(x0 * CANVAS_W), int(y0 * CANVAS_H),
            int(x1 * CANVAS_W), int(y1 * CANVAS_H))


def _draw_cell(draw: ImageDraw.ImageDraw, region, text: str,
               font=FONT_TXT, align="left") -> None:
    x0, y0, x1, y1 = _region_px(region)
    draw.rectangle([x0, y0, x1, y1], outline=(0, 0, 0), width=2)
    if not text:
        return
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if align == "center":
        tx = x0 + (x1 - x0 - tw) / 2
    else:
        tx = x0 + 10
    ty = y0 + (y1 - y0 - th) / 2 - bbox[1]
    draw.text((tx, ty), text, fill=(0, 0, 0), font=font)


def _draw_checkbox(draw: ImageDraw.ImageDraw, box_region, checked: bool) -> None:
    x0, y0, x1, y1 = _region_px(box_region)
    draw.rectangle([x0, y0, x1, y1], outline=(0, 0, 0), width=2)
    if checked:
        # 手绘勾：两条粗线
        draw.line([x0 + 6, (y0 + y1) // 2, (x0 + x1) // 2 - 2, y1 - 6],
                  fill=(0, 0, 0), width=4)
        draw.line([(x0 + x1) // 2 - 2, y1 - 6, x1 - 5, y0 + 6],
                  fill=(0, 0, 0), width=4)


def _base_sheet() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (CANVAS_W, CANVAS_H), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    # 外框（页面边界），角点检测依赖它
    draw.rectangle(
        [MARGIN, MARGIN, CANVAS_W - MARGIN, CANVAS_H - MARGIN],
        outline=(0, 0, 0), width=3,
    )
    return img, draw


# ---------------------------------------------------------------------------
# 两种版式的绘制
# ---------------------------------------------------------------------------

def render_template_a(rng: random.Random) -> tuple[Image.Image, dict]:
    img, draw = _base_sheet()
    fmap = {f.key: f for f in TEMPLATE_A.fields}
    draw.text((CANVAS_W // 2 - 200, MARGIN + 25),
              TEMPLATE_A.name, fill=(0, 0, 0), font=FONT_TITLE)

    device_id = f"EQ-{rng.randint(100000, 999999)}"
    date = f"2026-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
    inspector = rng.choice(["张工", "李工", "王工", "赵工"])
    meter = f"{rng.randint(1000, 99999)}.{rng.randint(0, 9)} kWh"
    voltage = f"{rng.randint(210, 240)}.{rng.randint(0, 9)} V"
    current = f"{rng.randint(2, 80)}.{rng.randint(0, 9)} A"
    status = rng.choice(["正常运行", "待机", "故障"])
    remark = rng.choice(["", "运行平稳", "需复测", "换班复核"])

    _draw_cell(draw, (0.10, 0.135, 0.60, 0.175), "设备编号：", FONT_H)
    _draw_cell(draw, fmap["device_id"].region, device_id)
    _draw_cell(draw, (0.10, 0.195, 0.60, 0.235), "巡检日期：", FONT_H)
    _draw_cell(draw, fmap["inspect_date"].region, date)
    _draw_cell(draw, (0.10, 0.255, 0.60, 0.295), "巡检员：", FONT_H)
    _draw_cell(draw, fmap["inspector"].region, inspector)

    # 读数表格
    rows = [
        ("电能表读数", "meter_reading", meter),
        ("电压", "voltage", voltage),
        ("电流", "current", current),
    ]
    for label, key, val in rows:
        spec = fmap[key]
        _draw_cell(draw, (0.08, spec.region[1], 0.28, spec.region[3]),
                   label, FONT_H, align="center")
        _draw_cell(draw, spec.region, val)

    _draw_cell(draw, (0.08, 0.70, 0.28, 0.76), "运行状态", FONT_H, align="center")
    for name, box in fmap["status"].options:
        _draw_checkbox(draw, box, checked=(name == status))
        bx0, by0, bx1, by1 = _region_px(box)
        draw.text((bx1 + 8, by0 - 2), name, fill=(0, 0, 0), font=FONT_SMALL)

    _draw_cell(draw, (0.08, 0.80, 0.18, 0.87), "备注", FONT_H, align="center")
    _draw_cell(draw, fmap["remark"].region, remark)

    truth = {
        "template_id": "A",
        "device_id": device_id,
        "inspect_date": date,
        "inspector": inspector,
        "meter_reading": float(meter.split()[0]),
        "voltage": float(voltage.split()[0]),
        "current": float(current.split()[0]),
        "status": [status],
        "remark": remark,
    }
    return img, truth


def render_template_b(rng: random.Random) -> tuple[Image.Image, dict]:
    img, draw = _base_sheet()
    fmap = {f.key: f for f in TEMPLATE_B.fields}
    draw.text((CANVAS_W // 2 - 200, MARGIN + 25),
              TEMPLATE_B.name, fill=(0, 0, 0), font=FONT_TITLE)

    device_id = f"MC-{rng.randint(100000, 999999)}"
    date = f"2026/{rng.randint(1, 12):02d}/{rng.randint(1, 28):02d}"
    team = rng.choice(["甲班", "乙班", "丙班"])
    oil = f"{rng.randint(2, 8)}.{rng.randint(0, 9)} MPa"
    temp = f"{rng.randint(35, 85)}.{rng.randint(0, 9)} °C"
    hours = f"{rng.randint(100, 9999)}.{rng.randint(0, 9)} h"
    all_items = [n for n, _ in fmap["check_items"].options]
    checked_items = rng.sample(all_items, k=rng.randint(1, 3))
    remark = rng.choice(["", "一切正常", "油温偏高", ""])

    _draw_cell(draw, (0.10, 0.135, 0.58, 0.175), "设备编号：", FONT_H)
    _draw_cell(draw, fmap["device_id"].region, device_id)
    _draw_cell(draw, (0.10, 0.195, 0.58, 0.235), "点检日期：", FONT_H)
    _draw_cell(draw, fmap["inspect_date"].region, date)
    _draw_cell(draw, (0.10, 0.255, 0.58, 0.295), "作业班组：", FONT_H)
    _draw_cell(draw, fmap["team"].region, team)

    rows = [
        ("润滑油压力", "oil_pressure", oil),
        ("轴承温度", "temperature", temp),
        ("累计运行时长", "run_hours", hours),
    ]
    for label, key, val in rows:
        spec = fmap[key]
        _draw_cell(draw, (0.12, spec.region[1], 0.53, spec.region[3]),
                   label, FONT_H, align="center")
        _draw_cell(draw, spec.region, val)

    _draw_cell(draw, (0.08, 0.65, 0.18, 0.80), "点检项目", FONT_H, align="center")
    for name, box in fmap["check_items"].options:
        _draw_checkbox(draw, box, checked=(name in checked_items))
        bx0, by0, bx1, by1 = _region_px(box)
        draw.text((bx1 + 8, by0 - 2), name, fill=(0, 0, 0), font=FONT_SMALL)

    _draw_cell(draw, (0.08, 0.82, 0.18, 0.88), "备注", FONT_H, align="center")
    _draw_cell(draw, fmap["remark"].region, remark)

    truth = {
        "template_id": "B",
        "device_id": device_id,
        "inspect_date": date,
        "team": team,
        "oil_pressure": float(oil.split()[0]),
        "temperature": float(temp.split()[0]),
        "run_hours": float(hours.split()[0]),
        "check_items": sorted(checked_items),
        "remark": remark,
    }
    return img, truth


# ---------------------------------------------------------------------------
# 退化注入
# ---------------------------------------------------------------------------

def _to_cv(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def apply_perspective(bgr: np.ndarray, rng: random.Random,
                      strength: float = 0.03) -> np.ndarray:
    h, w = bgr.shape[:2]
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    dx, dy = w * strength, h * strength
    dst = np.array([
        [rng.uniform(0, dx), rng.uniform(0, dy)],
        [w - rng.uniform(0, dx), rng.uniform(0, dy)],
        [w - rng.uniform(0, dx), h - rng.uniform(0, dy)],
        [rng.uniform(0, dx), h - rng.uniform(0, dy)],
    ], dtype=np.float32)
    m = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(bgr, m, (w, h),
                               borderMode=cv2.BORDER_CONSTANT,
                               borderValue=(255, 255, 255))


def apply_rotation(bgr: np.ndarray, rng: random.Random,
                   max_angle: float = 6.0) -> tuple[np.ndarray, float]:
    angle = rng.uniform(-max_angle, max_angle)
    h, w = bgr.shape[:2]
    mat = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(mat[0, 0]), abs(mat[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    mat[0, 2] += (nw - w) / 2
    mat[1, 2] += (nh - h) / 2
    rot = cv2.warpAffine(bgr, mat, (nw, nh),
                         borderMode=cv2.BORDER_CONSTANT,
                         borderValue=(255, 255, 255))
    return rot, angle


def apply_orientation_90(bgr: np.ndarray, rng: random.Random
                         ) -> tuple[np.ndarray, int]:
    k = rng.choice([0, 1, 3])  # 逆时针 90 / 顺时针 90，或不转
    if k == 0:
        return bgr, 0
    return np.ascontiguousarray(np.rot90(bgr, k)), 90 if k == 1 else 270


def apply_noise(bgr: np.ndarray, rng: random.Random,
                gauss_sigma: float = 7.0, salt_ratio: float = 0.0015
                ) -> np.ndarray:
    # 噪声水平贴近真实桌面扫描：轻度高斯亮度抖动 + 稀疏椒盐点
    noise = rng.gauss(0, gauss_sigma)
    out = np.clip(bgr.astype(np.int16) + int(noise), 0, 255).astype(np.uint8)
    n = int(bgr.size * salt_ratio / 3)
    for _ in range(n):
        y, x = rng.randrange(bgr.shape[0]), rng.randrange(bgr.shape[1])
        out[y, x] = rng.choice([0, 255])
    return np.clip(out, 0, 255).astype(np.uint8)


def apply_torn_corner(bgr: np.ndarray, rng: random.Random,
                      corner: int | None = None) -> np.ndarray:
    """缺页角：用白色多边形覆盖一个角，模拟页面残缺。"""
    h, w = bgr.shape[:2]
    # 温和缺角：控制在页面边框主线可恢复的范围内，避免外框检测彻底失效
    corner = rng.randrange(4) if corner is None else corner
    size_x, size_y = int(w * rng.uniform(0.06, 0.11)), int(h * rng.uniform(0.045, 0.09))
    corners = {
        0: [(0, 0), (size_x, 0), (0, size_y)],
        1: [(w, 0), (w - size_x, 0), (w, size_y)],
        2: [(w, h), (w - size_x, h), (w, h - size_y)],
        3: [(0, h), (size_x, h), (0, h - size_y)],
    }
    out = bgr.copy()
    cv2.fillPoly(out, [np.array(corners[corner], dtype=np.int32)],
                 color=(255, 255, 255))
    return out


def blank_out_fields(bgr: np.ndarray, spec: TemplateSpec,
                     rng: random.Random) -> list[str]:
    """随机把若干字段区域涂白，模拟空白填写项；返回被置空字段。

    直接在传入图像上原地修改（调用方持有同一 ndarray）。
    """
    candidates = [f for f in spec.fields
                  if f.ftype not in ("device_id", "date", "checkbox_group")]
    k = rng.randint(1, min(2, len(candidates)))
    chosen = rng.sample(candidates, k=k)
    for f in chosen:
        x0, y0, x1, y1 = _region_px(f.region)
        cv2.rectangle(bgr, (x0 + 2, y0 + 2), (x1 - 2, y1 - 2),
                      (255, 255, 255), thickness=-1)
    return [f.key for f in chosen]


# ---------------------------------------------------------------------------
# 批量入口
# ---------------------------------------------------------------------------

def generate_sample(out_dir: str | Path, seed: int,
                    *, torn_corner: bool = True, blank_fields: bool = True,
                    orient_90: bool = True) -> dict:
    rng = random.Random(seed)
    spec = TEMPLATE_A if seed % 2 == 0 else TEMPLATE_B
    img, truth = (render_template_a(rng) if spec.template_id == "A"
                  else render_template_b(rng))
    bgr = _to_cv(img)

    # 记录待置空字段（实际涂白在几何变换之后，避免插值在空白区残留伪影）
    blanks: list[str] = []
    if blank_fields:
        blank_specs = [f for f in spec.fields
                       if f.ftype not in ("device_id", "date", "checkbox_group")]
        k = rng.randint(1, min(2, len(blank_specs)))
        blanks = [f.key for f in rng.sample(blank_specs, k=k)]
    for bk in blanks:
        truth[bk] = None

    angle_90 = 0
    if orient_90:
        bgr, angle_90 = apply_orientation_90(bgr, rng)
    bgr, small_angle = apply_rotation(bgr, rng)
    bgr = apply_perspective(bgr, rng)
    if torn_corner:
        bgr = apply_torn_corner(bgr, rng)
    bgr = apply_noise(bgr, rng)
    # 噪声施加后再净化空白字段：真实未填写单元格是干净白底，仅含极少量
    # 全局噪声；若先涂白再加噪，密集噪点会被 OCR 误读成"幻觉文字"。
    # 净化时保留极淡的随机点，避免与纯白单元格完全不真实。
    if blanks:
        fmap = {f.key: f for f in spec.fields}
        ih, iw = bgr.shape[:2]
        for bk in blanks:
            # 透视/旋转后图像尺寸可能与设计画布不同，按比例换算坐标
            rx0, ry0, rx1, ry1 = fmap[bk].region
            x0, x1 = int(rx0 * iw) + 3, int(rx1 * iw) - 3
            y0, y1 = int(ry0 * ih) + 3, int(ry1 * ih) - 3
            x0, x1 = max(0, x0), min(iw, x1)
            y0, y1 = max(0, y0), min(ih, y1)
            cv2.rectangle(bgr, (x0, y0), (x1, y1),
                          (255, 255, 255), thickness=-1)
            # 回填极稀疏灰点（密度约为正常噪声的 1/8）
            rh, rw = (y1 - y0), (x1 - x0)
            for _ in range(max(1, rh * rw // 4000)):
                ry = rng.randrange(y0, max(y0 + 1, y1))
                rx = rng.randrange(x0, max(x0 + 1, x1))
                bgr[ry, rx] = (rng.randrange(215, 245),) * 3

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"sample_{spec.template_id}_{seed:04d}"
    img_path = out_dir / f"{stem}.png"
    # 中文路径安全写入
    ok, buf = cv2.imencode(".png", bgr)
    buf.tofile(str(img_path))

    meta = {
        "file": img_path.name,
        "seed": seed,
        "orientation_90": angle_90,
        "rotation_deg": round(small_angle, 2),
        "torn_corner": torn_corner,
        "blanked_fields": blanks,
        "ground_truth": truth,
    }
    (out_dir / f"{stem}.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def generate_dataset(out_dir: str | Path, count: int = 12,
                     seed_base: int = 1000) -> list[dict]:
    metas = []
    for i in range(count):
        metas.append(generate_sample(out_dir, seed_base + i))
    return metas
