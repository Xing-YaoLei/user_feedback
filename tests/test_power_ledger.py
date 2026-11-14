"""pytest 测试套件：时间解析、增量、规则匹配、异常、预览/确认全流程。"""

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from power_ledger.csv_input import load_attribution, load_readings, load_tariff
from power_ledger.engine import build_daily_ledgers, evaluate_readings
from power_ledger.errors import LedgerError
from power_ledger.jsonutil import content_hash
from power_ledger.pipeline import (
    analyze_impact,
    confirm_preview,
    init_store,
    preview_changes,
)
from power_ledger.rules import (
    diff_rules,
    flatten_rules,
    match_attribution,
    match_tariff,
    prepare_rules,
)
from power_ledger.storage import Store
from power_ledger.timeutil import BEIJING, business_day, parse_beijing

# ---------------------------------------------------------------- 辅助

def write(path, text):
    path.write_text(text, encoding="utf-8")


NOW = datetime(2026, 3, 21, tzinfo=BEIJING)


# ---------------------------------------------------------------- 时间

class TestTime:
    def test_naive_assumed_beijing(self):
        dt = parse_beijing("2026-03-15 00:00:00")
        assert dt.utcoffset() == timedelta(hours=8)
        assert business_day(dt) == "2026-03-15"

    def test_z_offset_converted(self):
        dt = parse_beijing("2026-03-10T23:30:00Z")
        assert dt.isoformat() == "2026-03-11T07:30:00+08:00"
        assert business_day(dt) == "2026-03-11"

    def test_explicit_plus_eight(self):
        dt = parse_beijing("2026-03-05T00:30:00+08:00")
        assert business_day(dt) == "2026-03-05"

    def test_other_offset_rolls_back_day(self):
        # 2026-03-05 00:30 UTC → 北京 08:30 同日；取一个负偏移验证跨日
        dt = parse_beijing("2026-03-05T17:30:00+01:00")
        assert business_day(dt) == "2026-03-06"


# ---------------------------------------------------------------- 增量与异常

CUM_CSV = """meter_id,reading_time,meter_reading
M-1,2026-03-01 08:00:00,1000
M-1,2026-03-02 08:00:00,1120
M-1,2026-03-03 08:00:00,1110
M-1,2026-03-04 08:00:00,1230
"""

INC_CSV = """meter_id,reading_time,consumption_kwh
M-1,2026-03-01 08:00:00,100
M-1,2026-03-02 08:00:00,-5
"""


class TestIncrement:
    def test_cumulative_increment_and_rollback(self, tmp_path):
        p = tmp_path / "r.csv"
        write(p, CUM_CSV)
        mode, readings = load_readings(p)
        assert mode == "cumulative"
        attr = prepare_rules(make_attr(tmp_path, """
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,车间A,2026-01-01 00:00:00,
"""))
        tariff = prepare_rules(make_tariff(tmp_path, """
rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.8
"""))
        evaled = evaluate_readings(mode, readings, flatten_rules(attr, tariff))
        assert evaled[0]["exception"]["code"] == "first_reading_no_previous"
        assert evaled[1]["consumption_kwh"] == Decimal("120.000000")
        assert evaled[2]["exception"]["code"] == "reading_rollback"
        # 回退不推进基线：下一条按回退前的基线 1120 计算 → 1230 - 1120 = 110
        assert evaled[3]["consumption_kwh"] == Decimal("110.000000")

    def test_negative_increment(self, tmp_path):
        p = tmp_path / "r.csv"
        write(p, INC_CSV)
        mode, readings = load_readings(p)
        attr = prepare_rules(make_attr(tmp_path, """
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,车间A,2026-01-01 00:00:00,
"""))
        tariff = prepare_rules(make_tariff(tmp_path, """
rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.8
"""))
        evaled = evaluate_readings(mode, readings, flatten_rules(attr, tariff))
        assert evaled[1]["exception"]["code"] == "negative_increment"

    def test_duplicate_timestamp_rejected(self, tmp_path):
        p = tmp_path / "r.csv"
        write(p, """meter_id,reading_time,consumption_kwh
M-1,2026-03-01 08:00:00,100
M-1,2026-03-01 08:00:00,101
""")
        with pytest.raises(LedgerError, match="重复"):
            load_readings(p)

    def test_both_mode_columns_rejected(self, tmp_path):
        p = tmp_path / "r.csv"
        write(p, """meter_id,reading_time,meter_reading,consumption_kwh
M-1,2026-03-01 08:00:00,1000,10
""")
        with pytest.raises(LedgerError, match="二选一"):
            load_readings(p)


