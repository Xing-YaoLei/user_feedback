"""爬虫引擎端到端测试：覆盖、去重、故障恢复、暂停续跑、筛选次序。"""
from __future__ import annotations

import json
from pathlib import Path

from crawler.engine import Crawler
from crawler.models import combo_key, split_key
from testsite import data
from tests.conftest import get_control, set_fault

GT = data.ground_truth()


def run(server, state_dir, **kwargs):
    crawler = Crawler(base_url=server, state_dir=state_dir,
                      headless=True, **kwargs)
    return crawler.run()


def assert_matches_ground_truth(state, expect_status="done"):
    assert state.status == expect_status
    leaves = GT["leaves"]
    assert len(state.combos) == len(leaves)

    # 1. 覆盖：每个叶子组合都被访问；空/非空与事实一致
    for combo in leaves:
        key = combo_key(*combo)
        cs = state.combos[key]
        if combo in GT["empty_combos"]:
            assert cs.status == "empty", key
            assert cs.device_ids == []
        else:
            assert cs.status == "done", key
            expected_ids = {d["id"] for d in data.devices_for(*combo)}
            assert set(cs.device_ids) == expected_ids, key
        assert cs.attempts >= 1

    # 2. 实体去重 + 归属保留
    assert set(state.devices) == set(GT["entities"])
    for dev_id, dev in state.devices.items():
        fact = GT["entities"][dev_id]
        assert (dev.name, dev.model, dev.manufacturer) == (
            fact["name"], fact["model"], fact["manufacturer"])
        assert set(dev.sources) == GT["memberships"][dev_id]
        assert len(dev.sources) == len(set(dev.sources))  # 归属不重复

    # 3. 覆盖树结构与状态完整
    tree = state.coverage_tree()
    for region, _ in data.REGIONS:
        assert region in tree
        for iid, _ in data.INSTITUTIONS[region]:
            assert iid in tree[region]
            for tid in data.TYPE_SUPPORT[iid]:
                node = tree[region][iid][tid]
                assert node["status"] in ("done", "empty")
                assert node["attempts"] >= 1


def test_full_crawl_matches_ground_truth(server, state_dir):
    state = run(server, state_dir)
    assert_matches_ground_truth(state)

    # 落盘文件齐全且可重新加载
    for name in ("state.json", "devices.json", "coverage_tree.json",
                 "events.jsonl"):
        assert (state_dir / name).exists()
    devices_doc = json.loads((state_dir / "devices.json").read_text())
    assert devices_doc["device_count"] == len(GT["entities"])
    # 共享设备的归属被保留
    dev010 = next(d for d in devices_doc["devices"] if d["id"] == "DEV-010")
    assert set(dev010["sources"]) == {
        combo_key("north", "bj1", "ultrasound"),
        combo_key("north", "bj2", "ultrasound"),
    }
    events = [json.loads(line) for line in
              (state_dir / "events.jsonl").read_text().splitlines()]
    assert {"start", "discover", "captured", "empty_branch", "done"} <= \
        {e["kind"] for e in events}


def test_empty_branches_are_marked_not_pruned(server, state_dir):
    state = run(server, state_dir)
    empty_keys = {combo_key(*c) for c in GT["empty_combos"]}
    marked = {k for k, c in state.combos.items() if c.status == "empty"}
    assert marked == empty_keys
    # 空分支同样出现在覆盖树中（没有被“剪掉”）
    tree = json.loads((state_dir / "coverage_tree.json").read_text())["tree"]
    for key in empty_keys:
        r, i, t = split_key(key)
        assert tree[r][i][t]["status"] == "empty"


def test_transient_failures_retried_and_not_treated_as_empty(server, state_dir):
    # 前 3 次 devices 请求全部 500；预算 4 次，足够恢复
    set_fault(server, fail_first=3)
    state = run(server, state_dir, max_attempts=4)
    assert_matches_ground_truth(state)
    ctl = get_control(server)
    assert ctl["counters"]["devices_failed"] == 3
    # 至少有一个组合经历过重试，且最终成功
    retried = [c for c in state.combos.values() if c.attempts > 1]
    assert retried
    assert all(c.status in ("done", "empty") for c in state.combos.values())
    retry_events = [json.loads(line) for line in
                    (state_dir / "events.jsonl").read_text().splitlines()
                    if '"retry"' in line]
    assert len(retry_events) == 3


