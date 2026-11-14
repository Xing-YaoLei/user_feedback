#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
巡检轨迹 / 管线区段逐点归属与区段到访明细生成器。

规则概要
--------
1. 轨迹 CSV 与管线 GeoJSON 使用同一套以米为单位的平面坐标。
2. 每个轨迹点保留距折线 <= 15 米的全部候选区段；记录点到折线的最近投影
   （投影点、距起点的折线里程、垂直距离）。投影距离并列时取沿折线起点
   里程最短的位置。
3. 相邻点之间：可留在同一区段（沿折线双向移动），也可经共享端点换段；
   沿管线实际走过的距离不得超过 采样间隔(秒) × 2 米/秒。
4. 无候选的点、与上一点间隔 > 45 秒的空档切断轨迹；加入下一个点后若当前
   段不存在任何可行延续，则在该点之前切开、从该点重新匹配并记录原因。
5. 每段轨迹内做动态规划：单点代价 = 投影距离四舍五入到整数毫米，路径总
   偏差为各点代价之和。取最优值，总偏差 <= 最优值 + 500 毫米的路径均纳入
   判定。
6. 某点在全部近优路径上归属同一区段才确认，否则标为待核对并列出近优路径
   上出现过的区段。
7. 同一段轨迹内连续确认到同一区段的点合并为一次到访。

仅使用 Python 标准库。
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

# ---- 常量 -------------------------------------------------------------------

EPS = 1e-9                      # 米，浮点并列比较容差
DEFAULT_RADIUS_M = 15.0         # 候选区段半径
DEFAULT_MAX_GAP_S = 45.0        # 轨迹切断空档
DEFAULT_SPEED_MPS = 2.0         # 最大行进速度
DEFAULT_TOL_MM = 500            # 近优路径容忍总偏差（毫米）
GRID_CELL_M = 50.0              # 空间索引格子大小

INSPECTOR_KEYS = [
    "inspector_id", "inspectorid", "inspector", "worker_id", "worker",
    "user_id", "user", "巡检员id", "巡检员", "人员id", "人员",
]
TIME_KEYS = [
    "timestamp", "time", "ts", "datetime", "date_time", "sample_time",
    "采样时间", "时间", "定位时间",
]
X_KEYS = ["x", "easting", "x_m", "coord_x", "coordinate_x", "lon",
          "longitude", "经度", "x坐标"]
Y_KEYS = ["y", "northing", "y_m", "coord_y", "coordinate_y", "lat",
          "latitude", "纬度", "y坐标"]

SEG_ID_KEYS = ["segment_id", "seg_id", "section_id", "id", "区段id", "区段编号", "区段"]
START_KEYS = ["start_node", "from_node", "node_start", "from", "start",
              "起点节点", "起点", "起始节点"]
END_KEYS = ["end_node", "to_node", "node_end", "to", "end",
            "终点节点", "终点", "结束节点"]


# ---- 数据结构 ---------------------------------------------------------------

@dataclass
class Segment:
    seg_id: str
    start_node: str
    end_node: str
    coords: list[tuple[float, float]]
    cum: list[float]                      # 各顶点距起点的折线里程
    length: float
    bbox: tuple[float, float, float, float]
    nodes: set[str] = field(default_factory=set)


@dataclass
class Projection:
    """一个点对一个区段的最近投影结果。"""
    seg_id: str
    dist_m: float
    arc_m: float                          # 投影点距折线起点的里程
    px: float
    py: float


@dataclass
class TrajPoint:
    inspector: str
    point_index: int                      # 该巡检员名下的全局序号
    timestamp_raw: str
    epoch_s: float
    x: float
    y: float
    candidates: list[Projection] = field(default_factory=list)
    nearest_overall: Optional[Projection] = None


@dataclass
class State:
    """DP 某一层（某个轨迹点）上，归属到某个区段的最小代价状态。"""
    cost_mm: int
    arc_m: float
    mm: int                               # 当前点自身的整数毫米代价
    prev_seg: Optional[str] = None


# ---- 几何计算 ---------------------------------------------------------------

def _dist(ax: float, ay: float, bx: float, by: float) -> float:
    return math.hypot(ax - bx, ay - by)


