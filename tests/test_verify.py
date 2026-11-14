#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单元/边界测试：直接调用 match_inspection 的函数，不依赖外部数据文件。

运行：python3 -I tests/test_verify.py
"""

import csv
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import match_inspection as M  # noqa: E402


def make_segment(sid, coords, start="a", end="b"):
    cum = [0.0]
    for i in range(1, len(coords)):
        cum.append(cum[-1] + M._dist(*coords[i - 1], *coords[i]))
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return M.Segment(sid, start, end, coords, cum, cum[-1],
                     (min(xs), min(ys), max(xs), max(ys)), {start, end})


def test_projection_basic_and_tie():
    seg = make_segment("L", [(0.0, 0.0), (100.0, 0.0)])
    # 垂足在线段内部
    p = M.project_on_segment(30.0, 5.0, seg)
    assert abs(p.dist_m - 5.0) < 1e-9 and abs(p.arc_m - 30.0) < 1e-9
    # 投影落在起点外侧 -> 钳到端点
    p = M.project_on_segment(-10.0, 0.0, seg)
    assert abs(p.dist_m - 10.0) < 1e-9 and p.arc_m == 0.0
    # 多段折线：到两个顶点等距时取里程更短者
    bend = make_segment("P", [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)])
    q = M.project_on_segment(5.0, 5.0, bend)   # 到 (5,0) 与 (10,5) 均为 5m
    assert abs(q.dist_m - 5.0) < 1e-9 and abs(q.arc_m - 5.0) < 1e-9
    print("ok: test_projection_basic_and_tie")


def test_mm_rounding():
    assert M.mm_round(0.0) == 0
    assert M.mm_round(1.0) == 1000
    assert M.mm_round(0.0004) == 0          # 0.4mm 舍掉
    assert M.mm_round(0.0005) == 1          # 半值向上
    assert M.mm_round(0.0006) == 1
    assert M.mm_round(2.345678) == 2346
    print("ok: test_mm_rounding")


def test_radius_boundary_and_topo():
    s1 = make_segment("S1", [(0.0, 0.0), (100.0, 0.0)], "n0", "n1")
    s2 = make_segment("S2", [(0.0, 30.0), (100.0, 30.0)], "n2", "n3")
    topo = M.Topology([s1, s2])
    # 无共享端点 -> 不可达
    assert M.topo_unreachable(topo)
    # 点 (50,15)：距两条线均 15m，半径边界（含等号）两侧都保留
    pt = M.TrajPoint("X", 0, "t0", 0.0, 50.0, 15.0)
    idx = M.SegmentIndex([s1, s2], 15.0)
    M.attach_candidates([pt], idx, 15.0)
    assert {c.seg_id for c in pt.candidates} == {"S1", "S2"}
    # 并列时 nearest_overall 取里程最短（两者里程都为 50，再按 arc 相同 -> 任意一个，
    # 但距离必须等于 15）
    assert abs(pt.nearest_overall.dist_m - 15.0) < 1e-9
    # 15.001m：S1 仍在范围内，S2（30-15.001=14.999m 也在！）-> 改为更远的点
    # 取 y=16：距 S1 16m 超界，距 S2 14m 仍候选，验证严格超界的一侧被剔除
    pt2 = M.TrajPoint("X", 1, "t1", 1.0, 50.0, 16.0)
    M.attach_candidates([pt2], idx, 15.0)
    assert {c.seg_id for c in pt2.candidates} == {"S2"}
    # 两条都超界 -> 无候选
    pt3 = M.TrajPoint("X", 2, "t2", 2.0, 50.0, 60.0)
    M.attach_candidates([pt3], idx, 15.0)
    assert pt3.candidates == []
    print("ok: test_radius_boundary_and_topo")


def test_shared_node_switch_and_reverse():
    s1 = make_segment("S1", [(0.0, 0.0), (100.0, 0.0)], "n0", "n1")
    s2 = make_segment("S2", [(100.0, 0.0), (100.0, 80.0)], "n1", "n2")
    topo = M.Topology([s1, s2])
    # 经共享端点 n1：arc1=90 -> n1 10m，n1 -> arc2=20 共 30m
    d = topo.travel_m("S1", 90.0, "S2", 20.0)
    assert abs(d - 30.0) < 1e-9
    # 同区段反向行走
    d = topo.travel_m("S1", 80.0, "S1", 30.0)
    assert abs(d - 50.0) < 1e-9
    # 不相连区段
    s3 = make_segment("S3", [(200.0, 200.0), (210.0, 200.0)], "n9", "n10")
    topo3 = M.Topology([s1, s3])
    assert M.math.isinf(topo3.travel_m("S1", 10.0, "S3", 5.0))
    print("ok: test_shared_node_switch_and_reverse")


def test_near_optimal_tolerance_and_pending():
    """两条等长平行且两端各自相连的管线，构造偏差差 0.3m 的双路径 -> 待核对。"""
    s1 = make_segment("S1", [(0.0, 0.0), (100.0, 0.0)], "n0", "n1")
    s2 = make_segment("S2", [(0.0, 10.0), (100.0, 10.0)], "n0", "n1")  # 共享两端节点
    topo = M.Topology([s1, s2])
    pts = [
        M.TrajPoint("X", 0, "0", 0.0, 10.0, 5.0),    # 两线各 5m
        M.TrajPoint("X", 1, "10", 10.0, 20.0, 4.7),  # S1:4.7m S2:5.3m
        M.TrajPoint("X", 2, "20", 20.0, 30.0, 5.0),
    ]
    idx = M.SegmentIndex([s1, s2], 15.0)
    M.attach_candidates(pts, idx, 15.0)
    blocks, breaks, pb, pno = M.run(pts, topo, 15.0, 45.0, 2.0, 500)
    assert len(blocks) == 1 and not breaks
    # 两条路径总偏差差 600mm（单点差 0.6m），超出 500mm 容忍 -> 全部确认 S1
    sets = [pno[id(p)] for p in pts]
    assert all(s == {"S1"} for s in sets), sets

    # 缩小偏差差到 200mm：两路径都在最优+500mm 内 -> 待核对
    pts2 = [
        M.TrajPoint("Y", 0, "0", 0.0, 10.0, 5.0),
        M.TrajPoint("Y", 1, "10", 10.0, 20.0, 4.9),  # 差 0.2m
        M.TrajPoint("Y", 2, "20", 20.0, 30.0, 5.0),
    ]
    M.attach_candidates(pts2, idx, 15.0)
    _, _, _, pno2 = M.run(pts2, topo, 15.0, 45.0, 2.0, 500)
    sets2 = [pno2[id(p)] for p in pts2]
    assert all(s == {"S1", "S2"} for s in sets2), sets2
    print("ok: test_near_optimal_tolerance_and_pending")


def test_speed_budget_cut():
    s1 = make_segment("S1", [(0.0, 0.0), (1000.0, 0.0)], "n0", "n1")
    topo = M.Topology([s1])
    pts = [
        M.TrajPoint("Z", 0, "0", 0.0, 0.0, 0.0),
        M.TrajPoint("Z", 1, "10", 10.0, 30.0, 0.0),   # 10s 走 30m > 20m 预算
    ]
    idx = M.SegmentIndex([s1], 15.0)
    M.attach_candidates(pts, idx, 15.0)
    blocks, breaks, _, _ = M.run(pts, topo, 15.0, 45.0, 2.0, 500)
    assert len(blocks) == 2
    assert breaks and breaks[0].reason == "infeasible_transition"
    # 边界：恰好 20m / 10s 可行
    pts3 = [
        M.TrajPoint("Z", 0, "0", 0.0, 0.0, 0.0),
        M.TrajPoint("Z", 1, "10", 10.0, 20.0, 0.0),
    ]
    M.attach_candidates(pts3, idx, 15.0)
    blocks3, breaks3, _, _ = M.run(pts3, topo, 15.0, 45.0, 2.0, 500)
    assert len(blocks3) == 1 and not breaks3
    print("ok: test_speed_budget_cut")


def test_end_to_end_csv_roundtrip():
    seg = make_segment("S1", [(0.0, 0.0), (100.0, 0.0)], "n0", "n1")
    with tempfile.TemporaryDirectory() as tmp:
        gj = os.path.join(tmp, "p.geojson")
        with open(gj, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": [{
                "type": "Feature",
                "properties": {"segment_id": "S1", "start_node": "n0",
                               "end_node": "n1"},
                "geometry": {"type": "LineString",
                             "coordinates": [[0, 0], [100, 0]]}}]}, f)
        cs = os.path.join(tmp, "t.csv")
        with open(cs, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["inspector_id", "timestamp", "x", "y"])
            w.writerow(["w1", "2026-11-14T08:00:00Z", 10, 0.3])
            w.writerow(["w1", "2026-11-14T08:00:10Z", 20, 0.3])
        out = os.path.join(tmp, "out")
        rc = M.main(["--trajectory", cs, "--pipelines", gj, "--outdir", out])
        assert rc == 0
        with open(os.path.join(out, "point_assignment.csv"),
                  encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        assert len(rows) == 2 and all(r["status"] == "confirmed" for r in rows)
        assert all(r["segment_id"] == "S1" for r in rows)
        with open(os.path.join(out, "segment_visits.csv"),
                  encoding="utf-8-sig") as f:
            visits = list(csv.DictReader(f))
        assert len(visits) == 1 and visits[0]["point_count"] == "2"
    print("ok: test_end_to_end_csv_roundtrip")


# 小工具：Topology 不可达场景的语义包装
def _unreachable(topo):
    s1, s2 = list(topo.by_id)
    return M.math.isinf(topo.travel_m(s1, 0.0, s2, 0.0))


M.topo_unreachable = staticmethod(_unreachable)


if __name__ == "__main__":
    test_projection_basic_and_tie()
    test_mm_rounding()
    test_radius_boundary_and_topo()
    test_shared_node_switch_and_reverse()
    test_near_optimal_tolerance_and_pending()
    test_speed_budget_cut()
    test_end_to_end_csv_roundtrip()
    print("\n全部测试通过")