def test_failed_combo_not_pruned_and_recovered_on_resume(server, state_dir):
    # 预算只给 2 次，而前 3 次请求失败 -> 第一个组合 failed，但不影响后续组合
    set_fault(server, fail_first=3)
    state = run(server, state_dir, max_attempts=2)
    failed = [k for k, c in state.combos.items() if c.status == "failed"]
    assert failed, "应当存在重试耗尽的 failed 组合"
    assert state.status == "done"  # 整体流程跑完，个别分支失败不终止任务
    # 第一段就成功收敛的组合（done/empty），续跑时不应被重新访问
    succeeded_first_run = {k for k, c in state.combos.items()
                           if c.status in ("done", "empty")}
    first_attempts = {k: c.attempts for k, c in state.combos.items()}

    # 故障已随 fail_first 配额耗尽而消失；续跑只重试 failed/pending
    state2 = run(server, state_dir, max_attempts=3)
    assert_matches_ground_truth(state2)
    # 第一段已成功的组合保持原尝试次数，没有被重新访问
    for key in succeeded_first_run:
        assert state2.combos[key].attempts == first_attempts[key], key
        assert state2.combos[key].status in ("done", "empty")
    # 第一段失败的组合续跑后恢复
    for key in failed:
        assert state2.combos[key].status in ("done", "empty"), key


def test_pause_and_resume_skips_finished_branches(server, state_dir):
    # 第一段：最多处理 3 个组合后暂停
    state1 = run(server, state_dir, max_branches=3)
    assert state1.status == "paused"
    finished_1 = state1.finished_combo_count()
    assert finished_1 == 3
    # 只快照已完成的组合（pending 是被预建但尚未处理的，续跑会正常推进）
    finished_keys = {k for k, v in state1.combos.items() if v.is_finished()}
    snapshot = {k: (v.status, v.attempts, list(v.device_ids))
                for k, v in state1.combos.items() if k in finished_keys}

    # 第二段：续跑完成全部
    state2 = run(server, state_dir)
    assert_matches_ground_truth(state2)
    # 第一段完成的组合状态未被改写、未重复采集
    for key, old in snapshot.items():
        assert (state2.combos[key].status, state2.combos[key].attempts,
                list(state2.combos[key].device_ids)) == old
    assert state2.finished_combo_count() == len(GT["leaves"])
    events = [json.loads(line) for line in
              (state_dir / "events.jsonl").read_text().splitlines()]
    assert any(e["kind"] == "resume" for e in events)
    assert any(e["kind"] == "pause_requested" for e in events)


def test_shuffled_filter_order_still_covers_everything(server, state_dir):
    # 选项乱序 = 筛选次序变化；按 id 选择的爬虫结果必须与正常次序一致
    set_fault(server, shuffle=True)
    state = run(server, state_dir)
    assert_matches_ground_truth(state)


def test_duplicate_entities_deduped_with_membership(server, state_dir):
    state = run(server, state_dir)
    # 总记录行数 > 去重后实体数（共享设备存在）
    total_rows = GT["total_rows"]
    assert total_rows > len(state.devices)
    # 每个多归属实体的 sources 数量与事实一致
    multi = {dev_id: srcs for dev_id, srcs in GT["memberships"].items()
             if len(srcs) > 1}
    assert multi, "数据集本身应包含跨组合共享设备"
    for dev_id, srcs in multi.items():
        assert set(state.devices[dev_id].sources) == srcs


def test_slow_mode_full_crawl(server, state_dir):
    # 所有 devices 响应变慢：旧内容残留窗口拉长，一致性等待仍保证正确
    set_fault(server, slow_mode=True)
    state = run(server, state_dir, settle_timeout_ms=20000)
    assert_matches_ground_truth(state)


def test_overtake_mode_full_crawl(server, state_dir):
    # 每个组合首个请求迟到 1s：签名闸门防止晚到响应污染
    set_fault(server, overtake=True, overtake_delay=0.8)
    state = run(server, state_dir, settle_timeout_ms=20000)
    assert_matches_ground_truth(state)


def test_crawler_never_touches_ground_truth_module(server, state_dir):
    # 爬虫源码不得导入 testsite.data（禁止直接枚举后台数据库）
    crawler_dir = Path(__file__).resolve().parents[1] / "crawler"
    for py in crawler_dir.rglob("*.py"):
        text = py.read_text()
        assert "testsite.data" not in text
        assert "from testsite" not in text
        assert "import testsite" not in text