def project_on_segment(px: float, py: float, seg: Segment) -> Projection:
    """点到折线的最近投影；距离并列时取沿折线起点里程最短者。"""
    best_d: Optional[float] = None
    best_arc = 0.0
    best_x = seg.coords[0][0]
    best_y = seg.coords[0][1]

    for i in range(len(seg.coords) - 1):
        ax, ay = seg.coords[i]
        bx, by = seg.coords[i + 1]
        dx, dy = bx - ax, by - ay
        edge_len2 = dx * dx + dy * dy
        if edge_len2 <= EPS:
            t = 0.0
        else:
            t = ((px - ax) * dx + (py - ay) * dy) / edge_len2
            t = max(0.0, min(1.0, t))
        qx, qy = ax + t * dx, ay + t * dy
        d = _dist(px, py, qx, qy)
        arc = seg.cum[i] + (0.0 if edge_len2 <= EPS else t * math.sqrt(edge_len2))

        if best_d is None or d < best_d - EPS or (
            abs(d - best_d) <= EPS and arc < best_arc
        ):
            best_d, best_arc, best_x, best_y = d, arc, qx, qy

    return Projection(seg.seg_id, best_d, best_arc, best_x, best_y)


class SegmentIndex:
    """按外扩 bbox 建立的均匀网格索引，用于 15 米邻域候选查询。"""

    def __init__(self, segments: list[Segment], radius: float):
        self.segments = segments
        self.radius = radius
        self.cell = GRID_CELL_M
        self.grid: dict[tuple[int, int], list[Segment]] = {}
        for seg in segments:
            x0, y0, x1, y1 = seg.bbox
            cx0 = math.floor((x0 - radius) / self.cell)
            cx1 = math.floor((x1 + radius) / self.cell)
            cy0 = math.floor((y0 - radius) / self.cell)
            cy1 = math.floor((y1 + radius) / self.cell)
            for cx in range(cx0, cx1 + 1):
                for cy in range(cy0, cy1 + 1):
                    self.grid.setdefault((cx, cy), []).append(seg)

    def query(self, px: float, py: float) -> list[Segment]:
        cx = math.floor(px / self.cell)
        cy = math.floor(py / self.cell)
        r_cells = math.ceil(self.radius / self.cell)
        out: dict[str, Segment] = {}
        for ix in range(cx - r_cells, cx + r_cells + 1):
            for iy in range(cy - r_cells, cy + r_cells + 1):
                for seg in self.grid.get((ix, iy), ()):
                    out[seg.seg_id] = seg
        return list(out.values())


# ---- 输入读取 ---------------------------------------------------------------

def _pick_key(columns: list[str], candidates: list[str], override: Optional[str],
              label: str) -> str:
    if override:
        if override not in columns:
            raise ValueError(f"指定的{label}列 '{override}' 不存在，实际列: {columns}")
        return override
    lower = {c.lower(): c for c in columns}
    for key in candidates:
        if key.lower() in lower:
            return lower[key.lower()]
    raise ValueError(f"无法自动识别{label}列，实际列: {columns}，可用 --{label}-col 指定")


def parse_epoch(raw: str) -> float:
    s = raw.strip()
    # 纯数字：Unix 秒 / 毫秒
    try:
        v = float(s)
        if v > 1e12:           # 毫秒
            return v / 1000.0
        return v
    except ValueError:
        pass
    iso = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        # 兜底常见格式
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S",
                    "%Y-%m-%dT%H:%M:%S"):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
        else:
            raise ValueError(f"无法解析时间戳: {raw!r}")
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).timestamp()
    return dt.timestamp()


