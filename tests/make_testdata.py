#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成合成测试数据：轨迹 CSV + 管线 GeoJSON（同一套米制平面坐标）。

管线网络（节点 ID 为 n0..n7）：
  S1  n0(0,0)    -> n1(200,0)     东西向
  S2  n2(0,40)   -> n3(200,40)    与 S1 平行（间距 40m，互不相连）
  S3  n1(200,0)  -> n4(200,120)   与 S1 共享 n1
  S4  n3(200,40) -> n4(200,120)   与 S2 共享 n3，与 S3 平行
  S5  n4(200,120)-> n5(320,120)
  S6  n5(320,120)-> n6(320,220)
  S7  n4(200,120)-> n7(120,120)

巡检员 A：连续可行主路径 S1→S3→S5→S6（含共享端点投影并列），
         随后依次制造 time_gap、no_candidate、infeasible_transition 三类切断。
巡检员 B：在四岔节点 n4 附近制造多候选“待核对”点，随后沿 S7 连续确认。
所有相邻点步距均 <= 间隔 × 2m/s（除特意设计的超限行）。
"""

import csv
import json
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "testdata")
os.makedirs(OUT, exist_ok=True)

NODES = {
    "n0": (0.0, 0.0), "n1": (200.0, 0.0), "n2": (0.0, 40.0),
    "n3": (200.0, 40.0), "n4": (200.0, 120.0), "n5": (320.0, 120.0),
    "n6": (320.0, 220.0), "n7": (120.0, 120.0),
}
SEG_DEF = [
    ("S1", "n0", "n1"), ("S2", "n2", "n3"), ("S3", "n1", "n4"),
    ("S4", "n3", "n4"), ("S5", "n4", "n5"), ("S6", "n5", "n6"),
    ("S7", "n4", "n7"),
]

features = []
for sid, a, b in SEG_DEF:
    features.append({
        "type": "Feature",
        "properties": {"segment_id": sid, "start_node": a, "end_node": b},
        "geometry": {"type": "LineString",
                     "coordinates": [list(NODES[a]), list(NODES[b])]},
    })
with open(os.path.join(OUT, "pipelines.geojson"), "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection", "features": features},
              f, ensure_ascii=False, indent=2)

BASE = 1_700_000_000.0
rows: list[tuple[str, float, float, float]] = []


def add(ins, t, x, y):
    rows.append((ins, BASE + t, round(x, 3), round(y, 3)))


# ---------------- 巡检员 A ----------------
# S1 上 11 个点：x=10..190，步距 18m/10s（预算 20m，可行），y 带 0.4m 固定偏差
for k in range(11):
    add("A", 10 * k, 10 + 18 * k, 0.4 if k % 2 == 0 else -0.4)
# t=110 恰在共享端点 n1：对 S1、S3 投影距离并列 0，检验里程并列规则
add("A", 110, 200.0, 0.0)
# S3 上 5 个点：y=20..100，步距 20m/10s
for k in range(1, 6):
    add("A", 110 + 10 * k, 200.0 + (0.4 if k % 2 == 0 else -0.4), 20 * k)
# t=170 恰在四岔节点 n4：S3/S4/S5/S7 距离全 0
add("A", 170, 200.0, 120.0)
# S5 上 5 个点：x=220..300
for k in range(1, 6):
    add("A", 170 + 10 * k, 200 + 20 * k, 120.0 + (0.4 if k % 2 == 0 else -0.4))
# t=230 恰在 n5（S5/S6 共享）
add("A", 230, 320.0, 120.0)
# S6 上 3 个点 y=140..180
for k in range(1, 4):
    add("A", 230 + 10 * k, 320.0 + (0.4 if k % 2 == 0 else -0.4), 120 + 20 * k)

# --- 切断 1：time_gap（间隔 50s > 45s）---
add("A", 290, 320.0, 190.0)          # 与上一点 t=260 间隔 30s，正常，S6 上
add("A", 340, 320.0, 200.0)          # 间隔 50s -> time_gap，新 block 起点

# --- 切断 2：no_candidate ---
add("A", 350, 320.0, 210.0)          # S6 上
add("A", 360, 500.0, 500.0)          # 远离全部管线 -> no_candidate，该点排除
add("A", 370, 300.0, 120.0)          # S5 上，重新开始新 block

# --- 切断 3：infeasible_transition（10s 预算 20m，需走管线 80m）---
add("A", 380, 310.0, 120.0)          # S5，靠近 n5
add("A", 390, 320.0, 200.0)          # S6 深处，最短管线里程 80m -> 切断
add("A", 400, 320.0, 205.0)          # 从该点起新 block（S6 上，步距 5m）

# ---------------- 巡检员 B：n4 交汇区多候选，随后 S7 锁定 ----------------
# n4=(200,120)。S3/S4 为竖直线（x=200），S5/S7 为水平线（y=120）。
# 取点 (200, 120-d)：距 S3/S4 为 d（投影在端点），距 S5/S7 也为 d。
for k, d in enumerate((8.0, 6.0, 4.0, 2.0)):
    add("B", 5 * k, 200.0, 120.0 - d)     # 四条线同时候选
add("B", 20, 200.0, 120.0)                # 恰在 n4：四候选距离全 0
# 沿 S7 西行 3 点（步距 15m/10s，预算 20m）
for k in range(1, 4):
    add("B", 20 + 10 * k, 200 - 15 * k,
        120.0 + (0.4 if k % 2 == 0 else -0.4))

with open(os.path.join(OUT, "trajectory.csv"), "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["inspector_id", "timestamp", "x", "y"])
    for ins, t, x, y in sorted(rows, key=lambda r: (r[0], r[1])):
        w.writerow([ins, f"{t:.3f}", x, y])

print(f"wrote {len(rows)} trajectory rows and {len(features)} segments to {OUT}")
