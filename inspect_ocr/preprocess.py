"""图像预处理：旋转校正、页面检测、透视归一化、坐标双向映射。

处理顺序（与需求一致）：先识别版式 -> 再校正旋转与透视。
本模块负责"校正"部分，并保留完整变换链，使字段区域可反算到原图坐标。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import config

# 仅识别 0/90/180/270 的方向角（扫描件的典型情形）
_ORIENTATION_ANGLES = {0: 0, 1: 90, 2: 180, 3: 270}


@dataclass
class Correction:
    """一次校正的完整变换记录。"""

    rotate_angle: float
    page_corners: np.ndarray          # 旋转后图像上的页面四角 (4,2)
    homography: np.ndarray            # 旋转后图像 -> 归一化画布 (3,3)
    canvas: np.ndarray                 # 校正归一化后的 BGR 画布
    rotated: np.ndarray                # 旋转后的 BGR 图
    rot_matrix: np.ndarray            # 原图 -> 旋转后图像 (2,3)


def detect_orientation(bgr: np.ndarray) -> float:
    """用 Tesseract OSD（本地）检测 90 度整数倍方向角；失败时回退 0。"""
    import pytesseract
    from PIL import Image

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # OSD 需要二值图；文字占比过少时会抛异常
    thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    try:
        osd = pytesseract.image_to_osd(
            Image.fromarray(thr), config="--psm 0",
        )
        orient = 0
        for line in osd.splitlines():
            # Tesseract 输出形如 "Orientation in degrees: 90"
            if line.strip().startswith("Orientation in degrees"):
                orient = int(line.split(":")[1].strip())
        return float(orient)
    except Exception:
        return 0.0


def rotate_upright(bgr: np.ndarray, angle: float) -> tuple[np.ndarray, np.ndarray]:
    """按 90 度整数倍旋转，返回 (旋转后图像, 仿射矩阵 2x3)。"""
    h, w = bgr.shape[:2]
    center = (w / 2.0, h / 2.0)
    mat = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos, sin = abs(mat[0, 0]), abs(mat[0, 1])
    nw = int(h * sin + w * cos)
    nh = int(h * cos + w * sin)
    mat[0, 2] += (nw - w) / 2.0
    mat[1, 2] += (nh - h) / 2.0
    rotated = cv2.warpAffine(
        bgr, mat, (nw, nh), flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255),
    )
    return rotated, mat.astype(np.float64)


def _order_points(pts: np.ndarray) -> np.ndarray:
    """排序为 左上、右上、右下、左下。"""
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    d = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(d)]
    rect[3] = pts[np.argmax(d)]
    return rect


def _detect_frame_by_closing(gray: np.ndarray) -> np.ndarray | None:
    """自适应阈值 + 凸包四边形检测内部页面框。

    页面是带黑色矩形外框的白纸，外框常因缺页角/噪声断裂。自适应阈值
    对光照不均更鲁棒，闭运算连接断线后取最大墨迹连通块的凸包，再逼近
    为凸四边形，可稳定恢复内部页面框而非整幅扫描边界。
    """
    h, w = gray.shape
    block = max(21, (min(h, w) // 12) | 1)  # 邻域块需为奇数
    ath = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
        cv2.THRESH_BINARY_INV, block, 12)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(ath, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    img_area = h * w
    best, best_area = None, 0.0
    for c in contours:
        # 细框线围成的是空心矩形，轮廓本身面积小，阈值需放宽
        if cv2.contourArea(c) < img_area * 0.02:
            continue
        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        if hull_area < img_area * 0.2:
            continue
        peri = cv2.arcLength(hull, True)
        quad = None
        for eps in (0.02, 0.04, 0.06, 0.08):
            approx = cv2.approxPolyDP(hull, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                quad = approx.reshape(4, 2).astype(np.float32)
                break
        if quad is None:
            continue
        qw = np.linalg.norm(quad[1] - quad[0])
        qh = np.linalg.norm(quad[2] - quad[1])
        aspect = min(qw, qh) / max(qw, qh)
        if not (0.55 < aspect < 0.85):
            continue
        # 内部页面框四周有白边：不贴图像边界
        touches = (quad[:, 0].min() <= 8 or quad[:, 1].min() <= 8
                   or quad[:, 0].max() >= w - 8 or quad[:, 1].max() >= h - 8)
        if touches:
            continue
        if hull_area > best_area:
            best, best_area = quad, hull_area
    return best


def _line_intersection(p1, p2, p3, p4) -> np.ndarray | None:
    """求两条直线（各由两点定义）的交点。"""
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    x4, y4 = p4
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-9:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    return np.array([x1 + t * (x2 - x1), y1 + t * (y2 - y1)], dtype=np.float64)


def _fit_line(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """对一组线段端点做最小二乘拟合，返回 (直线上一点, 单位方向向量)。"""
    vx, vy, x0, y0 = cv2.fitLine(points.astype(np.float32),
                                 cv2.DIST_L2, 0, 0.01, 0.01).flatten()
    return np.array([x0, y0]), np.array([vx, vy])


def _detect_frame_by_lines(gray: np.ndarray) -> np.ndarray | None:
    """基于 Hough 直线检测倾斜页面的描边矩形，对小角度旋转原生鲁棒。

    流程：Canny 边缘 -> 概率 Hough -> 按角度分横/竖 -> 按位置聚类出
    上下左右四条边框 -> 最小二乘拟合 -> 求四个交点。
    """
    h, w = gray.shape
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=90,
                            minLineLength=max(40, w // 5), maxLineGap=60)
    if lines is None:
        return None
    lines = lines.reshape(-1, 4)
    hor, ver = [], []
    for x1, y1, x2, y2 in lines:
        ang = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        # 归一化到 [0,90]：先折到 [0,180)，再用 180-a 处理钝角
        a = abs(ang) % 180
        a = a if a <= 90 else 180 - a
        length = np.hypot(x2 - x1, y2 - y1)
        if a <= 15:
            hor.append((x1, y1, x2, y2, length))
        elif a >= 75:
            ver.append((x1, y1, x2, y2, length))
    if len(hor) < 2 or len(ver) < 2:
        return None

    def select_edge(items: list, vertical: bool
                    ) -> tuple[np.ndarray, np.ndarray] | None:
        """从极端位置候选池中稳健拟合一条边框直线（RANSAC 式剔离群）。

        候选池可能混入方向正交的内部线条，先按预期方向（水平/竖直）过滤，
        再反复拟合并剔除残差最大的离群线段，确保最终直线只反映外框边。
        """
        def direction_ok(it) -> bool:
            x1, y1, x2, y2, _ = it
            a = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1))) % 180
            a = a if a <= 90 else 180 - a
            return (a >= 75) if vertical else (a <= 15)

        pool = [it for it in items if direction_ok(it)]
        if len(pool) < 2:
            pool = list(items)  # 过滤后过少则回退，避免空池
        best = None
        while len(pool) >= 2:
            pts = np.array(
                [[x1, y1] for x1, y1, *_ in pool]
                + [[x2, y2] for _, _, x2, y2, _ in pool],
                dtype=np.float32)
            point, direction = _fit_line(pts)
            # 拟合方向与预期不符：剔除最偏离预期方向的线段
            da = abs(np.degrees(np.arctan2(direction[1], direction[0]))) % 180
            da = da if da <= 90 else 180 - da
            aligned = (da >= 75) if vertical else (da <= 15)
            if not aligned:
                # 找到方向最不匹配的线段剔除
                def misalign(it):
                    x1, y1, x2, y2, _ = it
                    aa = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1))) % 180
                    aa = aa if aa <= 90 else 180 - aa
                    return abs((aa - 90) if vertical else aa)
                pool.pop(max(range(len(pool)), key=lambda i: misalign(pool[i])))
                continue
            # 各中点到拟合线的垂直距离（二维叉积的绝对值）
            mids = np.array([
                [(x1 + x2) / 2, (y1 + y2) / 2]
                for x1, y1, x2, y2, _ in pool])
            diff = mids - point
            d = np.abs(direction[0] * diff[:, 1]
                       - direction[1] * diff[:, 0])
            inlier = d <= max(3.0, 0.02 * (h if vertical else w))
            if inlier.all() or inlier.sum() < 2:
                best = (point, direction)
                break
            pool.pop(int(np.argmax(d)))
            best = (point, direction)
        return best

    def cluster_edges(items, vertical: bool):
        # 页面外框边是整页最长且位置最靠两端的线段。按位置排序后，从最
        # 极端的若干条中取长度排名靠前的线段组成候选池——既锁定外框位置，
        # 又用长度排除密集但短小的内部表格线。
        pos = ((lambda it: (it[1] + it[3]) / 2) if not vertical
               else (lambda it: (it[0] + it[2]) / 2))
        ordered = sorted(items, key=pos)
        take = max(2, len(ordered) // 5)
        extremes = ordered[:take] + ordered[-take:]
        # 候选池保留其中最长的若干条（外框边显著长于内部线）
        extremes.sort(key=lambda it: it[4], reverse=True)
        keep = extremes[:max(3, take)]
        low = [it for it in keep if pos(it) <= np.median([pos(x) for x in ordered])]
        high = [it for it in keep if pos(it) > np.median([pos(x) for x in ordered])]
        # 若按中位数分不出（极端情况），退化为按位置两端各取
        if not low or not high:
            low = ordered[:max(2, take // 2)]
            high = ordered[-max(2, take // 2):]
        return low, high

    top, bottom = cluster_edges(hor, vertical=False)
    left, right = cluster_edges(ver, vertical=True)
    if not all((top, bottom, left, right)):
        return None

    ln_top = select_edge(top, vertical=False)
    ln_bottom = select_edge(bottom, vertical=False)
    ln_left = select_edge(left, vertical=True)
    ln_right = select_edge(right, vertical=True)
    if not all((ln_top, ln_bottom, ln_left, ln_right)):
        return None

    def to_two(ln):
        (x0, y0), (vx, vy) = ln
        return (x0 - vx * 2000, y0 - vy * 2000), (x0 + vx * 2000, y0 + vy * 2000)

    corners = []
    for hln, vln in ((ln_top, ln_left), (ln_top, ln_right),
                     (ln_bottom, ln_right), (ln_bottom, ln_left)):
        p = _line_intersection(*to_two(hln), *to_two(vln))
        if p is None:
            return None
        corners.append(p)
    quad = np.array(corners, dtype=np.float32)
    area = cv2.contourArea(quad)
    # 合理性：面积在画面量级内，且四个交点都落在扩展画面范围内
    if not (0.25 * h * w < area < 0.97 * h * w):
        return None
    margin = 0.25
    in_plane = all(
        (-margin * w <= x <= (1 + margin) * w)
        and (-margin * h <= y <= (1 + margin) * h)
        for x, y in quad)
    if not in_plane:
        return None
    return quad


def detect_page_corners(bgr: np.ndarray) -> np.ndarray:
    """检测页面四角；缺页角等导致四边形不完整时回退到最大轮廓边界。

    返回旋转后图像坐标系下的 4 个角点 (4,2)，顺序 TL,TR,BR,BL。

    白底扫描件中页面边框是白色背景上的黑色矩形洞（RETR_EXTERNAL 取不到），
    因此用 RETR_LIST 同时收集内外轮廓，并优先选择"面积明显小于全图、
    且为凸四边形"的内框；全图背景四边形仅作兜底。
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    th1 = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    th2 = cv2.threshold(blur, 0, 255,
                        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    h, w = gray.shape
    img_area = h * w
    inner: np.ndarray | None = None       # 页面内边框（首选）
    inner_area = 0.0
    fallback: np.ndarray | None = None    # 缺页角等情形的兜底
    for thr in (th1, th2):
        contours, _ = cv2.findContours(thr, cv2.RETR_LIST,
                                       cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            area = cv2.contourArea(c)
            if area < img_area * 0.15:
                continue
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.03 * peri, True)
            if len(approx) != 4:
                approx = cv2.approxPolyDP(c, 0.06 * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                quad = approx.reshape(4, 2).astype(np.float32)
                is_full_frame = (
                    area >= img_area * 0.97
                    and _touches_image_border(quad, w, h)
                )
                if is_full_frame:
                    continue  # 整图背景，跳过
                if area > inner_area:
                    inner = quad
                    inner_area = area
            elif fallback is None and area < img_area * 0.97:
                fallback = cv2.boxPoints(cv2.minAreaRect(c)).astype(np.float32)
    if inner is not None:
        return _order_points(inner)
    if fallback is not None:
        return _order_points(fallback)
    # 细描边边框：优先强闭运算得到完整页面块（不会把内部表格线误当外框），
    # Hough 直线求交作为补充；两者都失败才回退整图。
    closed_frame = _detect_frame_by_closing(gray)
    if closed_frame is not None:
        return _order_points(closed_frame)
    line_frame = _detect_frame_by_lines(gray)
    if line_frame is not None:
        return _order_points(line_frame)
    # 均失败：整图即页面（页面铺满扫描区的情形）
    return _order_points(np.array(
        [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32))


def _touches_image_border(quad: np.ndarray, w: int, h: int,
                          tol: float = 6.0) -> bool:
    return bool(
        np.any(quad[:, 0] <= tol) and np.any(quad[:, 0] >= w - 1 - tol)
        and np.any(quad[:, 1] <= tol) and np.any(quad[:, 1] >= h - 1 - tol)
    )


def normalize_page(rotated: np.ndarray, corners: np.ndarray
                   ) -> tuple[np.ndarray, np.ndarray]:
    """透视变换到标准画布，返回 (画布 BGR, 单应矩阵 H 3x3)。

    检测到的页面四角映射到画布内距 MARGIN 的矩形，与样本渲染时页面边框
    的位置一致；模板字段区域按"边框内容区"比例定义，由 region 换算函数
    统一转到画布像素，两套坐标系据此严格对齐。
    """
    m = config.MARGIN
    dst = np.array([
        [m, m],
        [config.CANVAS_W - 1 - m, m],
        [config.CANVAS_W - 1 - m, config.CANVAS_H - 1 - m],
        [m, config.CANVAS_H - 1 - m],
    ], dtype=np.float32)
    h_mat = cv2.getPerspectiveTransform(corners, dst)
    canvas = cv2.warpPerspective(
        rotated, h_mat, (config.CANVAS_W, config.CANVAS_H),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255),
    )
    return canvas, h_mat.astype(np.float64)


def estimate_skew(gray: np.ndarray) -> float:
    """用 Hough 水平线段角度中位数估计整页倾斜角（度），范围约 [-15,15]。

    文档去斜的标准做法：收集近水平线段，取角度中位数抗噪。线段朝向任意
    （左->右或右->左）会导致符号翻转，因此先把角度折到 (-90,90] 再统计。
    """
    h, w = gray.shape
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80,
                            minLineLength=max(40, w // 6), maxLineGap=40)
    if lines is None:
        return 0.0
    angles = []
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        while a > 90:
            a -= 180
        while a <= -90:
            a += 180
        if abs(a) <= 15:
            angles.append(a)
    if len(angles) < 5:
        return 0.0
    return float(np.median(angles))


def correct_image(bgr: np.ndarray, skip_orientation: bool = False) -> Correction:
    """完整校正流水线：方向 -> 旋转 -> Hough 去斜 -> 页面角点 -> 透视归一化。"""
    angle = 0.0 if skip_orientation else detect_orientation(bgr)
    rotated, rot_mat = rotate_upright(bgr, angle)
    # 小角度去斜：用 Hough 水平线中位数估计，旋转到页面边与图像轴平行
    gray0 = cv2.cvtColor(rotated, cv2.COLOR_BGR2GRAY)
    # 实测 estimate_skew 与真实旋转角反号，而 rotate_upright(angle) 按
    # 正角度逆时针校正；要抵消真实角 true，需旋转 -true = estimate_skew
    skew = estimate_skew(gray0)
    if abs(skew) >= 0.3:
        rotated, skew_mat = rotate_upright(rotated, skew)
        rot_mat = skew_mat @ np.vstack([rot_mat, [0, 0, 1]])
        rot_mat = rot_mat[:2, :]
    else:
        skew = 0.0
    corners = detect_page_corners(rotated)
    canvas, h_mat = normalize_page(rotated, corners)
    return Correction(
        rotate_angle=angle + skew, page_corners=corners, homography=h_mat,
        canvas=canvas, rotated=rotated, rot_matrix=rot_mat,
    )


# ---------------------------------------------------------------------------
# 坐标映射
# ---------------------------------------------------------------------------

def norm_region_to_canvas(region: tuple[float, float, float, float]
                          ) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = region
    return (
        int(x0 * config.CANVAS_W), int(y0 * config.CANVAS_H),
        int(x1 * config.CANVAS_W), int(y1 * config.CANVAS_H),
    )


def canvas_point_to_original(corr: Correction, pt_xy: np.ndarray) -> np.ndarray:
    """归一化画布点 -> 旋转后图像点 -> 原图点。"""
    h_inv = np.linalg.inv(corr.homography)
    p = np.array([pt_xy[0], pt_xy[1], 1.0], dtype=np.float64)
    q = h_inv @ p
    q = q[:2] / q[2]
    # 逆仿射：原图坐标 = R^-1 (q - t)
    r = corr.rot_matrix[:, :2]
    t = corr.rot_matrix[:, 2]
    orig = np.linalg.solve(r, q - t)
    return orig


def norm_region_to_source_polygon(corr: Correction,
                                  region: tuple[float, float, float, float]
                                  ) -> list[list[float]]:
    """归一化区域四角反算为原图（校正前）上的多边形坐标。"""
    x0, y0, x1, y1 = region
    canvas_pts = np.array([
        [x0 * config.CANVAS_W, y0 * config.CANVAS_H],
        [x1 * config.CANVAS_W, y0 * config.CANVAS_H],
        [x1 * config.CANVAS_W, y1 * config.CANVAS_H],
        [x0 * config.CANVAS_W, y1 * config.CANVAS_H],
    ], dtype=np.float64)
    poly = [canvas_point_to_original(corr, p).tolist() for p in canvas_pts]
    return [[round(x, 1), round(y, 1)] for x, y in poly]


def load_image(path: str) -> np.ndarray:
    # imread 不支持中文路径的环境下用 fromfile 兜底
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"无法读取图像: {path}")
    return img