def load_trajectory(path: str, inspector_col: Optional[str], time_col: Optional[str],
                    x_col: Optional[str], y_col: Optional[str]) -> list[TrajPoint]:
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("轨迹 CSV 没有表头")
        cols = [c.strip() for c in reader.fieldnames]
        ins_k = _pick_key(cols, INSPECTOR_KEYS, inspector_col, "inspector")
        time_k = _pick_key(cols, TIME_KEYS, time_col, "time")
        x_k = _pick_key(cols, X_KEYS, x_col, "x")
        y_k = _pick_key(cols, Y_KEYS, y_col, "y")

        rows: list[TrajPoint] = []
        seen: set[tuple[str, str]] = set()
        for line_no, row in enumerate(reader):
            raw_ts = (row.get(time_k) or "").strip()
            inspector = (row.get(ins_k) or "").strip()
            try:
                x = float(row[x_k])
                y = float(row[y_k])
                epoch = parse_epoch(raw_ts)
            except (KeyError, ValueError) as exc:
                raise ValueError(f"轨迹 CSV 第 {line_no + 2} 行解析失败: {exc}") from exc
            key = (inspector, raw_ts)
            if key in seen:
                raise ValueError(
                    f"巡检员 {inspector!r} 存在重复采样时间 {raw_ts!r}，"
                    "题目要求同一巡检员采样时间唯一")
            seen.add(key)
            rows.append(TrajPoint(inspector, -1, raw_ts, epoch, x, y))

    rows.sort(key=lambda p: (p.inspector, p.epoch_s))
    per_inspector: dict[str, int] = {}
    for p in rows:
        p.point_index = per_inspector.get(p.inspector, 0)
        per_inspector[p.inspector] = p.point_index + 1
    return rows


def _pick_prop(props: dict, keys: list[str], override: Optional[str], label: str,
               fallback: str) -> str:
    if override:
        if override not in props:
            raise ValueError(f"GeoJSON 属性中不存在 {label} 字段 {override!r}")
        return str(props[override])
    lower = {str(k).lower(): k for k in props}
    for key in keys:
        if key.lower() in lower:
            return str(props[lower[key.lower()]])
    return fallback


def load_pipelines(path: str, id_prop: Optional[str], start_prop: Optional[str],
                   end_prop: Optional[str]) -> list[Segment]:
    with open(path, "r", encoding="utf-8-sig") as f:
        gj = json.load(f)
    if gj.get("type") != "FeatureCollection":
        raise ValueError("管线 GeoJSON 顶层需为 FeatureCollection")

    segments: list[Segment] = []
    seen_ids: set[str] = set()
    for idx, feat in enumerate(gj.get("features", [])):
        if feat.get("type") != "Feature" or feat.get("geometry", {}).get("type") != "LineString":
            raise ValueError(f"第 {idx} 个要素不是 LineString Feature")
        coords = [(float(a), float(b)) for a, b in feat["geometry"]["coordinates"]]
        if len(coords) < 2:
            raise ValueError(f"第 {idx} 个要素折线顶点少于 2 个")
        props = feat.get("properties") or {}
        fallback_id = str(props.get("id", f"segment_{idx}"))
        seg_id = _pick_prop(props, SEG_ID_KEYS, id_prop, "区段ID", fallback_id)
        if seg_id in seen_ids:
            raise ValueError(f"区段 ID 重复: {seg_id!r}")
        seen_ids.add(seg_id)
        start_node = _pick_prop(props, START_KEYS, start_prop, "起点节点", f"{seg_id}:start")
        end_node = _pick_prop(props, END_KEYS, end_prop, "终点节点", f"{seg_id}:end")

        cum = [0.0]
        for i in range(1, len(coords)):
            cum.append(cum[-1] + _dist(*coords[i - 1], *coords[i]))
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        segments.append(Segment(
            seg_id=seg_id, start_node=start_node, end_node=end_node,
            coords=coords, cum=cum, length=cum[-1],
            bbox=(min(xs), min(ys), max(xs), max(ys)),
            nodes={start_node, end_node},
        ))
    if not segments:
        raise ValueError("管线 GeoJSON 中没有任何区段")
    return segments


# ---- 拓扑与转移 -------------------------------------------------------------

class Topology:
    def __init__(self, segments: list[Segment]):
        self.by_id = {s.seg_id: s for s in segments}
        self.node_to_segs: dict[str, set[str]] = {}
        for s in segments:
            self.node_to_segs.setdefault(s.start_node, set()).add(s.seg_id)
            self.node_to_segs.setdefault(s.end_node, set()).add(s.seg_id)

    def shared_nodes(self, s1: str, s2: str) -> set[str]:
        return self.by_id[s1].nodes & self.by_id[s2].nodes

    def travel_m(self, s1: str, arc1: float, s2: str, arc2: float) -> float:
        """沿管线从 (s1, arc1) 走到 (s2, arc2) 的最短实际里程；不可达返回 inf。"""
        if s1 == s2:
            return abs(arc2 - arc1)
        nodes = self.shared_nodes(s1, s2)
        if not nodes:
            return math.inf
        seg1, seg2 = self.by_id[s1], self.by_id[s2]
        best = math.inf
        for node in nodes:
            part1 = arc1 if node == seg1.start_node else (
                seg1.length - arc1 if node == seg1.end_node else math.inf)
            part2 = arc2 if node == seg2.start_node else (
                seg2.length - arc2 if node == seg2.end_node else math.inf)
            best = min(best, part1 + part2)
        return best


