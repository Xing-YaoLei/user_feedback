#!/usr/bin/env python3
"""端到端验证：模拟接口 + 轮询调度器在同一进程运行并自动核对行为。

场景（quick 模式约 30 秒，spec 模式按需求原样使用 30 秒 Retry-After）：
- north：200 -> 429(Retry-After=R) -> 304，验证 429 期间其他园区照常刷新
- south：始终常规 ETag 行为（配合快照推送产生 200/304）
- east：503 -> 503 -> timeout -> 200，验证有上限退避与成功后恢复
- west：验证全局最多 3 个请求在途

核对项：
1. 同一园区请求不重叠（服务端请求记录 + 调度器事件双重核对）
2. 429 后恰好等待 Retry-After 秒才发起下一次请求
3. 304 只记录检查时间、不替换快照；200 发布新快照
4. 5xx / 超时使用有上限的指数退避，成功后恢复常规间隔
5. north 退避期间，south 仍按自己的间隔持续刷新（核心需求）
6. 全局同时在途请求数不超过 3
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field

from shuttle.config import Config, ParkConfig
from shuttle.mock_server import MockShuttleServer, make_etag
from shuttle.poller import Scheduler

TOLERANCE = 0.75  # 线程调度容差（秒）


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str


@dataclass
class _Recorder:
    results: list[CheckResult] = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str) -> None:
        self.results.append(CheckResult(name, ok, detail))

    def report(self) -> bool:
        width = max(len(r.name) for r in self.results)
        print("\n================ 验证结果 ================")
        for r in self.results:
            mark = "PASS" if r.ok else "FAIL"
            print(f"[{mark}] {r.name.ljust(width)}  {r.detail}")
        passed = sum(1 for r in self.results if r.ok)
        print(f"------------------------------------------")
        print(f"{passed}/{len(self.results)} passed")
        return passed == len(self.results)


def _gaps(records: list[dict]) -> list[tuple[float, float, int]]:
    """返回 [(发起间隔, 前一次请求耗时, 前一次状态), ...]，时间取服务端 wall clock。"""
    out = []
    for prev, cur in zip(records, records[1:]):
        gap = cur["time"] - prev["time"]
        out.append((gap, prev["duration"] or 0.0, prev["status"]))
    return out


def _find_gap_after(records: list[dict], status: int, occurrence: int = 1) -> tuple[float, float] | None:
    """找到第 occurrence 次 status 响应之后到下一次请求的间隔与该响应耗时。"""
    seen = 0
    for i, rec in enumerate(records):
        if rec["status"] == status:
            seen += 1
            if seen == occurrence and i + 1 < len(records):
                return records[i + 1]["time"] - rec["time"], rec["duration"] or 0.0
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="班车轮询端到端验证")
    parser.add_argument("--mode", choices=["quick", "spec"], default="quick",
                        help="quick: Retry-After=6s 约 30 秒跑完；spec: Retry-After=30s 按需求原值")
    parser.add_argument("--duration", type=float, default=None, help="覆盖默认运行时长")
    args = parser.parse_args()

    retry_after = 30 if args.mode == "spec" else 6
    duration = args.duration or (38 if args.mode == "spec" else 30)
    backoff_base, backoff_cap = 1.0, 4.0
    intervals = {"north": 2.0, "south": 2.0, "east": 2.0, "west": 2.0}
    timeout = 1.5

    server = MockShuttleServer()
    server.start()
    print(f"mock server: {server.base_url}")

    # ---- 配置四个园区与状态序列 ----------------------------------------
    initial = {"park_id": "x", "arrivals": [{"route": "R1", "eta_minutes": 5}]}
    for pid in ("north", "south", "east", "west"):
        server.add_park(pid, json.loads(json.dumps(initial)), delay=0.05)

    north = server.get_park("north")
    assert north is not None
    north.sequence = ["200", f"429:{retry_after}", "304", "200"]
    north.loop = False

    east = server.get_park("east")
    assert east is not None
    east.sequence = ["503", "503", f"timeout:{timeout + 1.5}", "200", "200"]
    east.loop = False
    east.delay = 0.05

    config = Config(
        max_concurrency=3,
        backoff_base_seconds=backoff_base,
        backoff_cap_seconds=backoff_cap,
        parks=[
            ParkConfig(pid, server.park_url(pid), intervals[pid], timeout)
            for pid in ("north", "south", "east", "west")
        ],
    )
    scheduler = Scheduler(config)
    recorder = _Recorder()

    print(f"运行 {duration:.0f}s（Retry-After={retry_after}s, backoff base={backoff_base} cap={backoff_cap}）...")
    scheduler.start()
    try:
        # 运行中给 south 推一次新快照，制造 200（新 ETag）后再回 304
        time.sleep(6)
        south = server.get_park("south")
        assert south is not None
        with south.lock:
            south.body = {"park_id": "south", "arrivals": [{"route": "R2", "eta_minutes": 9}]}
            south.etag = make_etag(south.body)
        print("  [t=6s] pushed new snapshot to south")

        time.sleep(duration - 6)
    finally:
        scheduler.stop()
        server.stop()

    # ---- 收集数据 -------------------------------------------------------
    records = {pid: server.records(pid) for pid in ("north", "south", "east", "west")}
    for pid, recs in records.items():
        print(f"\n--- {pid} 服务端请求记录 ({len(recs)} 次) ---")
        for r in recs:
            extra = f" retry-after={r['retry_after']}" if r.get("retry_after") is not None else ""
            inm = r.get("if_none_match") or "-"
            print(f"  #{r['seq']:>2} t={r['time']:<12} status={str(r['status']):<7} "
                  f"duration={r['duration']} if-none-match={inm[:18]}{extra} {r.get('note') or ''}")

    status = {row["park_id"]: row for row in scheduler.status()}
    events = scheduler.events()
    t0 = events[0]["mono"] if events else 0.0

    # ---- 核对 1：同一园区请求不重叠（调度事件） -------------------------
    for pid in ("north", "south", "east", "west"):
        pid_events = [e for e in events if e["park_id"] == pid]
        overlap = False
        detail_bits = []
        for d, c in zip(pid_events[0::2], pid_events[1::2]):
            if d["kind"] != "dispatch" or c["kind"] != "complete":
                overlap = True
            elif c["mono"] < d["mono"]:
                overlap = True
            else:
                detail_bits.append(f"{c['mono'] - d['mono']:.2f}s")
        recorder.check(
            f"{pid}: 同园区请求不重叠",
            not overlap and len(pid_events) >= 2 and len(pid_events) % 2 == 0,
            f"{len(pid_events) // 2} 次请求，在途时长 {', '.join(detail_bits[:6])}",
        )

    # ---- 核对 2：429 后按 Retry-After 排期 ------------------------------
    found = _find_gap_after(records["north"], 429)
    if found is None:
        recorder.check("north: 429 按 Retry-After 等待", False, "未观察到 429 响应")
    else:
        gap, duration429 = found
        expected = retry_after + duration429
        recorder.check(
            "north: 429 按 Retry-After 等待",
            abs(gap - expected) <= TOLERANCE and gap >= retry_after - 0.1,
            f"下次请求间隔 {gap:.2f}s（Retry-After={retry_after}s + 请求耗时 {duration429:.2f}s，期望 ~{expected:.2f}s）",
        )

    # ---- 核对 3（核心）：north 退避期间 south 仍按自己的间隔刷新 --------
    north_recs = records["north"]
    r429 = next((r for r in north_recs if r["status"] == 429), None)
    r_after = next((r for r in north_recs if r["status"] is not None and r["time"] > (r429["time"] if r429 else 0)),
                   None)
    if r429 is None or r_after is None:
        recorder.check("跨园区: north 退避时 south 照常刷新", False, "north 的 429/后续请求不完整")
    else:
        window = [r for r in records["south"] if r429["time"] < r["time"] < r_after["time"]]
        # 取退避窗口之外的相邻请求间隔作为 south 的常规节奏参照
        regular = [
            b["time"] - a["time"]
            for a, b in zip(records["south"], records["south"][1:])
            if not (r429["time"] <= a["time"] < r_after["time"])
        ]
        normal_gap = min(regular) if regular else intervals["south"]
        recorder.check(
            "跨园区: north 退避时 south 照常刷新",
            len(window) >= 2,
            f"north 两次请求间隔 {r_after['time'] - r429['time']:.2f}s；"
            f"该窗口内 south 仍发起 {len(window)} 次请求（常规间隔 ~{normal_gap:.2f}s）",
        )

    # ---- 核对 4：304 不替换快照；200 发布新快照 -------------------------
    north_snaps = status["north"]["counters"]
    recorder.check(
        "north: 出现 200 与 304 两种响应",
        north_snaps["ok"] >= 1 and north_snaps["not_modified"] >= 1,
        f"200={north_snaps['ok']} 304={north_snaps['not_modified']}",
    )
    snap_north = scheduler.snapshot_of("north")
    recorder.check(
        "north: 保留最近一次成功快照",
        snap_north is not None and bool(snap_north.etag),
        f"etag={snap_north.etag[:22] if snap_north else '无'}...",
    )
    south_counters = status["south"]["counters"]
    snap_south = scheduler.snapshot_of("south")
    body_ok = snap_south is not None and snap_south.body.get("arrivals", [{}])[0].get("route") == "R2"
    recorder.check(
        "south: 推送后通过 200 拿到新快照",
        south_counters["ok"] >= 2 and body_ok,
        f"200={south_counters['ok']} 304={south_counters['not_modified']}，快照线路={snap_south.body['arrivals'][0]['route'] if snap_south else '无'}",
    )

    # ---- 核对 5：5xx/超时退避 + 成功恢复 --------------------------------
    east_recs = records["east"]
    east_statuses = [r["status"] for r in east_recs]
    has_503 = east_statuses.count(503) >= 2
    # timeout 请求服务端记录可能是 None（客户端先断开）
    has_timeout = any(s is None for s in east_statuses) or status["east"]["counters"]["timeout"] >= 1
    east_gaps = _gaps(east_recs)
    # 第 1 次 503 后的退避应为 base=1s（加上请求自身耗时）
    first_503 = next(((g, d, s) for g, d, s in east_gaps if s == 503), None)
    backoff_ok = first_503 is not None and abs((first_503[0] - first_503[1]) - backoff_base) <= TOLERANCE
    # 第二次 503 后退避应为 base*2=2s
    second_503_gap = None
    seen_503 = 0
    for g, d, s in east_gaps:
        if s == 503:
            seen_503 += 1
            if seen_503 == 2:
                second_503_gap = (g, d)
                break
    backoff2_ok = second_503_gap is not None and abs(
        (second_503_gap[0] - second_503_gap[1]) - backoff_base * 2
    ) <= TOLERANCE
    recorder.check(
        "east: 5xx 指数退避（1s -> 2s）且不超过上限",
        has_503 and backoff_ok and backoff2_ok,
        f"503x{east_statuses.count(503)}，首次退避="
        f"{(first_503[0] - first_503[1]):.2f}s 二次退避="
        f"{(second_503_gap[0] - second_503_gap[1]):.2f}s" if first_503 and second_503_gap else "退避数据不足",
    )
    recorder.check(
        "east: 超时被识别并退避",
        has_timeout,
        f"timeout 计数={status['east']['counters']['timeout']}",
    )
    # 成功后恢复常规间隔：找最后一个 200 之后与前一个 200 的间隔
    ok_times = [r["time"] for r in east_recs if r["status"] == 200]
    if len(ok_times) >= 2:
        gap_ok = abs((ok_times[-1] - ok_times[-2]) - intervals["east"]) <= TOLERANCE
        recorder.check(
            "east: 成功后恢复常规间隔",
            gap_ok,
            f"连续 200 间隔 {ok_times[-1] - ok_times[-2]:.2f}s（常规 {intervals['east']}s）",
        )
    else:
        recorder.check("east: 成功后恢复常规间隔", False, f"200 次数不足: {len(ok_times)}")

    # ---- 核对 6：全局在途不超过 3 ---------------------------------------
    timeline = sorted(((e["mono"] - t0, 1 if e["kind"] == "dispatch" else -1, e["park_id"])
                       for e in events), key=lambda x: (x[0], x[1]))
    inflight, peak, peak_parks, active = 0, 0, set(), set()
    for ts, delta, pid in timeline:
        if delta == 1:
            inflight += 1
            active.add(pid)
            if inflight > peak:
                peak, peak_parks = inflight, set(active)
        else:
            inflight -= 1
            active.discard(pid)
    recorder.check(
        "全局: 同时在途请求不超过 3",
        peak <= 3,
        f"峰值 {peak} 个在途（园区 {sorted(peak_parks)}），共 {len(events) // 2} 次请求",
    )

    # ---- 核对 7：成功拿到 ETag 之后的请求均携带 If-None-Match -----------
    # 注意：园区在首个 200 之前没有 ETag 可带，失败重试期间不携带是正确行为
    missing = []
    for pid, recs in records.items():
        had_etag = False
        for r in recs:
            if r.get("if_none_match"):
                had_etag = True
            elif had_etag:
                missing.append(f"{pid}#{r['seq']}")
    recorder.check(
        "ETag: 首次成功后的请求均携带 If-None-Match",
        not missing,
        "条件请求均携带已知 ETag（首个 200 之前无 ETag 可带）" if not missing
        else f"缺失: {missing}",
    )

    ok = recorder.report()
    print("\n调度员视图数据（DispatcherServer /api/status 同源）：")
    print(json.dumps(scheduler.status(), ensure_ascii=False, indent=2, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
