"""核心行为测试：正确性、增量影响范围、预览过期、中断续跑。"""

import datetime as dt
import json
import os
import tempfile
import unittest

from metriccalc.config import config_from_text
from metriccalc.planner import (
    PlanError,
    build_plan,
    execute_plan,
    needed_windows,
    plan_to_json,
    verify_preview,
)
from metriccalc.store import Store

CONFIG = {
    "anchor": "2026-01-01",
    "nodes": [
        {"name": "orders", "type": "source", "source": "orders", "missing": "zero"},
        {"name": "orders_7d", "type": "sum", "inputs": [{"node": "orders", "from": -6, "to": 0}]},
        {"name": "orders_7d_prev", "type": "sum",
         "inputs": [{"node": "orders_7d", "from": -7, "to": -7}]},
        {"name": "orders_7d_wow", "type": "sum",
         "inputs": [{"node": "orders_7d"}, {"node": "orders_7d_prev", "weight": -1}]},
        {"name": "cum_orders", "type": "sum",
         "inputs": [{"node": "orders", "from": "start", "to": 0}]},
    ],
}


def d(text):
    return dt.date.fromisoformat(text)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "t.db")
        self.config_path = os.path.join(self.tmp.name, "config.json")
        self.write_config(CONFIG)
        self.store = Store(self.db)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def write_config(self, obj):
        with open(self.config_path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False)

    def config(self):
        with open(self.config_path, "r", encoding="utf-8") as fh:
            return config_from_text(fh.read(), self.config_path)

    def load_values(self, source, start, end, fn):
        for i in range((d(end) - d(start)).days + 1):
            day = d(start) + dt.timedelta(days=i)
            self.store.set_source_value(source, day.isoformat(), fn(i))

    def run_plan(self, plan, stop_after=None):
        run_id = self.store.create_run(
            "p", plan.config.sig, plan.target, plan.start.isoformat(),
            plan.end.isoformat(), len(plan.recompute), len(plan.reuse),
        )
        return execute_plan(self.store, plan, run_id, stop_after=stop_after)

    def value(self, node, day):
        part = self.store.get_partition(node, day)
        self.assertIsNotNone(part, "%s@%s 不存在" % (node, day))
        self.assertEqual(part.status, "done", "%s@%s 状态 %s" % (node, day, part.status))
        return part.value

    def preview(self, target, start, end):
        plan = build_plan(self.store, self.config(), target, d(start), d(end))
        pid = self.store.create_preview(
            self.config_path, plan.config.sig, target, start, end,
            plan.inputs_sig, plan.inputs_json, plan.plan_sig, plan_to_json(plan),
        )
        return plan, pid

    def assert_done_for_windows(self, config, target, start, end):
        windows = needed_windows(config, target, d(start), d(end))
        for node, intervals in windows.items():
            expect = set()
            for lo, hi in intervals:
                day = lo
                while day <= hi:
                    expect.add(day.isoformat())
                    day += dt.timedelta(days=1)
            actual = set()
            for lo, hi in intervals:
                actual |= {
                    r.date
                    for r in self.store.get_partitions(node, lo.isoformat(), hi.isoformat())
                    if r.status == "done"
                }
            self.assertEqual(actual, expect, "节点 %s 的分区覆盖不符" % node)