def mm_round(dist_m: float) -> int:
    """米 -> 整数毫米，四舍五入（半值向上）。"""
    return int(math.floor(dist_m * 1000.0 + 0.5))


# ---- 核心匹配 ---------------------------------------------------------------

@dataclass
class Block:
    block_id: str
    points: list[TrajPoint]
    layers: list[dict[str, State]]
    cut_reason: Optional[str] = None
    cut_detail: str = ""


@dataclass
class BreakRecord:
    inspector: str
    block_id: str
    point_index: Optional[int]
    timestamp: str
    reason: str
    detail: str


def attach_candidates(points: list[TrajPoint], index: SegmentIndex,
                      radius: float) -> None:
    for p in points:
        candidates: list[Projection] = []
        nearest: Optional[Projection] = None
        for seg in index.query(p.x, p.y):
            proj = project_on_segment(p.x, p.y, seg)
            if nearest is None or proj.dist_m < nearest.dist_m - EPS or (
                abs(proj.dist_m - nearest.dist_m) <= EPS
                and proj.arc_m < nearest.arc_m
            ):
                nearest = proj
            if proj.dist_m <= radius + EPS:
                candidates.append(proj)
        candidates.sort(key=lambda q: (round(q.dist_m, 9), round(q.arc_m, 9), q.seg_id))
        p.candidates = candidates
        p.nearest_overall = nearest


def build_first_layer(pt: TrajPoint) -> dict[str, State]:
    layer: dict[str, State] = {}
    for cand in pt.candidates:
        mm = mm_round(cand.dist_m)
        layer[cand.seg_id] = State(cost_mm=mm, arc_m=cand.arc_m, mm=mm)
    return layer


def advance_layer(prev_pt: TrajPoint, cur_pt: TrajPoint,
                  prev_layer: dict[str, State], topo: Topology,
                  speed_mps: float) -> dict[str, State]:
    """由上一层增量构造下一层；同区段仅保留最小代价状态（其余被支配）。"""
    dt = cur_pt.epoch_s - prev_pt.epoch_s
    budget = dt * speed_mps
    new_layer: dict[str, State] = {}
    for cand in cur_pt.candidates:
        t = cand.seg_id
        mm = mm_round(cand.dist_m)
        best: Optional[State] = None
        for s, prev_state in prev_layer.items():
            travel = topo.travel_m(s, prev_state.arc_m, t, cand.arc_m)
            if travel <= budget + EPS:
                cost = prev_state.cost_mm + mm
                if best is None or cost < best.cost_mm:
                    best = State(cost_mm=cost, arc_m=cand.arc_m, mm=mm,
                                 prev_seg=s)
        if best is not None:
            new_layer[t] = best
    return new_layer


def solve_block(block_points: list[TrajPoint], topo: Topology,
                speed_mps: float) -> list[dict[str, State]]:
    """对一段轨迹做前向 DP，返回逐层状态；最后一层为空即该段不可行。"""
    layers = [build_first_layer(block_points[0])]
    for i in range(1, len(block_points)):
        new_layer = advance_layer(block_points[i - 1], block_points[i],
                                  layers[-1], topo, speed_mps)
        layers.append(new_layer)
        if not new_layer:
            break
    return layers


