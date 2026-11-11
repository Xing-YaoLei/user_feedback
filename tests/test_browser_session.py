"""浏览器会话层测试：条件/结果一致性、旧内容、错误与空结果识别。"""
from __future__ import annotations

import pytest

from crawler.browser import PageQueryError


def _walk_to_first_type(session, region="north", institution="bj1"):
    """走到类型下拉就绪，但不选择具体类型（由用例显式选择）。"""
    session.select_region(region)
    session.select_institution(institution)
    return session.read_options("type")


def test_collect_normal_combo(browser):
    _walk_to_first_type(browser)
    browser.select_type("monitor")
    devices = browser.query_and_collect("north", "bj1", "monitor")
    assert {d.id for d in devices} == {"DEV-001", "DEV-002"}


def test_empty_branch_returns_empty_list_not_error(browser):
    _walk_to_first_type(browser)
    browser.select_type("pump")
    # bj1/pump 是空分支：页面应渲染 data-empty 标识，爬虫得到 []
    devices = browser.query_and_collect("north", "bj1", "pump")
    assert devices == []
    assert browser.page.locator('[data-empty="1"]').count() == 1


def test_error_banner_keeps_old_content_and_raises_retryable(browser, server,
                                                              fault_ctl):
    _walk_to_first_type(browser)
    # 先成功查询组合 A，页面留下 A 的内容
    browser.select_type("monitor")
    browser.query_and_collect("north", "bj1", "monitor")
    old_rows = browser.page.locator("table[data-result-table] tbody tr").count()
    assert old_rows == 2

    # 之后该组合请求 500：旧内容保留、出现错误横幅
    browser.select_type("ventilator")
    fault_ctl(fail_remaining=1)
    with pytest.raises(PageQueryError):
        browser.query_and_collect("north", "bj1", "ventilator")

    state = browser.page.evaluate(
        "() => document.querySelector('#status').dataset.state")
    assert state == "error"
    # 旧表格没有被清空 —— 这正是“失败不能当空分支”的页面特征
    assert browser.page.locator("table[data-result-table] tbody tr").count() == old_rows
    # 重试（故障配额已耗尽，下一次成功）
    devices = browser.query_and_collect("north", "bj1", "ventilator")
    assert {d.id for d in devices} == {"DEV-003"}


def test_slow_mode_keeps_stale_content_until_signature_matches(browser,
                                                                fault_ctl):
    fault_ctl(slow_mode=True)
    _walk_to_first_type(browser)
    # 第一次查询建立旧内容
    browser.select_type("monitor")
    browser.query_and_collect("north", "bj1", "monitor")
    # 第二次查询慢：加载窗口内签名仍是旧组合，爬虫必须等到新签名出现
    browser.select_type("ventilator")
    devices = browser.query_and_collect("north", "bj1", "ventilator")
    assert [d.id for d in devices] == ["DEV-003"]
    sig = browser.page.evaluate(
        "() => document.querySelector('#signature').dataset.signature")
    assert sig == "north|bj1|ventilator|1"


def test_late_response_overtake_is_rejected_by_signature(browser, server,
                                                         fault_ctl):
    """复现跨组合旧响应晚到：A 的首个请求延迟，先看 B 再看 A 时，
    A 的迟到响应可能在 B 的内容之后到达。签名闸门必须挡住。"""
    fault_ctl(overtake=True, overtake_delay=1.0)
    _walk_to_first_type(browser)

    # 发起 A(monitor) 的首个请求（服务器端将延迟），不等待，立刻切到 B
    browser.select_type("monitor")
    browser.page.click("#query-btn")
    browser.select_type("ventilator")
    browser.page.click("#query-btn")
    # B 先收敛
    b_devices = browser.query_and_collect("north", "bj1", "ventilator")
    assert [d.id for d in b_devices] == ["DEV-003"]

    # 此时 A 的迟到响应随时可能到达并覆盖页面（旧签名）。
    # 再查 A：无论页面当前是 A 还是被晚到响应搅动，最终必须收敛到 A 签名。
    browser.select_type("monitor")
    a_devices = browser.query_and_collect("north", "bj1", "monitor")
    assert {d.id for d in a_devices} == {"DEV-001", "DEV-002"}
    sig = browser.page.evaluate(
        "() => document.querySelector('#signature').dataset.signature")
    assert sig == "north|bj1|monitor|2"


def test_options_read_by_id_survives_shuffle(browser, fault_ctl):
    fault_ctl(shuffle=True)
    # 重新载入页面让乱序生效
    browser.page.goto(browser.base_url + "/", wait_until="domcontentloaded")
    regions = browser.read_options("region")
    ids = {rid for rid, _ in regions}
    assert ids == {"north", "east", "south", "west"}
    # 按 id 选择而不是位置：选到的 label 必须正确
    browser.select_region("west")
    institutions = browser.read_options("institution")
    assert institutions == [("xa", "西安监测站")]