def make_attr(tmp_path, text):
    p = tmp_path / "attr.csv"
    write(p, text.strip() + "\n")
    return load_attribution(p)


def make_tariff(tmp_path, text):
    p = tmp_path / "tariff.csv"
    write(p, text.strip() + "\n")
    return load_tariff(p)


# ---------------------------------------------------------------- 规则匹配

class TestMatching:
    def _rules(self, tmp_path):
        attr = prepare_rules(make_attr(tmp_path, """
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,车间A,2026-03-01 00:00:00,2026-03-16 00:00:00
A2,M-1,WS-B,车间B,2026-03-16 00:00:00,
"""))
        tariff = prepare_rules(make_tariff(tmp_path, """
rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-03-01 00:00:00,2026-03-15 00:00:00,0.82
T2,WS-A,2026-03-20 00:00:00,,0.90
T0,,2026-03-01 00:00:00,2026-03-10 00:00:00,0.50
"""))
        return attr, tariff

    def test_window_includes_start_excludes_end(self, tmp_path):
        attr, tariff = self._rules(tmp_path)
        ts = parse_beijing("2026-03-16 00:00:00")
        status, hits = match_attribution(attr, "M-1", ts)
        assert status == "ok" and hits[0]["rule_id"] == "A2"
        # 终点不含：03-15 00:00 恰好是 T1 终点，T1 不再命中；T0 也已过期 → 无电价
        status, hits = match_tariff(tariff, "WS-A", parse_beijing("2026-03-15 00:00:00"))
        assert hits == [] and status == "no_tariff"
        # 终点前一刻仍命中 T1
        status, hits = match_tariff(tariff, "WS-A", parse_beijing("2026-03-14 23:59:59"))
        assert [h["rule_id"] for h in hits] == ["T1"]
        # 缺口：03-15~03-20 WS-A 无专属电价，且全车间 T0 已过期 → no_tariff
        status, _ = match_tariff(tariff, "WS-A", parse_beijing("2026-03-16 00:00:00"))
        assert status == "no_tariff"

    def test_generic_tariff_applies_to_all_workshops(self, tmp_path):
        attr, tariff = self._rules(tmp_path)
        status, hits = match_tariff(tariff, "WS-OTHER", parse_beijing("2026-03-05 00:00:00"))
        assert status == "ok" and hits[0]["rule_id"] == "T0"

    def test_multiple_matches_sorted_and_flagged(self, tmp_path):
        attr = prepare_rules(make_attr(tmp_path, """
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,车间A,2026-03-01 00:00:00,
A2,M-1,WS-B,车间B,2026-03-05 00:00:00,
"""))
        status, hits = match_attribution(attr, "M-1", parse_beijing("2026-03-06 00:00:00"))
        assert status == "multiple_attribution"
        assert [h["rule_id"] for h in hits] == ["A1", "A2"]

    def test_duplicate_explicit_rule_id_rejected(self, tmp_path):
        with pytest.raises(LedgerError, match="rule_id 重复"):
            prepare_rules(make_attr(tmp_path, """
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
X,M-1,WS-A,车间A,2026-03-01 00:00:00,
X,M-1,WS-B,车间B,2026-03-02 00:00:00,
"""))

    def test_generated_rule_id_is_stable(self, tmp_path):
        a = prepare_rules(make_attr(tmp_path, """
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
,M-1,WS-A,车间A,2026-03-01 00:00:00,
"""))
        b = prepare_rules(make_attr(tmp_path, """
rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
,M-1,WS-A,车间A,2026-03-01 00:00:00,
"""))
        assert a[0]["rule_id"] == b[0]["rule_id"]
        assert a[0]["rule_id"].startswith("A-auto-")


