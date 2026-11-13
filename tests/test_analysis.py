"""单元测试，全部使用标准库 unittest。"""

import io
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from exp_analysis.analysis import build_observations, run_analysis
from exp_analysis.io_utils import parse_ts
from exp_analysis.permutation import stratified_permutation_test
from exp_analysis.report import render_text, summary_csv
from exp_analysis.cli import main as cli_main

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "sample_data"


def ts(s: str) -> datetime:
    return parse_ts(s)


def assign(uid, layer, group, at):
    return {"user_id": uid, "layer": layer, "group": group, "assigned_at": ts(at)}


class WindowLogicTests(unittest.TestCase):
    def test_conversion_inside_and_outside_window(self):
        assignments = [
            assign("a", "L", "control", "2026-03-01 09:00:00"),
            assign("b", "L", "control", "2026-03-01 09:00:00"),
            assign("c", "L", "control", "2026-03-01 09:00:00"),
            assign("d", "L", "control", "2026-03-01 09:00:00"),
        ]
        conversions = {
            "a": ts("2026-03-01 09:00:00"),       # 恰好分组时刻，计入
            "b": ts("2026-03-08 09:00:00"),       # 恰好窗口结束，计入
            "c": ts("2026-03-08 09:00:01"),       # 窗口外，不计入
            "d": ts("2026-02-28 09:00:00"),       # 分组前，不计入
        }
        coverage = ts("2026-03-20 00:00:00")
        obs, warnings = build_observations(assignments, conversions, {}, coverage,
                                           "control", "treatment")
        by_user = {o.user_id: o for o in obs}
        self.assertTrue(all(o.status == "observed" for o in obs))
        self.assertTrue(by_user["a"].converted_in_window)
        self.assertTrue(by_user["b"].converted_in_window)
        self.assertFalse(by_user["c"].converted_in_window)
        self.assertFalse(by_user["d"].converted_in_window)
        self.assertIn("早于分组", by_user["d"].note)

    def test_pending_until_window_fully_covered(self):
        assignments = [assign("a", "L", "treatment", "2026-03-18 08:00:00")]
        # 覆盖时间差一秒未到窗口结束 → 待观察
        obs, _ = build_observations(assignments, {}, {},
                                    ts("2026-03-25 07:59:59"), "control", "treatment")
        self.assertEqual(obs[0].status, "pending")
        self.assertIsNone(obs[0].converted_in_window)
        # 完整覆盖后，无转化也判定为已观察未转化
        obs2, _ = build_observations(assignments, {}, {},
                                     ts("2026-03-25 08:00:00"), "control", "treatment")
        self.assertEqual(obs2[0].status, "observed")
        self.assertFalse(obs2[0].converted_in_window)

    def test_per_user_coverage_overrides_global(self):
        assignments = [
            assign("a", "L", "control", "2026-03-18 08:00:00"),
            assign("b", "L", "control", "2026-03-01 08:00:00"),
        ]
        per_user = {"a": ts("2026-03-26 00:00:00")}  # a 已完整
        obs, _ = build_observations(assignments, {}, per_user,
                                    ts("2026-03-20 00:00:00"), "control", "treatment")
        status = {o.user_id: o.status for o in obs}
        self.assertEqual(status, {"a": "observed", "b": "observed"})

    def test_missing_coverage_defaults_pending(self):
        obs, _ = build_observations([assign("a", "L", "control", "2026-03-01 08:00:00")],
                                    {"a": ts("2026-03-02 08:00:00")}, {}, None,
                                    "control", "treatment")
        self.assertEqual(obs[0].status, "pending")
        self.assertIn("缺少日志覆盖时间", obs[0].note)

    def test_unknown_conversion_user_warns(self):
        _, warnings = build_observations(
            [assign("a", "L", "control", "2026-03-01 08:00:00")],
            {"ghost": ts("2026-03-02 08:00:00")}, {}, ts("2026-03-20 00:00:00"),
            "control", "treatment")
        self.assertTrue(any("ghost" in w for w in warnings))


