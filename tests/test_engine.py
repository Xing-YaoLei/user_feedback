"""端到端测试：覆盖双时态查询、冲突回退、快照复现、增量重算。

运行：python -m unittest tests.test_engine -v
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from backcalc import engine
from backcalc.io_utils import CalibrationRow, MeasurementRow
from backcalc.store import Store
from backcalc.timeutil import normalize_ts


def cal(cal_id, instrument, registered_at, valid_from, coefficient,
        valid_to=None):
    return CalibrationRow(
        cal_id=cal_id, instrument=instrument,
        registered_at=normalize_ts(registered_at),
        valid_from=normalize_ts(valid_from),
        valid_to=normalize_ts(valid_to) if valid_to else None,
        coefficient=coefficient)


def meas(mid, instrument, measured_at, raw):
    return MeasurementRow(
        measurement_id=mid, instrument=instrument,
        measured_at=normalize_ts(measured_at), raw_reading=raw)


class BackcalcTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "test.db")
        self.store = Store(self.db_path)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def import_cals(self, rows):
        with self.store.transaction():
            bid = self.store.add_batch("calibration", "mem", len(rows))
            self.store.upsert_calibrations(rows, bid)

    def import_meas(self, rows):
        with self.store.transaction():
            bid = self.store.add_batch("measurement", "mem", len(rows))
            self.store.upsert_measurements(rows, bid)

    def result_map(self, run_id):
        return {r["measurement_id"]: r
                for r in self.store.list_results(run_id)}


class AsOfSelectionTests(BackcalcTestBase):
    def test_latest_registered_wins_and_half_open_interval(self):
        # C1 先登记、区间长；C2 后登记、区间只覆盖 6 月
        self.import_cals([
            cal("C1", "I1", "2026-05-01T00:00:00Z",
                "2026-01-01T00:00:00Z", "2"),
            cal("C2", "I1", "2026-06-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "3",
                valid_to="2026-07-01T00:00:00Z"),
        ])
        self.import_meas([
            meas("M1", "I1", "2026-06-15T00:00:00Z", 10),   # C2 覆盖
            meas("M2", "I1", "2026-07-01T00:00:00Z", 10),   # 区间左闭右开，C2 不覆盖
            meas("M3", "I1", "2026-05-15T00:00:00Z", 10),   # 只有 C1
        ])

        # 截止 6/2：两条都已登记
        run = engine.ensure_run(self.store,
                                normalize_ts("2026-06-02T00:00:00Z"))
        rm = self.result_map(run.run_id)
        self.assertEqual(rm["M1"]["cal_id"], "C2")
        self.assertEqual(rm["M1"]["calibrated"], 30.0)
        self.assertEqual(rm["M2"]["cal_id"], "C1")      # 开区间边界
        self.assertEqual(rm["M2"]["calibrated"], 20.0)
        self.assertEqual(rm["M3"]["cal_id"], "C1")

        # 截止 5/2：C2 尚未登记，M1 只能用 C1
        run_early = engine.ensure_run(self.store,
                                      normalize_ts("2026-05-02T00:00:00Z"))
        rm_early = self.result_map(run_early.run_id)
        self.assertEqual(rm_early["M1"]["cal_id"], "C1")
        self.assertEqual(rm_early["M1"]["calibrated"], 20.0)

    def test_uncalibrated_when_no_covering_record(self):
        self.import_cals([
            cal("C1", "I1", "2026-05-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "2"),
        ])
        self.import_meas([
            meas("M1", "I1", "2026-05-15T00:00:00Z", 10),  # 区间外
        ])
        run = engine.ensure_run(self.store,
                                normalize_ts("2026-06-01T00:00:00Z"))
        row = self.result_map(run.run_id)["M1"]
        self.assertEqual(row["status"], "uncalibrated")
        self.assertIsNone(row["cal_id"])
        self.assertIsNone(row["calibrated"])

    def test_formula_coefficient(self):
        self.import_cals([
            cal("C1", "I1", "2026-05-01T00:00:00Z",
                "2026-01-01T00:00:00Z", "x*1.5+0.2"),
        ])
        self.import_meas([meas("M1", "I1", "2026-05-15T00:00:00Z", 4)])
        run = engine.ensure_run(self.store,
                                normalize_ts("2026-06-01T00:00:00Z"))
        self.assertEqual(
            self.result_map(run.run_id)["M1"]["calibrated"], 6.2)


class ConflictTests(BackcalcTestBase):
    def test_conflict_falls_back_to_last_valid(self):
        self.import_cals([
            cal("C1", "I1", "2026-05-01T00:00:00Z",
                "2026-01-01T00:00:00Z", "2"),
            # C2/C3 同一登记时刻，区间在 6/15 重叠
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "3"),
            cal("C3", "I1", "2026-07-01T00:00:00Z",
                "2026-06-15T00:00:00Z", "4",
                valid_to="2026-08-01T00:00:00Z"),
        ])
        self.import_meas([
            meas("M1", "I1", "2026-06-20T00:00:00Z", 10),  # C2/C3 冲突 → 回退 C1
            meas("M2", "I1", "2026-06-10T00:00:00Z", 10),  # 只被 C2 覆盖，无冲突
        ])
        run = engine.ensure_run(self.store,
                                normalize_ts("2026-08-01T00:00:00Z"))
        rm = self.result_map(run.run_id)

        m1 = rm["M1"]
        self.assertEqual(m1["status"], "calibrated")       # 保留上次有效结果
        self.assertEqual(m1["cal_id"], "C1")
        self.assertEqual(m1["calibrated"], 20.0)
        self.assertEqual(json.loads(m1["conflict_cal_ids"]),
                         ["C2", "C3"])                     # 同时指出冲突

        m2 = rm["M2"]
        self.assertEqual(m2["cal_id"], "C2")
        self.assertEqual(m2["status"], "calibrated")
        self.assertIsNone(m2["conflict_cal_ids"])

    def test_unresolved_conflict_when_no_fallback(self):
        self.import_cals([
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "3"),
            cal("C3", "I1", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "4"),
        ])
        self.import_meas([meas("M1", "I1", "2026-06-20T00:00:00Z", 10)])
        run = engine.ensure_run(self.store,
                                normalize_ts("2026-08-01T00:00:00Z"))
        row = self.result_map(run.run_id)["M1"]
        self.assertEqual(row["status"], "conflict")
        self.assertIsNone(row["cal_id"])
        self.assertIsNone(row["calibrated"])
        self.assertEqual(json.loads(row["conflict_cal_ids"]),
                         ["C2", "C3"])

    def test_conflicts_listing(self):
        self.import_cals([
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "3"),
            cal("C3", "I1", "2026-07-01T00:00:00Z",
                "2026-06-15T00:00:00Z", "4"),
            # 不重叠的同刻记录不算冲突
            cal("C4", "I2", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "1",
                valid_to="2026-06-10T00:00:00Z"),
            cal("C5", "I2", "2026-07-01T00:00:00Z",
                "2026-06-10T00:00:00Z", "1"),
        ])
        conflicts = engine.list_conflicts(self.store)
        pairs = {(c["cal_id_a"], c["cal_id_b"]) for c in conflicts}
        self.assertEqual(pairs, {("C2", "C3")})


class IncrementalRecomputeTests(BackcalcTestBase):
    def _baseline_data(self):
        self.import_cals([
            cal("C1", "I1", "2026-05-01T00:00:00Z",
                "2026-01-01T00:00:00Z", "2"),
            cal("C9", "I2", "2026-05-01T00:00:00Z",
                "2026-01-01T00:00:00Z", "10"),
        ])
        self.import_meas([
            meas("M1", "I1", "2026-06-15T00:00:00Z", 10),
            meas("M2", "I1", "2026-06-16T00:00:00Z", 5),
            meas("M9", "I2", "2026-06-15T00:00:00Z", 3),
        ])

    def test_incremental_change_list_and_isolation(self):
        self._baseline_data()
        first = engine.ensure_run(
            self.store, normalize_ts("2026-06-01T00:00:00Z"))
        self.assertEqual(first.reused, False)
        self.assertEqual(first.changes, [])  # 基线全量，无前后对比

        rm1 = self.result_map(first.run_id)
        self.assertEqual(rm1["M1"]["cal_id"], "C1")
        self.assertEqual(rm1["M9"]["cal_id"], "C9")

        # 事后补录：C2 登记于 7/1，只覆盖 6 月的 I1
        self.import_cals([
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "3",
                valid_to="2026-07-01T00:00:00Z"),
        ])
        second = engine.ensure_run(
            self.store, normalize_ts("2026-08-01T00:00:00Z"))
        self.assertEqual(second.reused, False)

        changed_ids = {c["measurement_id"] for c in second.changes}
        self.assertEqual(changed_ids, {"M1", "M2"})       # I2 的 M9 不受影响
        ch = {c["measurement_id"]: c for c in second.changes}
        self.assertEqual(ch["M1"]["old_cal_id"], "C1")
        self.assertEqual(ch["M1"]["old_calibrated"], 20.0)
        self.assertEqual(ch["M1"]["new_cal_id"], "C2")
        self.assertEqual(ch["M1"]["new_calibrated"], 30.0)
        self.assertEqual(ch["M2"]["new_calibrated"], 15.0)

        rm2 = self.result_map(second.run_id)
        self.assertEqual(rm2["M9"]["cal_id"], "C9")       # 未受影响，值保留
        self.assertEqual(rm2["M9"]["calibrated"], 30.0)

    def test_snapshot_reproducibility_after_backfill(self):
        self._baseline_data()
        cutoff1 = normalize_ts("2026-06-01T00:00:00Z")
        first = engine.ensure_run(self.store, cutoff1)
        before = {k: (v["cal_id"], v["calibrated"], v["status"])
                  for k, v in self.result_map(first.run_id).items()}

        # 补录登记时间更晚的记录
        self.import_cals([
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "3"),
        ])
        engine.ensure_run(self.store,
                          normalize_ts("2026-08-01T00:00:00Z"))

        # 用原截止时间再次查询：必须得到当时的结果，且复用快照
        again = engine.ensure_run(self.store, cutoff1)
        self.assertTrue(again.reused)
        self.assertEqual(again.run_id, first.run_id)
        after = {k: (v["cal_id"], v["calibrated"], v["status"])
                 for k, v in self.result_map(again.run_id).items()}
        self.assertEqual(before, after)

    def test_new_record_does_not_affect_earlier_cutoff_runs(self):
        self._baseline_data()
        engine.ensure_run(self.store,
                          normalize_ts("2026-06-01T00:00:00Z"))
        # C2 登记于 7/1
        self.import_cals([
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-01-01T00:00:00Z", "3"),
        ])
        # 截止 6/15 的查询看不到 C2
        run = engine.ensure_run(
            self.store, normalize_ts("2026-06-15T00:00:00Z"))
        rm = self.result_map(run.run_id)
        self.assertEqual(rm["M1"]["cal_id"], "C1")
        self.assertEqual(rm["M1"]["calibrated"], 20.0)

    def test_new_measurement_batch_picked_up_incrementally(self):
        self._baseline_data()
        engine.ensure_run(self.store,
                          normalize_ts("2026-06-01T00:00:00Z"))
        # 之后又补录一批测量明细
        self.import_meas([meas("M3", "I1", "2026-06-17T00:00:00Z", 8)])
        run = engine.ensure_run(
            self.store, normalize_ts("2026-08-01T00:00:00Z"))
        rm = self.result_map(run.run_id)
        self.assertIn("M3", rm)
        self.assertEqual(rm["M3"]["calibrated"], 16.0)
        # 新测量进入变更清单（old 为空）
        ch = {c["measurement_id"]: c for c in run.changes}
        self.assertIn("M3", ch)
        self.assertIsNone(ch["M3"]["old_status"])
        self.assertEqual(ch["M3"]["new_cal_id"], "C1")

    def test_source_unchanged_means_no_change_recorded(self):
        # 补录的记录区间不覆盖任何已有测量 → 无来源变化
        self._baseline_data()
        engine.ensure_run(self.store,
                          normalize_ts("2026-06-01T00:00:00Z"))
        self.import_cals([
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-09-01T00:00:00Z", "3"),  # 9 月才生效
        ])
        run = engine.ensure_run(
            self.store, normalize_ts("2026-08-01T00:00:00Z"))
        self.assertEqual(run.changes, [])

    def test_uncalibrated_to_calibrated_transition(self):
        self.import_cals([
            cal("C1", "I1", "2026-05-01T00:00:00Z",
                "2026-07-01T00:00:00Z", "2"),
        ])
        self.import_meas([meas("M1", "I1", "2026-06-15T00:00:00Z", 10)])
        first = engine.ensure_run(
            self.store, normalize_ts("2026-06-01T00:00:00Z"))
        self.assertEqual(
            self.result_map(first.run_id)["M1"]["status"],
            "uncalibrated")

        # 补录一条覆盖 6 月的旧区间校准（登记时间晚）
        self.import_cals([
            cal("C2", "I1", "2026-08-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "4",
                valid_to="2026-07-01T00:00:00Z"),
        ])
        second = engine.ensure_run(
            self.store, normalize_ts("2026-09-01T00:00:00Z"))
        ch = {c["measurement_id"]: c for c in second.changes}
        self.assertEqual(ch["M1"]["old_status"], "uncalibrated")
        self.assertIsNone(ch["M1"]["old_cal_id"])
        self.assertEqual(ch["M1"]["new_status"], "calibrated")
        self.assertEqual(ch["M1"]["new_cal_id"], "C2")
        self.assertEqual(ch["M1"]["new_calibrated"], 40.0)

    def test_non_monotonic_cutoff_queries(self):
        # 查询顺序为 晚 → 早 → 中间，任意顺序结果都只取决于 cutoff 本身
        self.import_cals([
            cal("C1", "I1", "2026-05-01T00:00:00Z",
                "2026-01-01T00:00:00Z", "2"),
            cal("C2", "I1", "2026-07-01T00:00:00Z",
                "2026-06-01T00:00:00Z", "3"),
        ])
        self.import_meas([meas("M1", "I1", "2026-06-15T00:00:00Z", 10)])

        late = engine.ensure_run(
            self.store, normalize_ts("2026-08-01T00:00:00Z"))
        self.assertEqual(self.result_map(late.run_id)["M1"]["cal_id"], "C2")

        early = engine.ensure_run(
            self.store, normalize_ts("2026-05-02T00:00:00Z"))
        self.assertEqual(self.result_map(early.run_id)["M1"]["cal_id"], "C1")

        # 中间 cutoff：上一快照是更早的 5/2 run，应增量纳入 C2
        middle = engine.ensure_run(
            self.store, normalize_ts("2026-07-15T00:00:00Z"))
        rm_mid = self.result_map(middle.run_id)
        self.assertEqual(rm_mid["M1"]["cal_id"], "C2")
        self.assertEqual(rm_mid["M1"]["calibrated"], 30.0)
        ch = {c["measurement_id"]: c for c in middle.changes}
        self.assertEqual(ch["M1"]["old_cal_id"], "C1")
        self.assertEqual(ch["M1"]["new_cal_id"], "C2")

        # 三个快照各自独立，重查仍复现
        again_early = engine.ensure_run(
            self.store, normalize_ts("2026-05-02T00:00:00Z"))
        self.assertTrue(again_early.reused)
        self.assertEqual(
            self.result_map(again_early.run_id)["M1"]["cal_id"], "C1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
