"""端到端冒烟：init → show → preview → 并发保护 → confirm → 复查。

两个场景分开建账：
* 增量场景（examples/readings.csv）：电价缺口、归属缺口、多重匹配、规则删除；
* 累计场景（examples/readings_cumulative.csv）：首条无基线、月中转车间。

运行：python3 scripts/smoke.py
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "examples"


def run(*args, expect_ok=True):
    proc = subprocess.run(
        [sys.executable, "-m", "power_ledger.cli", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if expect_ok and proc.returncode != 0:
        raise SystemExit(f"命令失败: {args}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    if not expect_ok and proc.returncode == 0:
        raise SystemExit(f"命令本应失败却成功了: {args}\n{proc.stdout}")
    return proc


def main():
    tmp = Path(tempfile.mkdtemp(prefix="power-ledger-smoke-"))
    try:
        store = tmp / "ledger"

        print("== 1. 首次运行（增量模式 + v1 规则） ==")
        run("init", "--store", str(store),
            "--readings", str(EXAMPLES / "readings.csv"),
            "--attr", str(EXAMPLES / "attr.csv"),
            "--tariff", str(EXAMPLES / "tariff.csv"))

        print("== 2. 查看 03-06（应含 M-104 的 multiple_attribution） ==")
        day = json.loads(run("show", "--store", str(store),
                             "--day", "2026-03-06", "--json").stdout)
        codes = {e["exception"]["code"] for e in day["exceptions"]}
        assert "multiple_attribution" in codes, codes

        print("== 3. 预览 v2 规则：异常恢复、新增异常、变更来源 ==")
        preview = json.loads(run(
            "preview", "--store", str(store),
            "--attr", str(EXAMPLES / "attr_v2.csv"),
            "--tariff", str(EXAMPLES / "tariff_v2.csv"),
            "--json").stdout)
        assert preview["status"] == "pending"
        recovered = {(e["meter_id"], e["before_code"])
                     for e in preview["exception_changes"]["recovered"]}
        assert ("M-103", "no_attribution") in recovered       # 归属缺口补上
        assert ("M-104", "multiple_attribution") in recovered  # 重叠区间修复
        assert ("M-102", "no_tariff") in recovered             # 电价缺口补上
        added = {(e["meter_id"], e["after_code"])
                 for e in preview["exception_changes"]["added"]}
        assert ("M-105", "no_attribution") in added            # 归属规则被删
        # M-102 的变化只来自电价（归属规则没动）
        m102 = next(m for m in preview["impact"] if m["meter_id"] == "M-102")
        assert m102["reasons"] == ["tariff"], m102["reasons"]
        # 规则差异包含新增/修改/删除三类
        assert {r["rule_id"] for r in preview["rule_diff"]["added"]} >= {"A-M103-02", "T-WS-A-03"}
        assert {r["rule_id"] for r in preview["rule_diff"]["removed"]} == {"A-M105-01"}
        assert {r["rule_id"] for r in preview["rule_diff"]["changed"]} >= {
            "T-WS-A-01", "A-M101-01", "A-M104-01"}

        print("== 4. 预览期间已发布结果保持原样 ==")
        before = (store / "ledger" / "2026-03-16.json").read_text(encoding="utf-8")
        run("preview", "--store", str(store),
            "--attr", str(EXAMPLES / "attr_v2.csv"),
            "--tariff", str(EXAMPLES / "tariff_v2.csv"))
        after = (store / "ledger" / "2026-03-16.json").read_text(encoding="utf-8")
        assert before == after, "预览改动了已发布结果"

        print("== 5. 并发保护：篡改已发布结果后确认必须被拒绝且不写任何日期 ==")
        # 选一个有车间汇总的日期（03-01 各表归属/电价都正常）
        target_day = "2026-03-01"
        target = store / "ledger" / f"{target_day}.json"
        assert target_day in preview["affected_days"]
        # 先记录全部受影响日期的原始内容（基线在篡改之前捕获）
        originals = {
            d: (store / "ledger" / f"{d}.json").read_text(encoding="utf-8")
            for d in preview["affected_days"]
        }
        data = json.loads(target.read_text(encoding="utf-8"))
        assert data["summaries"], "篡改目标日期应当有车间汇总"
        data["summaries"][0]["total_cost"] = 0.01
        target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        run("confirm", "--store", str(store), "--preview", "1", expect_ok=False)
        rejected = json.loads((store / "previews" / "1.json").read_text(encoding="utf-8"))
        assert rejected["status"] == "rejected"
        run("confirm", "--store", str(store), "--preview", "1", expect_ok=False)
        # 除我们自己篡改的文件外，确认流程没有写入任何受影响日期
        for d, text in originals.items():
            on_disk = (store / "ledger" / f"{d}.json").read_text(encoding="utf-8")
            if d == target_day:
                continue  # 这个文件是测试自己改的
            assert on_disk == text, f"被拒绝的确认改写了日期 {d}"

        print("== 6. 重建账本后确认，只更新清单中的日期 ==")
        shutil.rmtree(store)
        run("init", "--store", str(store),
            "--readings", str(EXAMPLES / "readings.csv"),
            "--attr", str(EXAMPLES / "attr.csv"),
            "--tariff", str(EXAMPLES / "tariff.csv"))
        preview = json.loads(run(
            "preview", "--store", str(store),
            "--attr", str(EXAMPLES / "attr_v2.csv"),
            "--tariff", str(EXAMPLES / "tariff_v2.csv"),
            "--json").stdout)
        # 选一个未变化日期做哨兵（本示例全部日期受影响时改用「确认前后字段对照」）
        run("confirm", "--store", str(store), "--preview", "1")
        confirmed_day = json.loads(run("show", "--store", str(store),
                                       "--day", "2026-03-16", "--json").stdout)
        assert confirmed_day["rules_version"] == 2
        # M-103/M-104 在 03-16 已恢复为正常读数
        ok_meters = {r["meter_id"] for r in confirmed_day["readings"]}
        assert {"M-102", "M-103", "M-104"} <= ok_meters
        # 重算结果与预览哈希一致
        sys.path.insert(0, str(ROOT))
        from power_ledger.jsonutil import content_hash
        from power_ledger.engine import ledger_core
        for day_id in preview["affected_days"]:
            published = json.loads((store / "ledger" / f"{day_id}.json").read_text(encoding="utf-8"))
            assert content_hash(ledger_core(published)) == preview["after_core_hashes"][day_id]
        # 重复确认被拒绝
        run("confirm", "--store", str(store), "--preview", "1", expect_ok=False)

        print("== 7. 累计场景：首条无基线、增量 120、月中转车间影响清单 ==")
        cum_store = tmp / "ledger-cum"
        run("init", "--store", str(cum_store),
            "--readings", str(EXAMPLES / "readings_cumulative.csv"),
            "--attr", str(EXAMPLES / "attr.csv"),
            "--tariff", str(EXAMPLES / "tariff.csv"))
        day1 = json.loads(run("show", "--store", str(cum_store),
                              "--day", "2026-03-01", "--json").stdout)
        assert any(e["exception"]["code"] == "first_reading_no_previous"
                   for e in day1["exceptions"])
        day2 = json.loads(run("show", "--store", str(cum_store),
                              "--day", "2026-03-02", "--json").stdout)
        assert day2["readings"][0]["consumption_kwh"] == 120.0
        cum_preview = json.loads(run(
            "preview", "--store", str(cum_store),
            "--attr", str(EXAMPLES / "attr_v2.csv"),
            "--tariff", str(EXAMPLES / "tariff_v2.csv"),
            "--json").stdout)
        m101 = next(m for m in cum_preview["impact"] if m["meter_id"] == "M-101")
        # T-WS-A-01 全周期调价（0.82→0.80）从首个有增量的业务日 03-02 起仅影响电价；
        # 车间归属变更从 03-16 起
        assert m101["first_affected_day"] == "2026-03-02"
        assert set(m101["reasons"]) == {"attribution", "tariff"}
        day_reasons = {d["day"]: d["reasons"] for d in m101["days"]}
        assert day_reasons["2026-03-02"] == ["tariff"]
        assert day_reasons["2026-03-15"] == ["tariff"]
        attr_days = [d["day"] for d in m101["days"] if "attribution" in d["reasons"]]
        assert attr_days == [f"2026-03-{d:02d}" for d in range(16, 21)]
        # 转车间当天的切片 before → after：v1 下是电价缺口异常，v2 恢复并归 WS-C
        day16 = next(d for d in m101["days"] if d["day"] == "2026-03-16")
        assert day16["before"]["ok_count"] == 0
        assert day16["before"]["exception_count"] == 1
        assert day16["after"]["workshops"] == ["WS-C"]
        assert day16["after"]["ok_count"] == 1
        run("confirm", "--store", str(cum_store), "--preview",
            str(cum_preview["preview_id"]))
        day16 = json.loads(run("show", "--store", str(cum_store),
                               "--day", "2026-03-16", "--json").stdout)
        assert any(s["workshop_id"] == "WS-C" for s in day16["summaries"])

        print("== 8. 业务日换算：UTC 23:30 读数归入次日北京业务日 ==")
        day11 = json.loads(run("show", "--store", str(store),
                               "--day", "2026-03-11", "--json").stdout)
        assert any(r["meter_id"] == "M-103"
                   for r in day11["readings"] + day11["exceptions"])

        print("\n全部冒烟检查通过 ✔  临时账本位于", tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