class AggregationTests(unittest.TestCase):
    def setUp(self):
        self.result = run_analysis(
            assignments=[
                assign("c1", "L1", "control", "2026-03-01 09:00:00"),
                assign("c2", "L1", "control", "2026-03-01 09:00:00"),
                assign("c3", "L1", "control", "2026-03-01 09:00:00"),
                assign("t1", "L1", "treatment", "2026-03-01 09:00:00"),
                assign("t2", "L1", "treatment", "2026-03-01 09:00:00"),
                assign("t3", "L1", "treatment", "2026-03-01 09:00:00"),
                assign("p1", "L1", "control", "2026-03-18 08:00:00"),
                assign("x1", "L3", "control", "2026-03-01 09:00:00"),
                assign("x2", "L3", "treatment", "2026-03-19 09:00:00"),
            ],
            conversions={
                "c1": ts("2026-03-02 09:00:00"),
                "t1": ts("2026-03-02 09:00:00"),
                "t2": ts("2026-03-03 09:00:00"),
            },
            coverage_per_user={},
            global_coverage=ts("2026-03-20 00:00:00"),
            weights={"L1": 0.8, "L3": 0.2},
            control="control",
            treatment="treatment",
        )

    def test_layer_counts_and_rates(self):
        l1 = self.result.layers["L1"]
        self.assertEqual(l1.groups["control"].observed, 3)
        self.assertEqual(l1.groups["control"].pending, 1)
        self.assertEqual(l1.groups["control"].conversions, 1)
        self.assertEqual(l1.groups["treatment"].observed, 3)
        self.assertEqual(l1.groups["treatment"].conversions, 2)
        self.assertAlmostEqual(l1.diff, 1 / 3)

    def test_weighted_diff_and_insufficient_layer(self):
        l3 = self.result.layers["L3"]
        self.assertFalse(l3.has_valid_diff)
        self.assertEqual(l3.insufficient_reason, "存在已观察人数为 0 的组")
        # L3 有权重但数据不足 → 加权只用 L1；重归一化后等于 L1 差值
        self.assertAlmostEqual(self.result.weighted_diff_renorm, 1 / 3)
        self.assertAlmostEqual(self.result.weighted_diff_raw, 0.8 / 3)
        self.assertAlmostEqual(self.result.weighted_weight_coverage, 0.8)
        self.assertEqual(self.result.weighted_layers_skipped, ["L3"])

    def test_overall_excludes_pending(self):
        ov = self.result.overall
        self.assertEqual(ov.groups["control"].observed, 4)  # L1 三人 + L3 一人
        self.assertEqual(ov.groups["treatment"].observed, 3)
        self.assertEqual(ov.groups["control"].pending, 1)   # p1
        self.assertEqual(ov.groups["treatment"].pending, 1)  # x2
        self.assertAlmostEqual(ov.diff, (2 / 3) - (1 / 4))