def near_optimal_sets(block_points: list[TrajPoint],
                      layers: list[dict[str, State]], topo: Topology,
                      speed_mps: float, tol_mm: int) -> list[set[str]]:
    """前向最小代价 + 反向最小后缀，圈定总偏差 <= 最优 + tol 的路径上各区段集合。"""
    n = len(layers)
    optimum = min(st.cost_mm for st in layers[-1].values())
    threshold = optimum + tol_mm

    # 注：layers[k] 中的状态均由前向 DP 保证可达；inf 仅在理论上的断链情形出现，
    # 此时 cost + inf 必然超阈值，该状态不会进入近优集合。
    suffix: list[dict[str, float]] = [dict() for _ in range(n)]
    for s in layers[-1]:
        suffix[-1][s] = 0.0
    for k in range(n - 2, -1, -1):
        dt = block_points[k + 1].epoch_s - block_points[k].epoch_s
        budget = dt * speed_mps
        for s, st in layers[k].items():
            best = math.inf
            for t, nxt in layers[k + 1].items():
                travel = topo.travel_m(s, st.arc_m, t, nxt.arc_m)
                if travel <= budget + EPS:
                    val = nxt.mm + suffix[k + 1][t]
                    best = min(best, val)
            suffix[k][s] = best

    sets: list[set[str]] = []
    for k in range(n):
        ok = {s for s, st in layers[k].items()
              if math.isfinite(suffix[k][s])
              and st.cost_mm + suffix[k][s] <= threshold}
        sets.append(ok)
    return sets


def min_travel_between(prev_pt: TrajPoint, cur_pt: TrajPoint, topo: Topology) -> float:
    best = math.inf
    for a in prev_pt.candidates:
        for b in cur_pt.candidates:
            best = min(best, topo.travel_m(a.seg_id, a.arc_m, b.seg_id, b.arc_m))
    return best


def run(points: list[TrajPoint], topo: Topology, radius: float, max_gap_s: float,
        speed_mps: float, tol_mm: int):
    """返回 (blocks, breaks, point_block_info, point_nearopt)。"""
    attach_candidates(points, SegmentIndex(list(topo.by_id.values()), radius), radius)

    blocks: list[Block] = []
    breaks: list[BreakRecord] = []
    # 每个点归属到的 block 序号（None = 被排除的点）
    point_block: dict[int, Optional[str]] = {}
    point_nearopt: dict[int, set[str]] = {}

    for inspector in sorted({p.inspector for p in points}):
        seq = [p for p in points if p.inspector == inspector]
        block_no = 0
        cur: list[TrajPoint] = []
        cur_layers: list[dict[str, State]] = []

        def finalize(reason: Optional[str], detail: str) -> Optional[str]:
            nonlocal block_no, cur, cur_layers
            if not cur:
                return None
            block_no += 1
            bid = f"{inspector}#B{block_no:03d}"
            blocks.append(Block(bid, list(cur), cur_layers, reason, detail))
            for p in cur:
                point_block[id(p)] = bid
            cur, cur_layers = [], []
            return bid

        for j, pt in enumerate(seq):
            # 规则 4a：无候选 -> 切断，该点排除
            if not pt.candidates:
                closed_bid = finalize(None, "")
                point_block[id(pt)] = None
                nearest = pt.nearest_overall
                detail = ("15 米内无候选区段" +
                          (f"；最近区段 {nearest.seg_id} 距离 {nearest.dist_m:.3f} 米"
                           if nearest else ""))
                breaks.append(BreakRecord(
                    inspector, closed_bid or "",
                    pt.point_index, pt.timestamp_raw, "no_candidate", detail))
                continue

            if not cur:
                cur = [pt]
                cur_layers = [build_first_layer(pt)]
                continue

            # 规则 4b：超 45 秒空档 -> 切断
            dt = pt.epoch_s - seq[j - 1].epoch_s
            if dt > max_gap_s + EPS:
                closed_bid = finalize(None, "")
                breaks.append(BreakRecord(
                    inspector, closed_bid or "", pt.point_index, pt.timestamp_raw,
                    "time_gap", f"与上一点间隔 {dt:.3f} 秒 > {max_gap_s:g} 秒"))
                cur = [pt]
                cur_layers = [build_first_layer(pt)]
                continue

            # 规则 4c：增量延伸一层，不可行则在该点之前切开
            new_layer = advance_layer(cur[-1], pt, cur_layers[-1], topo, speed_mps)
            if not new_layer:
                min_travel = min_travel_between(seq[j - 1], pt, topo)
                budget = dt * speed_mps
                travel_txt = "不可达（无共享端点且非同一区段）" if math.isinf(min_travel) \
                    else f"候选间最短管线里程 {min_travel:.3f} 米"
                detail = (f"间隔 {dt:.3f} 秒，可行走预算 {budget:.3f} 米，{travel_txt}；"
                          "加入该点后前序所有路径均无法延续")
                closed_bid = finalize("infeasible_transition", detail)
                breaks.append(BreakRecord(
                    inspector, closed_bid or "", pt.point_index, pt.timestamp_raw,
                    "infeasible_transition", detail))
                cur = [pt]
                cur_layers = [build_first_layer(pt)]
            else:
                cur.append(pt)
                cur_layers.append(new_layer)

        finalize(None, "")

    # 近优路径集合
    for blk in blocks:
        sets = near_optimal_sets(blk.points, blk.layers, topo, speed_mps, tol_mm)
        for p, s in zip(blk.points, sets):
            point_nearopt[id(p)] = s

    return blocks, breaks, point_block, point_nearopt


