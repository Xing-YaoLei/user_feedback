"""端到端集成测试:测试源 + 采集器 + SQLite。

覆盖:历史重放、重复去重、中途截断续传、保留期耗尽(缺口)、
落库前/后崩溃恢复、无 id 事件去重边界、多行 data 与心跳。
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sse_collect.collector import Collector
from sse_collect.source import Scenario, SourceServer
from sse_collect.store import Store


def wait_for(cond, timeout=10.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


class IntegrationBase(unittest.TestCase):
    scenario = Scenario()

    def setUp(self):
        self.store = Store(":memory:")
        self.source = SourceServer(self.scenario)
        self.source.start_background()

    def tearDown(self):
        self.source.shutdown()
        self.source.server_close()
        self.store.close()

    def make_collector(self, **kw):
        kw.setdefault("reconnect_ms", 50)
        col = Collector(self.store, self.source.url, "s", **kw)
        col.start()
        return col

    def run_until_done(self, col, timeout=10.0):
        self.assertTrue(
            wait_for(lambda: not col.running, timeout),
            f"collector did not finish; error={col.error}",
        )


class TestReplayAndDedup(IntegrationBase):
    scenario = Scenario(history=8, dups=2, interval_ms=1)

    def test_replay_with_duplicates_deduped(self):
        col = self.make_collector()
        self.run_until_done(col)
        stats = self.store.stats("s")
        self.assertEqual(stats["events"], 8)          # 每条事件重发 3 次,只留 1 条
        self.assertEqual(stats["raw_events"], 24)     # 原始报文全部留存
        self.assertEqual(stats["duplicates_dropped"], 16)
        self.assertEqual(self.store.get_cursor("s"), ("8", True))
        self.assertEqual(self.store.list_gaps("s"), [])


class TestTruncateResume(IntegrationBase):
    scenario = Scenario(history=8, truncate_at=4, truncate_bytes=5, interval_ms=1)

    def test_mid_stream_truncate_resumes_from_cursor(self):
        col = self.make_collector()
        self.run_until_done(col)
        stats = self.store.stats("s")
        # 事件 4 被截断丢弃,重连后从游标(3)续传补齐
        self.assertEqual(stats["events"], 8)
        ids = [r["event_id"] for r in self.store.timeline("s")]
        self.assertEqual(ids, [str(i) for i in range(1, 9)])
        self.assertEqual(self.store.get_cursor("s"), ("8", True))
        self.assertEqual(self.store.list_gaps("s"), [])


class TestRetentionExhausted(IntegrationBase):
    scenario = Scenario(history=8, retention_from=5, interval_ms=1)

    def test_gap_recorded_and_no_false_continuity(self):
        self.store.set_cursor("s", "2")  # 游标落在保留期(5)之外
        col = self.make_collector()
        self.run_until_done(col)

        self.assertTrue(col.completed)  # stop 策略:停下等待人工介入
        last_id, contiguous = self.store.get_cursor("s")
        self.assertEqual(last_id, "2")       # 没有偷偷跳到最新位置
        self.assertFalse(contiguous)         # 明确标记非连续
        gaps = self.store.list_gaps("s")
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["reason"], "retention_exhausted")
        self.assertEqual(self.store.stats("s")["events"], 0)

    def test_jump_policy_still_not_contiguous(self):
        self.store.set_cursor("s", "2")
        col = self.make_collector(gap_policy="jump")
        # jump 策略:放弃旧位置从保留期起点重拉,但 contiguous 必须保持 0
        self.assertTrue(wait_for(lambda: self.store.stats("s")["events"] >= 4))
        col.stop()
        _, contiguous = self.store.get_cursor("s")
        self.assertFalse(contiguous)
        self.assertEqual(self.store.list_gaps("s")[0]["reason"], "retention_exhausted")


class TestSequenceGap(IntegrationBase):
    scenario = Scenario(history=8, skip=5, interval_ms=1)

    def test_sequence_jump_detected(self):
        col = self.make_collector()
        self.run_until_done(col)
        gaps = self.store.list_gaps("s")
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["reason"], "sequence_gap")
        self.assertEqual((gaps[0]["from_id"], gaps[0]["to_id"]), ("4", "6"))
        _, contiguous = self.store.get_cursor("s")
        self.assertFalse(contiguous)


class TestCrashRecovery(IntegrationBase):
    scenario = Scenario(history=6, interval_ms=1)

    def test_crash_before_commit_loses_nothing_confirmed(self):
        col = self.make_collector(crash_before_commit_at=3)
        self.assertTrue(wait_for(lambda: not col.running))
        self.assertIn("injected crash", col.error or "")
        # 第 3 次提交在落库前崩溃并回滚:只有 2 条已确认
        self.assertEqual(self.store.stats("s")["events"], 2)
        self.assertEqual(self.store.get_cursor("s"), ("2", True))

        # 重启采集器:从游标续传,事件 3 会被重传并正常落库
        col2 = self.make_collector()
        self.run_until_done(col2)
        stats = self.store.stats("s")
        self.assertEqual(stats["events"], 6)
        ids = [r["event_id"] for r in self.store.timeline("s")]
        self.assertEqual(ids, [str(i) for i in range(1, 7)])

    def test_crash_after_commit_no_loss_no_dup(self):
        col = self.make_collector(crash_after_commit_at=3)
        self.assertTrue(wait_for(lambda: not col.running))
        self.assertIn("injected crash", col.error or "")
        # 第 3 次提交已落库才崩溃:3 条都已确认,游标在 3
        self.assertEqual(self.store.stats("s")["events"], 3)
        self.assertEqual(self.store.get_cursor("s"), ("3", True))

        col2 = self.make_collector()
        self.run_until_done(col2)
        stats = self.store.stats("s")
        self.assertEqual(stats["events"], 6)            # 已确认事件一条不丢
        self.assertEqual(stats["duplicates_dropped"], 0)  # 也没有重复入库


class TestIdlessEvents(IntegrationBase):
    scenario = Scenario(history=6, idless_every=2, dups=1, interval_ms=1)

    def test_idless_best_effort_dedup(self):
        # 源混发无 id 事件,数字序号检查不适用,显式关闭
        col = self.make_collector(sequence_check=False)
        # 末尾事件(6)无 id,游标无法越过它:每次重连都会重放它,靠去重吸收。
        # 因此这里等数据到齐后主动停止,而不是等对端 204。
        self.assertTrue(wait_for(lambda: self.store.stats("s")["events"] >= 6))
        col.stop()
        stats = self.store.stats("s")
        # 6 条事件各重发 1 次;有 id 的靠唯一约束去重,
        # 无 id 的(2、4、6 号)靠内容哈希在窗口内判重 —— 尽力而为,非 exactly-once
        self.assertEqual(stats["events"], 6)
        # 游标只能停在最后一个带 id 的事件(5)上
        self.assertEqual(self.store.get_cursor("s"), ("5", True))


class TestMultilineAndHeartbeat(IntegrationBase):
    scenario = Scenario(history=4, multiline_every=2, heartbeat_ms=1,
                        interval_ms=2, chunk_bytes=3)

    def test_multiline_data_and_heartbeats(self):
        col = self.make_collector()
        # 配置了心跳后连接保持常开,等数据到齐再主动停止
        self.assertTrue(wait_for(lambda: self.store.stats("s")["events"] >= 4))
        self.assertTrue(wait_for(lambda: self.store.stats("s")["heartbeats"] > 0))
        col.stop()
        rows = self.store.timeline("s")
        by_id = {r["event_id"]: r for r in rows}
        self.assertIn("\n", by_id["2"]["data"])  # 多行 data 被拼成 \n
        self.assertIn("line2-of-2", by_id["2"]["data"])
        # 小块分片写入下心跳也被正确解析、留存原始记录
        self.assertGreater(self.store.stats("s")["heartbeats"], 0)


if __name__ == "__main__":
    unittest.main()