# ---------------------------------------------------------------- 规则差异

class TestDiff:
    def test_added_removed_changed(self):
        old = prepare_rules([
            {"rule_id": "T1", "kind": "tariff", "workshop_id": "WS-A",
             "valid_from": parse_beijing("2026-01-01 00:00:00"), "valid_to": None,
             "price_per_kwh": Decimal("0.8")},
        ])
        new = prepare_rules([
            {"rule_id": "T1", "kind": "tariff", "workshop_id": "WS-A",
             "valid_from": parse_beijing("2026-01-01 00:00:00"), "valid_to": None,
             "price_per_kwh": Decimal("0.9")},
            {"rule_id": "T2", "kind": "tariff", "workshop_id": "WS-B",
             "valid_from": parse_beijing("2026-01-01 00:00:00"), "valid_to": None,
             "price_per_kwh": Decimal("0.7")},
        ])
        diff = diff_rules(old, new)
        assert [r["rule_id"] for r in diff["added"]] == ["T2"]
        assert diff["changed"][0]["fields"]["price_per_kwh"] == [
            Decimal("0.8"), Decimal("0.9")]

    def test_delete_detection(self):
        old = prepare_rules([
            {"rule_id": "A1", "kind": "attribution", "meter_id": "M-1",
             "workshop_id": "WS-A", "workshop_name": "车间A",
             "valid_from": parse_beijing("2026-01-01 00:00:00"), "valid_to": None},
        ])
        diff = diff_rules(old, [])
        assert [r["rule_id"] for r in diff["removed"]] == ["A1"]


# ---------------------------------------------------------------- 全流程

def _bootstrap(tmp_path):
    readings = tmp_path / "readings.csv"
    write(readings, """meter_id,reading_time,consumption_kwh
M-1,2026-03-14 08:00:00,100
M-1,2026-03-15 08:00:00,100
M-1,2026-03-16 08:00:00,100
M-2,2026-03-15 08:00:00,50
""")
    attr = tmp_path / "attr.csv"
    write(attr, """rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,甲车间,2026-01-01 00:00:00,
A2,M-2,WS-A,甲车间,2026-01-01 00:00:00,
""")
    tariff = tmp_path / "tariff.csv"
    write(tariff, """rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.80
""")
    store, version, ledgers = init_store(tmp_path / "ledger", readings, attr, tariff, NOW)
    return store, readings, attr, tariff, ledgers