class TestCorrectness(Base):
    def test_rolling_values_and_reuse_across_runs(self):
        self.load_values("orders", "2026-01-01", "2026-01-14", lambda i: i + 1)

        # 第一轮：只算 7 日滚动指标
        plan = build_plan(self.store, self.config(), "orders_7d", d("2026-01-01"), d("2026-01-12"))
        self.assertTrue(self.run_plan(plan).ok)
        self.assertAlmostEqual(self.value("orders_7d", "2026-01-07"), 28)  # 1..7
        self.assertAlmostEqual(self.value("orders_7d", "2026-01-12"), sum(range(6, 13)))

        # 第二轮：周对比。它需要的 orders_7d 分区大多已存在，应复用
        plan2 = build_plan(self.store, self.config(), "orders_7d_wow", d("2026-01-08"), d("2026-01-12"))
        reused_7d = {r.date for r in plan2.reuse if r.node == "orders_7d"}
        self.assertIn(d("2026-01-08"), reused_7d)
        result = self.run_plan(plan2)
        self.assertTrue(result.ok, result.error)
        self.assertAlmostEqual(
            self.value("orders_7d_wow", "2026-01-08"),
            self.value("orders_7d", "2026-01-08") - self.value("orders_7d", "2026-01-01"),
        )

        # 累计指标是一条独立分支
        plan3 = build_plan(self.store, self.config(), "cum_orders", d("2026-01-01"), d("2026-01-12"))
        self.assertTrue(self.run_plan(plan3).ok)
        self.assertAlmostEqual(self.value("cum_orders", "2026-01-12"), sum(range(1, 13)))
        self.assertAlmostEqual(self.value("cum_orders", "2026-01-01"), 1.0)

    def test_windows_cover_exactly_needed_days(self):
        self.load_values("orders", "2025-12-20", "2026-01-20", lambda i: 1)
        plan = build_plan(self.store, self.config(), "orders_7d_wow", d("2026-01-01"), d("2026-01-20"))
        self.assertTrue(self.run_plan(plan).ok)
        self.assert_done_for_windows(self.config(), "orders_7d_wow", "2026-01-01", "2026-01-20")
        # 投影之外的累计节点不应被顺手计算
        self.assertIsNone(self.store.get_partition("cum_orders", "2026-01-20"))

    def test_wow_window_extends_before_target_start(self):
        # 目标从 01-08 开始，但 01-08 的周对比要读 01-01 的 orders_7d，
        # 因此 orders_7d 的窗口下界必须扩展到 01-01（目标范围之外的上游）
        windows = needed_windows(self.config(), "orders_7d_wow", d("2026-01-08"), d("2026-01-10"))
        earliest = min(lo for lo, _ in windows["orders_7d"])
        self.assertEqual(earliest, d("2026-01-01"))
        # 源数据的窗口也随之向更早延伸
        self.assertEqual(min(lo for lo, _ in windows["orders"]), d("2025-12-26"))

    def test_week_over_week_needs_only_needed_days(self):
        # 目标只有 01-20：wow 读 7d@01-20；prev@01-20 读 7d@01-13
        windows = needed_windows(self.config(), "orders_7d_wow", d("2026-01-20"), d("2026-01-20"))
        self.assertEqual(
            windows["orders_7d"],
            [(d("2026-01-13"), d("2026-01-13")), (d("2026-01-20"), d("2026-01-20"))],
        )
        # 源数据只需 7d@01-13 与 7d@01-20 各自的 7 天窗口（相邻后合并为一段）
        self.assertEqual(windows["orders"], [(d("2026-01-07"), d("2026-01-20"))])


