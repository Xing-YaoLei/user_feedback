"""测试站本身的行为测试：联动接口、空结果、故障注入。"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from testsite import data
from tests.conftest import get_control, set_fault


def _get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return json.loads(resp.read())


def test_region_institution_type_cascade(server):
    regions = _get(server + "/api/regions")["regions"]
    assert {r["id"] for r in regions} == {rid for rid, _ in data.REGIONS}

    institutions = _get(server + "/api/institutions?region=north")["institutions"]
    assert {i["id"] for i in institutions} == {
        iid for iid, _ in data.INSTITUTIONS["north"]}

    types = _get(server + "/api/types?institution=bj1")["types"]
    assert {t["id"] for t in types} == set(data.TYPE_SUPPORT["bj1"])

    # 下级依赖上级：未知机构、越权组合都被拒绝
    import urllib.error as ue
    try:
        _get(server + "/api/types?institution=unknown")
        assert False, "应当 400"
    except ue.HTTPError as e:
        assert e.code == 400


def test_devices_empty_branch_is_explicit_empty_not_error(server):
    # 登记支持但无数据的组合：返回 200 + 空列表 + 签名，而不是错误
    payload = _get(
        server + "/api/devices?region=north&institution=bj1&type=pump")
    assert payload["ok"] is True
    assert payload["devices"] == []
    assert payload["signature"] == "north|bj1|pump|0"


def test_devices_non_empty_payload_and_signature(server):
    payload = _get(
        server + "/api/devices?region=north&institution=bj1&type=monitor")
    assert len(payload["devices"]) == 2
    assert payload["signature"] == "north|bj1|monitor|2"
    assert all({"id", "name", "model", "manufacturer"} <= set(d)
               for d in payload["devices"])


def test_fail_first_returns_500_then_recovers(server):
    set_fault(server, fail_first=2)
    for _ in range(2):
        try:
            urllib.request.urlopen(
                server + "/api/devices?region=north&institution=bj1&type=monitor",
                timeout=5)
            assert False, "前两次应当 500"
        except urllib.error.HTTPError as e:
            assert e.code == 500
    # 第三次恢复正常 —— 证明失败是暂时的，不能被剪枝
    payload = _get(
        server + "/api/devices?region=north&institution=bj1&type=monitor")
    assert payload["ok"] is True
    assert get_control(server)["counters"]["devices_failed"] == 2


def test_shuffle_changes_order_but_keeps_option_set(server):
    normal = _get(server + "/api/regions")["regions"]
    set_fault(server, shuffle=True)
    shuffled = _get(server + "/api/regions")["regions"]
    assert [r["id"] for r in shuffled] != [r["id"] for r in normal]
    assert {r["id"] for r in shuffled} == {r["id"] for r in normal}


def test_page_serves_app_and_static(server):
    html = urllib.request.urlopen(server + "/", timeout=5).read().decode()
    assert "region-select" in html and "app.js" in html
    js = urllib.request.urlopen(server + "/app.js", timeout=5).read().decode()
    assert "queryAndCollect" not in js  # 前端不含爬虫逻辑
    assert "/api/devices" in js
