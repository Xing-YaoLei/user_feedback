"""非功能约束测试：退避策略、禁止固定秒数等待、状态文件原子性。"""
from __future__ import annotations

import ast
from pathlib import Path

from crawler.browser import compute_backoff_seconds
from crawler.models import CrawlState, combo_key


def test_backoff_is_exponential_with_jitter():
    # jitter 为 0 时序列严格指数增长
    seq = [compute_backoff_seconds(attempt, jitter=0.0)
           for attempt in range(1, 5)]
    assert seq == [0.4, 0.8, 1.6, 3.2]
    # 封顶
    assert compute_backoff_seconds(10, jitter=0.0) == 4.0
    # 抖动只增加、不破坏单调性期望
    assert compute_backoff_seconds(1) >= 0.4


def test_no_fixed_second_waits_in_crawler():
    """采集流程不允许 time.sleep(固定秒数) 式盲等；只允许退避计算结果。"""
    crawler_dir = Path(__file__).resolve().parents[1] / "crawler"
    offenders = []
    for py in crawler_dir.rglob("*.py"):
        tree = ast.parse(py.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr == "sleep":
                # 允许 sleep(compute_backoff_seconds(...))；其余 sleep 调用违规
                ok = (node.args and isinstance(node.args[0], ast.Call)
                      and isinstance(node.args[0].func, ast.Name)
                      and node.args[0].func.id == "compute_backoff_seconds")
                if not ok:
                    offenders.append(f"{py.name}:{node.lineno}")
    assert not offenders, f"发现固定/盲等 sleep：{offenders}"


def test_state_atomic_save_and_reload(tmp_path):
    state_dir = tmp_path / "run"
    state = CrawlState("http://example.test", state_dir)
    key = combo_key("north", "bj1", "monitor")
    combo = state.ensure_combo(key)
    state.upsert_device({"id": "DEV-001", "name": "n", "model": "m",
                         "manufacturer": "x"}, key)
    state.upsert_device({"id": "DEV-001", "name": "n", "model": "m",
                         "manufacturer": "x"}, key)  # 同组合重复不产生重复归属
    combo.status = "done"
    combo.device_ids = ["DEV-001"]
    state.save()

    # 原子写：目录里没有残留临时文件
    assert not list(state_dir.glob(".*.tmp"))
    reloaded = CrawlState.load(state_dir)
    assert reloaded.base_url == "http://example.test"
    assert reloaded.combos[key].status == "done"
    assert reloaded.devices["DEV-001"].sources == [key]
    tree = reloaded.coverage_tree()
    assert tree["north"]["bj1"]["monitor"]["status"] == "done"


def test_load_returns_none_when_no_state(tmp_path):
    assert CrawlState.load(tmp_path / "missing") is None