class TestIncremental(Base):
    def setUp(self):
        super().setUp()
        self.load_values("orders", "2026-01-01", "2026-01-14", lambda i: i + 1)
        plan, pid = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        self.run_plan(plan)
        self.assertGreater(len(plan.recompute), 0)

    def test_second_preview_reuses_everything(self):
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        self.assertEqual(plan.recompute, [])
        self.assertGreater(len(plan.reuse), 0)

    def test_change_affects_only_real_window(self):
        # 改 2026-01-07：任何窗口含 01-07 的分区都要重算
        self.store.set_source_value("orders", "2026-01-07", 100)
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        # 7d@d 读 [d-6, d]，含 01-07 的 d 是 01-07..01-13；这些日期都在已算窗口内
        self.assertEqual(
            {r.date for r in plan.recompute if r.node == "orders_7d"},
            {d("2026-01-%02d" % x) for x in range(7, 14)},
        )
        # 01-14 的 7 日窗口是 01-08..01-14，不含 01-07，应复用
        self.assertIn(d("2026-01-14"), {r.date for r in plan.reuse if r.node == "orders_7d"})
        # 源节点只重算那 1 天
        self.assertEqual({r.date for r in plan.recompute if r.node == "orders"}, {d("2026-01-07")})
        # wow(d) = 7d(d) - prev(d)，prev(d) = 7d(d-7)
        #   d 直接读 7d(d)：受影响 d = 01-07..01-13 ∩ 目标 = 01-08..01-13
        #   prev(d) 读 7d(d-7)：d-7 ∈ 01-07..01-13 → d ∈ 01-14..01-20 ∩ 目标 = 01-14
        self.assertEqual(
            {r.date for r in plan.recompute if r.node == "orders_7d_wow"},
            {d("2026-01-%02d" % x) for x in range(8, 15)},
        )

    def test_backfill_missing_date_is_detected(self):
        """某天原本没有源值（按 0），算完后补录——缺失也作为输入记录，必须重算。"""
        self.store.set_source_value("orders", "2026-01-06", None)
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        self.run_plan(plan)

        self.store.set_source_value("orders", "2026-01-06", 6)
        plan2, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        # 01-08 的 7 日窗口覆盖 01-02..01-08，包含补录的 01-06
        self.assertTrue(name_in(plan2.recompute, "orders_7d", d("2026-01-08")))
        self.assertEqual({r.date for r in plan2.recompute if r.node == "orders"},
                         {d("2026-01-06")})

    def test_change_outside_windows_changes_nothing(self):
        self.store.set_source_value("orders", "2026-01-20", 50)
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        self.assertEqual(plan.recompute, [])

    def test_rule_change_invalidates_node_and_downstream_only(self):
        new = dict(CONFIG)
        new["nodes"] = [dict(n) for n in CONFIG["nodes"]]
        new["nodes"][3]["inputs"] = [
            {"node": "orders_7d"}, {"node": "orders_7d_prev", "weight": -2}
        ]
        self.write_config(new)
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        re_nodes = {r.node for r in plan.recompute}
        self.assertIn("orders_7d_wow", re_nodes)
        self.assertNotIn("orders_7d", re_nodes, "与权重无关的上游不应被重算")
        self.assertNotIn("orders", re_nodes)

    def test_cosmetic_config_edit_does_not_count_as_rule_change(self):
        new = {
            "nodes": [
                # 省略默认 missing；offset 写法替代 from/to；输入顺序调整
                {"name": "orders", "type": "source", "source": "orders"},
                {"name": "orders_7d", "type": "sum",
                 "inputs": [{"node": "orders", "from": -6, "to": 0}]},
                {"name": "orders_7d_prev", "type": "sum",
                 "inputs": [{"node": "orders_7d", "offset": -7}]},
                {"name": "orders_7d_wow", "type": "sum",
                 "inputs": [{"node": "orders_7d_prev", "weight": -1},
                            {"node": "orders_7d", "offset": 0}]},
                {"name": "cum_orders", "type": "sum",
                 "inputs": [{"node": "orders", "from": "start", "to": 0}]},
            ],
            "anchor": "2026-01-01",
        }
        self.write_config(new)
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        self.assertEqual(plan.recompute, [], "仅调整写法/顺序不应触发重算")


def name_in(rows, node, day):
    return any(r.node == node and r.date == day for r in rows)