# ---- 输出 -------------------------------------------------------------------

def fmt_candidates(cands: list[Projection]) -> str:
    return ";".join(f"{c.seg_id}|{c.dist_m:.3f}|{c.arc_m:.3f}" for c in cands)


def write_outputs(out_dir: str, points: list[TrajPoint], blocks: list[Block],
                  breaks: list[BreakRecord], point_block: dict,
                  point_nearopt: dict, tol_mm: int,
                  radius: float, max_gap_s: float,
                  speed_mps: float) -> tuple[str, str, str, int]:
    os.makedirs(out_dir, exist_ok=True)

    in_block_idx: dict[int, int] = {}
    for blk in blocks:
        for i, p in enumerate(blk.points):
            in_block_idx[id(p)] = i

    # 1) 逐点归属
    path1 = os.path.join(out_dir, "point_assignment.csv")
    with open(path1, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "inspector_id", "point_index", "block_id", "in_block_index",
            "timestamp", "x_m", "y_m", "status", "segment_id",
            "candidate_count", "candidates_segment|dist_m|arc_m",
            "near_optimal_segments", "note",
        ])
        for p in points:
            bid = point_block.get(id(p))
            if bid is None and not p.candidates:
                w.writerow([
                    p.inspector, p.point_index, "", "", p.timestamp_raw,
                    f"{p.x:.3f}", f"{p.y:.3f}", "excluded", "", 0,
                    fmt_candidates(p.candidates), "",
                    "no candidate within radius; trajectory cut",
                ])
                continue
            nearopt = point_nearopt.get(id(p), set())
            if len(nearopt) == 1:
                status, seg = "confirmed", next(iter(nearopt))
                note = ""
            else:
                status, seg = "pending", ""
                note = (f"近优路径(最优+{tol_mm}mm)上出现 {len(nearopt)} 个区段，"
                        "需人工核对")
            w.writerow([
                p.inspector, p.point_index, bid, in_block_idx.get(id(p), ""),
                p.timestamp_raw, f"{p.x:.3f}", f"{p.y:.3f}", status, seg,
                len(p.candidates), fmt_candidates(p.candidates),
                "|".join(sorted(nearopt)), note,
            ])

    # 2) 区段到访：同 block 内连续确认同一区段
    path2 = os.path.join(out_dir, "segment_visits.csv")
    visit_rows = []
    for blk in blocks:
        run_seg: Optional[str] = None
        run_pts: list[TrajPoint] = []

        def flush() -> None:
            nonlocal run_seg, run_pts
            if run_seg is not None and run_pts:
                visit_rows.append([
                    run_pts[0].inspector, blk.block_id, run_seg,
                    run_pts[0].timestamp_raw, run_pts[-1].timestamp_raw,
                    len(run_pts), run_pts[0].point_index, run_pts[-1].point_index,
                ])
            run_seg, run_pts = None, []

        for p in blk.points:
            nearopt = point_nearopt.get(id(p), set())
            confirmed = next(iter(nearopt)) if len(nearopt) == 1 else None
            if confirmed is not None and confirmed == run_seg:
                run_pts.append(p)
            else:
                flush()
                if confirmed is not None:
                    run_seg, run_pts = confirmed, [p]
        flush()

    with open(path2, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["inspector_id", "block_id", "segment_id", "start_time",
                    "end_time", "point_count", "first_point_index",
                    "last_point_index"])
        w.writerows(visit_rows)

    # 3) 轨迹切断明细
    path3 = os.path.join(out_dir, "trajectory_breaks.csv")
    with open(path3, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["inspector_id", "ended_block_id", "break_at_point_index",
                    "break_at_time", "reason", "detail"])
        for b in breaks:
            w.writerow([b.inspector, b.block_id, b.point_index, b.timestamp,
                        b.reason, b.detail])

    # 4) 机器可读的汇总 JSON
    summary = {
        "parameters": {
            "candidate_radius_m": radius,
            "max_gap_s": max_gap_s,
            "speed_mps": speed_mps,
            "near_optimal_tolerance_mm": tol_mm,
        },
        "totals": {
            "points": len(points),
            "blocks": len(blocks),
            "visits": len(visit_rows),
            "breaks": len(breaks),
            "confirmed": sum(
                1 for p in points
                if len(point_nearopt.get(id(p), set())) == 1),
            "pending": sum(
                1 for p in points if p.candidates
                and len(point_nearopt.get(id(p), set())) > 1),
            "excluded": sum(1 for p in points if not p.candidates),
        },
        "blocks": [
            {
                "block_id": b.block_id,
                "inspector_id": b.points[0].inspector,
                "point_count": len(b.points),
                "start_time": b.points[0].timestamp_raw,
                "end_time": b.points[-1].timestamp_raw,
                "optimal_total_deviation_mm": min(
                    st.cost_mm for st in b.layers[-1].values()),
            }
            for b in blocks
        ],
    }
    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    return path1, path2, path3, len(visit_rows)