class TestEndToEnd:
    def test_init_publishes_daily_ledger_with_version(self, tmp_path):
        store, _, _, _, ledgers = _bootstrap(tmp_path)
        assert set(ledgers) == {"2026-03-14", "2026-03-15", "2026-03-16"}
        day = ledgers["2026-03-15"]
        assert day["summaries"][0]["total_kwh"] == Decimal("150.000000")
        # 150 kWh × 0.80 = 120 元
        assert day["summaries"][0]["total_cost"] == Decimal("120.000000")
        on_disk = store.load_ledger_day("2026-03-15")
        assert on_disk["rules_version"] == 1
        assert on_disk["rules_hash"].startswith("sha256:")

    def test_preview_impact_list_midmonth_transfer(self, tmp_path):
        store, _, attr, tariff, _ = _bootstrap(tmp_path)
        write(attr, """rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,甲车间,2026-01-01 00:00:00,2026-03-16 00:00:00
A3,M-1,WS-B,乙车间,2026-03-16 00:00:00,
A2,M-2,WS-A,甲车间,2026-01-01 00:00:00,
""")
        write(tmp_path / "tariff2.csv", """rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.80
T2,WS-B,2026-01-01 00:00:00,,0.90
""")
        _, preview = preview_changes(store.root, attr, tmp_path / "tariff2.csv", NOW)
        m1 = next(m for m in preview["impact"] if m["meter_id"] == "M-1")
        assert m1["first_affected_day"] == "2026-03-16"
        assert m1["reasons"] == ["attribution"]
        assert preview["affected_days"] == ["2026-03-16"]
        assert "2026-03-15" in preview["unchanged_days"]
        # M-2 没有任何变化，不应出现在影响清单
        assert all(m["meter_id"] != "M-2" for m in preview["impact"])

    def test_tariff_only_change_marked_tariff_reason(self, tmp_path):
        store, _, attr, tariff, _ = _bootstrap(tmp_path)
        write(tariff, """rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.95
""")
        _, preview = preview_changes(store.root, attr, tariff, NOW)
        reasons = {r for m in preview["impact"] for r in m["reasons"]}
        assert reasons == {"tariff"}
        # 03-15 两条读数共 150 kWh × 0.95 = 142.5；03-14 只有 100 kWh
        change15 = next(c for c in preview["daily_changes"] if c["day"] == "2026-03-15")
        assert change15["after_summaries"][0]["total_cost"] == Decimal("142.500000")
        change14 = next(c for c in preview["daily_changes"] if c["day"] == "2026-03-14")
        assert change14["after_summaries"][0]["total_cost"] == Decimal("95.000000")

    def test_exception_recovery_and_new_exception(self, tmp_path):
        import shutil

        store, readings, attr, tariff, _ = _bootstrap(tmp_path)
        # 先制造 no_attribution：删除 M-2 的归属并重新建账
        write(attr, """rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,甲车间,2026-01-01 00:00:00,
""")
        shutil.rmtree(store.root)
        store, _, _ = init_store(store.root, readings, attr, tariff, NOW)
        day = store.load_ledger_day("2026-03-15")
        assert any(e["exception"]["code"] == "no_attribution" for e in day["exceptions"])

        # v2 补回 M-2 归属 → 预览应体现「恢复正常」
        write(attr, """rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,甲车间,2026-01-01 00:00:00,
A2,M-2,WS-A,甲车间,2026-01-01 00:00:00,
""")
        _, preview = preview_changes(store.root, attr, tariff, NOW)
        recovered = preview["exception_changes"]["recovered"]
        assert len(recovered) == 1 and recovered[0]["before_code"] == "no_attribution"
        assert recovered[0]["meter_id"] == "M-2"

        # 新增异常：另建一个完整归属的账本，再预览「删掉 A2」的规则
        full_attr = tmp_path / "attr_full.csv"
        write(full_attr, """rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,甲车间,2026-01-01 00:00:00,
A2,M-2,WS-A,甲车间,2026-01-01 00:00:00,
""")
        reduced_attr = tmp_path / "attr_reduced.csv"
        write(reduced_attr, """rule_id,meter_id,workshop_id,workshop_name,valid_from,valid_to
A1,M-1,WS-A,甲车间,2026-01-01 00:00:00,
""")
        store2_root = tmp_path / "ledger2"
        init_store(store2_root, readings, full_attr, tariff, NOW)
        _, preview2 = preview_changes(store2_root, reduced_attr, tariff, NOW)
        added = preview2["exception_changes"]["added"]
        assert len(added) == 1 and added[0]["after_code"] == "no_attribution"
        assert added[0]["meter_id"] == "M-2"

    def test_confirm_only_replaces_affected_days(self, tmp_path):
        store, _, attr, tariff, _ = _bootstrap(tmp_path)
        write(tariff, """rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,2026-03-15 00:00:00,0.80
T2,WS-A,2026-03-15 00:00:00,,0.90
""")
        _, preview = preview_changes(store.root, attr, tariff, NOW)
        assert preview["affected_days"] == ["2026-03-15", "2026-03-16"]
        untouched = (store.root / "ledger" / "2026-03-14.json").read_text(encoding="utf-8")
        result = confirm_preview(store.root, preview["preview_id"], NOW)
        assert result["status"] == "confirmed"
        assert (store.root / "ledger" / "2026-03-14.json").read_text(encoding="utf-8") == untouched
        day15 = store.load_ledger_day("2026-03-15")
        assert day15["rules_version"] == 2
        # 03-15 08:00 落在新电价区间 [03-15, ∞)：150 × 0.90 = 135
        assert day15["summaries"][0]["total_cost"] == 135.0
        assert store.meta()["current_version"] == 2

    def test_double_confirm_rejected(self, tmp_path):
        store, _, attr, tariff, _ = _bootstrap(tmp_path)
        write(tariff, """rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.95
""")
        _, preview = preview_changes(store.root, attr, tariff, NOW)
        confirm_preview(store.root, preview["preview_id"], NOW)
        with pytest.raises(LedgerError, match="不能重复确认"):
            confirm_preview(store.root, preview["preview_id"], NOW)

    def test_concurrent_change_rejects_confirm_and_writes_nothing(self, tmp_path):
        store, _, attr, tariff, _ = _bootstrap(tmp_path)
        write(tariff, """rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.95
""")
        _, preview = preview_changes(store.root, attr, tariff, NOW)
        affected = preview["affected_days"]
        originals = {
            d: (store.root / "ledger" / f"{d}.json").read_text(encoding="utf-8")
            for d in affected
        }
        # 篡改原始读数
        readings_file = store.root / "readings" / f"{affected[0]}.json"
        data = json.loads(readings_file.read_text(encoding="utf-8"))
        data["readings"][0]["consumption_kwh"] = 999
        readings_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

        with pytest.raises(LedgerError, match="确认被拒绝"):
            confirm_preview(store.root, preview["preview_id"], NOW)
        rejected = store.load_preview(preview["preview_id"])
        assert rejected["status"] == "rejected"
        # 所有受影响日期的已发布结果都保持原样
        for d, text in originals.items():
            assert (store.root / "ledger" / f"{d}.json").read_text(encoding="utf-8") == text
        assert store.meta()["current_version"] == 1

    def test_identical_rules_preview_rejected(self, tmp_path):
        store, _, attr, tariff, _ = _bootstrap(tmp_path)
        with pytest.raises(LedgerError, match="完全相同"):
            preview_changes(store.root, attr, tariff, NOW)

    def test_recompute_matches_preview_hash(self, tmp_path):
        """确认时重算结果必须与预览 after_core_hashes 一致。"""
        store, _, attr, tariff, _ = _bootstrap(tmp_path)
        write(tariff, """rule_id,workshop_id,valid_from,valid_to,price_per_kwh
T1,WS-A,2026-01-01 00:00:00,,0.95
""")
        _, preview = preview_changes(store.root, attr, tariff, NOW)
        for day in preview["affected_days"]:
            assert day in preview["after_core_hashes"]
        confirm_preview(store.root, preview["preview_id"], NOW)
        for day in preview["affected_days"]:
            published = store.load_ledger_day(day)
            assert content_hash({
                "summaries": published["summaries"],
                "readings": published["readings"],
                "exceptions": published["exceptions"],
            }) == preview["after_core_hashes"][day]

    def test_init_refuses_nonempty_store(self, tmp_path):
        store, readings, attr, tariff, _ = _bootstrap(tmp_path)
        with pytest.raises(LedgerError, match="非空"):
            init_store(store.root, readings, attr, tariff, NOW)