class TestPreviewExpiry(Base):
    def test_source_change_after_preview_blocks_apply(self):
        self.load_values("orders", "2026-01-01", "2026-01-12", lambda i: i + 1)
        plan, pid = self.preview("orders_7d", "2026-01-08", "2026-01-12")
        self.store.set_source_value("orders", "2026-01-09", 999)
        with self.assertRaises(PlanError) as ctx:
            verify_preview(self.store, pid)
        msg = str(ctx.exception)
        self.assertIn("重新预览", msg)
        self.assertIn("2026-01-09", msg)
        self.assertIn("999", msg)

    def test_apply_on_fresh_preview_succeeds(self):
        self.load_values("orders", "2026-01-01", "2026-01-12", lambda i: i + 1)
        plan, pid = self.preview("orders_7d", "2026-01-08", "2026-01-12")
        fresh = verify_preview(self.store, pid)
        self.assertEqual(fresh.plan_sig, plan.plan_sig)

    def test_applied_preview_cannot_be_reapplied(self):
        self.load_values("orders", "2026-01-01", "2026-01-12", lambda i: i + 1)
        plan, pid = self.preview("orders_7d", "2026-01-08", "2026-01-12")
        self.run_plan(plan)
        self.store.mark_preview_applied(pid)
        with self.assertRaises(PlanError) as ctx:
            verify_preview(self.store, pid)
        self.assertIn("执行过", str(ctx.exception))


class TestResume(Base):
    def test_interrupt_then_resume_reuses_done_partitions(self):
        self.load_values("orders", "2026-01-01", "2026-01-14", lambda i: i + 1)
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        first = self.run_plan(plan, stop_after=4)
        self.assertTrue(first.interrupted)
        self.assertEqual(first.worked, 4)

        plan2, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        self.assertEqual(len(plan2.reuse), 4, "已算完且输入未变的分区应复用")
        self.assertGreater(len(plan2.recompute), 0)
        second = self.run_plan(plan2)
        self.assertTrue(second.ok)
        self.assertEqual(self.store.pending_partitions(limit=100), [])

    def test_interrupt_mid_partition_then_resume(self):
        """模拟"写入 pending 后还没算完就退出"。"""
        self.load_values("orders", "2026-01-01", "2026-01-14", lambda i: i + 1)
        plan, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        first_row = plan.recompute[0]
        self.store.insert_pending(
            [(first_row.node, first_row.date.isoformat(),
              plan.config.nodes[first_row.node].rule_sig, "x", None)], "run-x")
        plan2, _ = self.preview("orders_7d_wow", "2026-01-08", "2026-01-14")
        self.assertTrue(name_in(plan2.recompute, first_row.node, first_row.date))
        self.assertTrue(any(r.kind == "pending" for r in plan2.recompute))


class TestConfigValidation(unittest.TestCase):
    def test_cycle_detected(self):
        cfg = {"nodes": [
            {"name": "a", "type": "sum", "inputs": [{"node": "b", "offset": -1}]},
            {"name": "b", "type": "sum", "inputs": [{"node": "a", "offset": -1}]},
        ]}
        with self.assertRaises(Exception) as ctx:
            config_from_text(json.dumps(cfg))
        self.assertIn("循环", str(ctx.exception))

    def test_future_offset_rejected(self):
        cfg = {"nodes": [
            {"name": "s", "type": "source", "source": "s"},
            {"name": "x", "type": "sum", "inputs": [{"node": "s", "offset": 1}]},
        ]}
        with self.assertRaises(Exception) as ctx:
            config_from_text(json.dumps(cfg))
        self.assertIn("未来", str(ctx.exception))

    def test_unknown_node_rejected(self):
        cfg = {"nodes": [
            {"name": "s", "type": "source", "source": "s"},
            {"name": "x", "type": "sum", "inputs": [{"node": "nope"}]},
        ]}
        with self.assertRaises(Exception) as ctx:
            config_from_text(json.dumps(cfg))
        self.assertIn("不存在", str(ctx.exception))

    def test_start_without_anchor_rejected_at_plan(self):
        cfg = {"nodes": [
            {"name": "s", "type": "source", "source": "s"},
            {"name": "x", "type": "sum", "inputs": [{"node": "s", "from": "start", "to": 0}]},
        ]}
        store = Store(":memory:")
        try:
            config = config_from_text(json.dumps(cfg))
            with self.assertRaises(PlanError) as ctx:
                build_plan(store, config, "x", dt.date(2026, 1, 1), dt.date(2026, 1, 2))
            self.assertIn("anchor", str(ctx.exception))
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