class PermutationTests(unittest.TestCase):
    def _result(self, layer_specs, weights=None):
        """layer_specs: {layer: {"control": (n, conv), "treatment": (n, conv)}}"""
        assignments, conversions = [], []
        i = 0
        for layer, spec in layer_specs.items():
            for group, (n, conv) in spec.items():
                for k in range(n):
                    uid = f"u{i}"
                    i += 1
                    assignments.append(assign(uid, layer, group, "2026-03-01 09:00:00"))
                    if k < conv:
                        conversions.append((uid, ts("2026-03-02 09:00:00")))
        return run_analysis(
            assignments, dict(conversions), {}, ts("2026-03-20 00:00:00"),
            weights or {}, "control", "treatment")

    def test_exact_single_layer_matches_fisher(self):
        # 对照 4 人 1 转化，处理 4 人 3 转化；双侧 Fisher p = 34/70
        result = self._result({"L": {"control": (4, 1), "treatment": (4, 3)}}, {"L": 1.0})
        perm = stratified_permutation_test(result)
        self.assertEqual(perm.method, "exact")
        self.assertEqual(perm.n_arrangements, 70)
        self.assertAlmostEqual(perm.p_value, 34 / 70)

    def test_exact_stratified_preserves_group_sizes(self):
        # 两层独立排列：20 × 3 = 60 种
        result = self._result(
            {"L1": {"control": (3, 1), "treatment": (3, 2)},
             "L2": {"control": (2, 0), "treatment": (1, 1)}},
            {"L1": 0.6, "L2": 0.4})
        perm = stratified_permutation_test(result)
        self.assertEqual(perm.method, "exact")
        self.assertEqual(perm.n_arrangements, 60)
        self.assertIsNotNone(perm.p_value)
        self.assertTrue(0.0 < perm.p_value <= 1.0)

    def test_no_variation_layer_excluded(self):
        result = self._result(
            {"flat": {"control": (3, 3), "treatment": (3, 3)},
             "live": {"control": (4, 1), "treatment": (4, 3)}},
            {"flat": 0.5, "live": 0.5})
        perm = stratified_permutation_test(result)
        self.assertEqual(perm.eligible_layers, ["live"])
        self.assertIn("flat", perm.excluded_layers)
        self.assertEqual(perm.n_arrangements, 70)

    def test_insufficient_when_no_eligible_layer(self):
        result = self._result({"flat": {"control": (3, 0), "treatment": (3, 0)}})
        perm = stratified_permutation_test(result)
        self.assertEqual(perm.method, "insufficient")
        self.assertIsNone(perm.p_value)

    def test_monte_carlo_fallback_is_deterministic(self):
        # 8+8 单层精确枚举 12870 种，把 exact_limit 调到 100 强制抽样
        result = self._result({"L": {"control": (8, 2), "treatment": (8, 5)}}, {"L": 1.0})
        p1 = stratified_permutation_test(result, exact_limit=100, mc_replications=500, seed=7)
        p2 = stratified_permutation_test(result, exact_limit=100, mc_replications=500, seed=7)
        self.assertEqual(p1.method, "monte_carlo")
        self.assertEqual(p1.p_value, p2.p_value)
        self.assertEqual(p1.n_arrangements, 501)
        self.assertTrue(0.0 < p1.p_value <= 1.0)

    def test_unweighted_layer_uses_default_weight(self):
        result = self._result({"L": {"control": (4, 1), "treatment": (4, 3)}})
        perm = stratified_permutation_test(result)
        self.assertEqual(perm.eligible_layers, ["L"])
        self.assertAlmostEqual(perm.p_value, 34 / 70)


class CliEndToEndTests(unittest.TestCase):
    def test_sample_data_run(self):
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            rc = cli_main([
                "--assignments", str(SAMPLE / "assignments.csv"),
                "--conversions", str(SAMPLE / "conversions.csv"),
                "--weights", str(SAMPLE / "weights.csv"),
                "--coverage", str(SAMPLE / "coverage.txt"),
            ])
        finally:
            sys.stdout = old
        self.assertEqual(rc, 0)
        text = buf.getvalue()
        self.assertIn("实验分析报告", text)
        self.assertIn("数据不足", text)          # L3 处理组无已观察
        self.assertIn("精确枚举", text)          # 600 种排列，走精确
        self.assertIn("双侧 p 值", text)
        self.assertIn("u99", text)               # 幽灵用户告警

    def test_sample_csv_outputs(self):
        out_dir = SAMPLE / "_test_out"
        out_dir.mkdir(exist_ok=True)
        obs_path = out_dir / "observations.csv"
        sum_path = out_dir / "summary.csv"
        rc = cli_main([
            "--assignments", str(SAMPLE / "assignments.csv"),
            "--conversions", str(SAMPLE / "conversions.csv"),
            "--weights", str(SAMPLE / "weights.csv"),
            "--coverage", "2026-03-20 00:00:00",
            "--out-observations", str(obs_path),
            "--out-summary", str(sum_path),
        ])
        self.assertEqual(rc, 0)
        obs_text = obs_path.read_text(encoding="utf-8")
        self.assertIn("u07", obs_text)
        self.assertIn("pending", obs_text)
        sum_text = sum_path.read_text(encoding="utf-8")
        self.assertIn("overall", sum_text)
        for p in (obs_path, sum_path):
            p.unlink()
        out_dir.rmdir()


if __name__ == "__main__":
    unittest.main()
