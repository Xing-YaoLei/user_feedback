#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描记录 ↔ 相机照片 匹配工具（修复漏拍导致的编号错配）

输入：
  扫描 CSV   ：扫描ID、档案号、工位、毫秒时间戳
  照片 JSONL ：照片ID、文件路径、工位、毫秒时间戳（与扫描同一时钟）

规则（以工位为单位独立求解）：
  1. 候选边：同工位且 |Δt| <= 窗口（默认 1500ms）。
  2. 每次扫描、每张照片最多用一次（二分图匹配）。
  3. 字典序最优：先最大化匹配数，再最小化已匹配记录的时间差总和。
  4. 只导出“所有最优配法都同意”的配对（必然边）。
  5. 未导出扫描分类：
       no_candidate  —— 窗口内没有任何候选照片
       never_matched —— 有候选，但在所有最优配法中都未匹配
       disputed      —— 最优配法之间存在分歧（有时匹配/配给不同照片）
     分歧扫描会列出其在某个最优配法中被配给的候选照片，供修复员核对。

输出（--out-dir）：
  matches.csv        可导入档案系统的确定配对清单
  review.csv         未匹配扫描及状态、分歧候选照片
  unused_photos.csv  任何最优配法都不会用到的照片（信息性）
"""

import argparse
import csv
import heapq
import json
import os
import sys
from collections import defaultdict

INF = float("inf")


# ---------------------------------------------------------------- 最小费用最大流
def min_cost_max_flow(n_scans, n_photos, edges):
    """扫描->照片 二分图上的最小费用最大流（SSP + 势，费用非负）。

    edges: [(scan_idx, photo_idx, cost)]
    返回 (最大流, 最小费用)。先求最大流，同流值下费用最小——
    正好对应“先匹配数最多，再时间差总和最小”。
    """
    N = 2 + n_scans + n_photos
    S, T = 0, N - 1
    g = [[] for _ in range(N)]  # [to, cap, cost, rev_idx]

    def add(fr, to, cap, cost):
        g[fr].append([to, cap, cost, len(g[to])])
        g[to].append([fr, 0, -cost, len(g[fr]) - 1])

    for i in range(n_scans):
        add(S, 1 + i, 1, 0)
    for j in range(n_photos):
        add(1 + n_scans + j, T, 1, 0)
    for i, j, c in edges:
        add(1 + i, 1 + n_scans + j, 1, c)

    potential = [0] * N
    flow = 0
    cost = 0
    while True:
        dist = [INF] * N
        prevv = [-1] * N
        preve = [-1] * N
        dist[S] = 0
        pq = [(0, S)]
        while pq:
            d, v = heapq.heappop(pq)
            if d > dist[v]:
                continue
            for ei, e in enumerate(g[v]):
                if e[1] > 0:
                    nd = d + e[2] + potential[v] - potential[e[0]]
                    if nd < dist[e[0]]:
                        dist[e[0]] = nd
                        prevv[e[0]] = v
                        preve[e[0]] = ei
                        heapq.heappush(pq, (nd, e[0]))
        if dist[T] == INF:
            break
        for v in range(N):
            if dist[v] < INF:
                potential[v] += dist[v]
        # 单位容量，增广量恒为 1
        v = T
        while v != S:
            e = g[prevv[v]][preve[v]]
            e[1] -= 1
            g[v][e[3]][1] += 1
            v = prevv[v]
        flow += 1
        cost += potential[T]  # 更新后的 potential[T] 即原费用下的最短路
    return flow, cost


# ---------------------------------------------------------------- 工具
def parse_num(s):
    """毫秒时间戳：能解析为整数就用整数（保证费用精确比较），否则浮点。"""
    f = float(s)
    return int(f) if f == int(f) else f


def fmt_dt(x):
    return str(int(x)) if float(x) == int(x) else str(x)


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(
        description="扫描记录与相机照片的最优匹配（漏拍修复）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--scans", required=True, help="扫描记录 CSV 路径")
    ap.add_argument("--photos", required=True, help="照片 JSONL 路径")
    ap.add_argument("--out-dir", required=True, help="输出目录")
    ap.add_argument("--window-ms", type=int, default=1500,
                    help="候选时间窗（毫秒，默认 1500）")
    ap.add_argument("--scan-cols", default="scan_id,archive_id,station,timestamp_ms",
                    help="扫描 CSV 列名，顺序：扫描ID,档案号,工位,时间戳")
    ap.add_argument("--photo-cols", default="photo_id,file_path,station,timestamp_ms",
                    help="照片 JSONL 键名，顺序：照片ID,文件路径,工位,时间戳")
    args = ap.parse_args()

    s_id, s_arch, s_sta, s_ts = [c.strip() for c in args.scan_cols.split(",")]
    p_id, p_path, p_sta, p_ts = [c.strip() for c in args.photo_cols.split(",")]

    # ---- 读取扫描 CSV
    scans = []
    with open(args.scans, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            scans.append({
                "scan_id": row[s_id].strip(),
                "archive_id": row[s_arch].strip(),
                "station": row[s_sta].strip(),
                "ts": parse_num(row[s_ts]),
            })

    # ---- 读取照片 JSONL
    photos = []
    with open(args.photos, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            photos.append({
                "photo_id": str(o[p_id]).strip(),
                "file_path": str(o[p_path]).strip(),
                "station": str(o[p_sta]).strip(),
                "ts": parse_num(o[p_ts]),
            })

    # ---- 按工位分组
    scans_by_sta = defaultdict(list)
    for s in scans:
        scans_by_sta[s["station"]].append(s)
    photos_by_sta = defaultdict(list)
    for p in photos:
        photos_by_sta[p["station"]].append(p)

    matches = []   # 确定配对（可导入）
    review = []    # 未匹配扫描
    unused = []    # 任何最优配法都用不到的照片

    stations = sorted(set(scans_by_sta) | set(photos_by_sta))
    summary = []

    for sta in stations:
        ss = scans_by_sta.get(sta, [])
        ps = photos_by_sta.get(sta, [])
        ns, np_ = len(ss), len(ps)

        # 候选边：同工位（已分组）且 |Δt| <= 窗口
        edges = []  # (scan_idx, photo_idx, dt)
        for i, s in enumerate(ss):
            for j, p in enumerate(ps):
                dt = abs(s["ts"] - p["ts"])
                if dt <= args.window_ms:
                    edges.append((i, j, dt))

        k0, c0 = min_cost_max_flow(ns, np_, edges)

        # 对每条候选边做两个测试：
        #   in_some   —— 是否出现在某个最优配法中（强制该边后仍可达全局最优）
        #   essential —— 是否出现在所有最优配法中（去掉该边后最优变差）
        in_some = [False] * len(edges)
        essential = [False] * len(edges)
        for idx, (i, j, dt) in enumerate(edges):
            rest = [e for e in edges if e[0] != i and e[1] != j]
            kr, cr = min_cost_max_flow(ns, np_, rest)
            in_some[idx] = (kr + 1 == k0 and cr + dt == c0)
            without = edges[:idx] + edges[idx + 1:]
            k1, c1 = min_cost_max_flow(ns, np_, without)
            essential[idx] = (k1, c1) != (k0, c0)

        photo_used_somewhere = [False] * np_
        scan_essential_edge = [None] * ns
        scan_some_edges = [[] for _ in range(ns)]
        for idx, (i, j, dt) in enumerate(edges):
            if in_some[idx]:
                scan_some_edges[i].append((j, dt))
                photo_used_somewhere[j] = True
            if essential[idx]:
                scan_essential_edge[i] = (j, dt)

        n_matched = n_no_cand = n_never = n_disputed = 0
        for i, s in enumerate(ss):
            if scan_essential_edge[i] is not None:
                j, dt = scan_essential_edge[i]
                p = ps[j]
                matches.append({
                    "station": sta, "scan_id": s["scan_id"],
                    "archive_id": s["archive_id"],
                    "scan_timestamp_ms": s["ts"],
                    "photo_id": p["photo_id"], "photo_file_path": p["file_path"],
                    "photo_timestamp_ms": p["ts"], "time_diff_ms": dt,
                })
                n_matched += 1
                continue

            cands = [(j, dt) for (ii, j, dt) in edges if ii == i]
            if not cands:
                status = "no_candidate"      # 窗口内没有候选照片
                n_no_cand += 1
            elif not scan_some_edges[i]:
                status = "never_matched"     # 有候选，但所有最优配法都不匹配它
                n_never += 1
            else:
                status = "disputed"          # 最优配法之间有分歧
                n_disputed += 1

            def fmt(pairs):
                return "; ".join(
                    f"{ps[j]['photo_id']}|{ps[j]['file_path']}|dt={fmt_dt(dt)}ms"
                    for j, dt in sorted(pairs, key=lambda x: (x[1], ps[x[0]]["photo_id"]))
                )

            review.append({
                "station": sta, "scan_id": s["scan_id"],
                "archive_id": s["archive_id"],
                "scan_timestamp_ms": s["ts"], "status": status,
                "disputed_photos": fmt(scan_some_edges[i]) if status == "disputed" else "",
                "all_candidate_photos": fmt(cands),
            })

        for j, p in enumerate(ps):
            if not photo_used_somewhere[j]:
                unused.append({
                    "station": sta, "photo_id": p["photo_id"],
                    "file_path": p["file_path"], "photo_timestamp_ms": p["ts"],
                })

        summary.append((sta, ns, np_, k0, n_matched, n_no_cand, n_never, n_disputed))

    # ---- 写出
    os.makedirs(args.out_dir, exist_ok=True)

    def wcsv(name, fieldnames, rows):
        path = os.path.join(args.out_dir, name)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            for r in rows:
                w.writerow(r)
        return path

    p1 = wcsv("matches.csv",
              ["station", "scan_id", "archive_id", "scan_timestamp_ms",
               "photo_id", "photo_file_path", "photo_timestamp_ms", "time_diff_ms"],
              matches)
    p2 = wcsv("review.csv",
              ["station", "scan_id", "archive_id", "scan_timestamp_ms", "status",
               "disputed_photos", "all_candidate_photos"],
              review)
    p3 = wcsv("unused_photos.csv",
              ["station", "photo_id", "file_path", "photo_timestamp_ms"],
              unused)

    # ---- 摘要
    print("工位汇总：")
    print(f"{'工位':<10}{'扫描':>6}{'照片':>6}{'最优匹配数':>10}{'已导出':>8}"
          f"{'无候选':>8}{'永不匹配':>9}{'有分歧':>8}")
    for sta, ns, np_, k0, nm, nc, nv, nd in summary:
        print(f"{sta:<10}{ns:>6}{np_:>6}{k0:>10}{nm:>8}{nc:>8}{nv:>9}{nd:>8}")
    print(f"\n已写出：\n  {p1}  （{len(matches)} 对确定配对，可导入）"
          f"\n  {p2}  （{len(review)} 条待核对扫描）"
          f"\n  {p3}  （{len(unused)} 张未被任何最优配法使用的照片）")


if __name__ == "__main__":
    main()