# ---- CLI --------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="巡检轨迹对管线区段的逐点归属与到访明细生成")
    ap.add_argument("--trajectory", required=True, help="轨迹 CSV 路径")
    ap.add_argument("--pipelines", required=True, help="管线 GeoJSON 路径")
    ap.add_argument("--outdir", required=True, help="输出目录")
    ap.add_argument("--radius", type=float, default=DEFAULT_RADIUS_M,
                    help=f"候选区段半径（米），默认 {DEFAULT_RADIUS_M:g}")
    ap.add_argument("--max-gap", type=float, default=DEFAULT_MAX_GAP_S,
                    help=f"切断空档秒数，默认 {DEFAULT_MAX_GAP_S:g}")
    ap.add_argument("--speed", type=float, default=DEFAULT_SPEED_MPS,
                    help=f"最大行进速度（米/秒），默认 {DEFAULT_SPEED_MPS:g}")
    ap.add_argument("--tolerance-mm", type=int, default=DEFAULT_TOL_MM,
                    help=f"近优路径容忍总偏差（毫米），默认 {DEFAULT_TOL_MM}")
    ap.add_argument("--inspector-col", default=None)
    ap.add_argument("--time-col", default=None)
    ap.add_argument("--x-col", default=None)
    ap.add_argument("--y-col", default=None)
    ap.add_argument("--segment-id-prop", default=None)
    ap.add_argument("--start-prop", default=None)
    ap.add_argument("--end-prop", default=None)
    return ap


def main(argv: Optional[list[str]] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    segments = load_pipelines(args.pipelines, args.segment_id_prop,
                              args.start_prop, args.end_prop)
    points = load_trajectory(args.trajectory, args.inspector_col,
                             args.time_col, args.x_col, args.y_col)
    topo = Topology(segments)
    blocks, breaks, point_block, point_nearopt = run(
        points, topo, args.radius, args.max_gap, args.speed, args.tolerance_mm)
    path1, path2, path3, n_visits = write_outputs(
        args.outdir, points, blocks, breaks, point_block, point_nearopt,
        args.tolerance_mm, args.radius, args.max_gap, args.speed)
    print("输出文件:")
    for p in (path1, path2, path3):
        print(f"  - {p}")
    print(f"  - {os.path.join(args.outdir, 'summary.json')}")
    n_pending = sum(1 for p in points if p.candidates
                    and len(point_nearopt.get(id(p), set())) > 1)
    n_excluded = sum(1 for p in points if not p.candidates)
    print(f"轨迹点 {len(points)} 个（确认 {len(points) - n_pending - n_excluded}，"
          f"待核对 {n_pending}，排除 {n_excluded}）；"
          f"轨迹段 {len(blocks)} 段，到访 {n_visits} 次，切断 {len(breaks)} 次")
    return 0


if __name__ == "__main__":
    sys.exit(main())
