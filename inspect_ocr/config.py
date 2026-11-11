"""全局配置：路径、阈值与 OCR 运行参数（全部本地）。"""

from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent

# Tesseract 本地语言模型随项目存放，保证不依赖系统全局安装
TESSDATA_DIR = ROOT_DIR / "tessdata"
# 分语言调用：eng+chi_sim 组合会让中文误走 eng 模型产生拉丁乱码，
# 因此中文整页/文本字段用 chi_sim，数值/编号字段用 eng 分别识别
TESS_LANG_CN = "chi_sim"
TESS_LANG_NUM = "eng"
TESS_CONFIG = "--psm 6"  # 统一文本块；单字段裁剪后调用时再按需覆盖

# 版式归一化后的标准画布尺寸（所有模板区域坐标基于该画布，左上为原点）
CANVAS_W = 1240
CANVAS_H = 1754
MARGIN = 70  # 归一化时表单边框距画布边缘的留白

# 置信度阈值：OCR 平均置信度低于该值 -> needs_review
OCR_MIN_CONF = 62.0
# 单字段最低置信度
FIELD_MIN_CONF = 55.0

# 勾选项判定：填充像素绝对占比阈值 + 相对最高框比值（双条件，抗噪声）
CHECKBOX_FILL_RATIO = 0.10
CHECKBOX_REL_RATIO = 1.8

# 数据库与数据目录
DATA_DIR = Path(os.environ.get("INSPECT_DATA_DIR", ROOT_DIR / "data"))
DB_PATH = DATA_DIR / "inspect.db"
IMAGE_DIR = DATA_DIR / "images"
EXPORT_DIR = DATA_DIR / "exports"

for _d in (DATA_DIR, IMAGE_DIR, EXPORT_DIR):
    _d.mkdir(parents=True, exist_ok=True)
