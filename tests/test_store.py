"""持久化层测试:游标只在提交后推进、崩溃注入、去重边界、缺口标记。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sse_collect.sse_parser import SSEMessage
from sse_collect.store import Store


def ev(event_id, data="x", event="tick"):
    return SSEMessage(kind="event", event=event, data=data, event_id=event_id,
                      raw=f"id: {event_id}\ndata: {data}")


class TestCursorAndCommit(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")

    def tearDown(self):
        self.store.close()

    def test_cursor_advances_only_after_commit(self):
        def boom():
            raise RuntimeError("crash before commit")

        with self.assertRaises(RuntimeError):
            self.store.commit_event("s", ev("1"), before_commit=boom)
        # 提交前崩溃:游标不动,事件与原始报文都回滚
        self.assertIsNone(self.store.get_cursor("s"))
        self.assertEqual(self.store.stats("s")["events"], 0)
        self.assertEqual(self.store.stats("s")["raw_events"], 0)

    def test_crash_after_commit_keeps_event_and_cursor(self):
        def boom():
            raise RuntimeError("crash after commit")

        with self.assertRaises(RuntimeError):
            self.store.commit_event("s", ev("1"), after_commit=boom)
        # 提交后崩溃:事件与游标都已落库
        self.assertEqual(self.store.get_cursor("s"), ("1", True))
        self.assertEqual(self.store.stats("s")["events"], 1)

    def test_duplicate_id_not_inserted_and_cursor_not_rewound(self):
        self.store.commit_event("s", ev("1"))
        self.store.commit_event("s", ev("2"))
        inserted = self.store.commit_event("s", ev("1"))  # 重放的旧事件
        self.assertFalse(inserted)
        self.assertEqual(self.store.get_cursor("s"), ("2", True))  # 游标不回退
        self.assertEqual(self.store.stats("s")["events"], 2)
        self.assertEqual(self.store.stats("s")["duplicates_dropped"], 1)

    def test_heartbeat_does_not_move_cursor(self):
        self.store.commit_event("s", ev("1"))
        self.store.commit_event("s", SSEMessage(kind="heartbeat", raw=": hb"))
        self.assertEqual(self.store.get_cursor("s"), ("1", True))
        self.assertEqual(self.store.stats("s")["heartbeats"], 1)


class TestIdlessDedupBoundary(unittest.TestCase):
    """无 id 事件:只有有限窗口内的内容哈希去重,不承诺 exactly-once。"""

    def setUp(self):
        self.store = Store(":memory:")

    def tearDown(self):
        self.store.close()

    def test_same_content_deduped_within_window(self):
        m1 = SSEMessage(kind="event", event="tick", data='{"seq": 1}', event_id=None)
        m2 = SSEMessage(kind="event", event="tick", data='{"seq": 1}', event_id=None)
        self.assertTrue(self.store.commit_event("s", m1))
        self.assertFalse(self.store.commit_event("s", m2))  # 窗口内判重
        self.assertEqual(self.store.stats("s")["events"], 1)

    def test_different_content_both_kept(self):
        m1 = SSEMessage(kind="event", event="tick", data='{"seq": 1}', event_id=None)
        m2 = SSEMessage(kind="event", event="tick", data='{"seq": 2}', event_id=None)
        self.assertTrue(self.store.commit_event("s", m1))
        self.assertTrue(self.store.commit_event("s", m2))

    def test_idless_event_does_not_move_cursor(self):
        self.store.commit_event("s", ev("3"))
        m = SSEMessage(kind="event", event="tick", data="no id", event_id=None)
        self.store.commit_event("s", m)
        self.assertEqual(self.store.get_cursor("s"), ("3", True))


class TestGaps(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")

    def tearDown(self):
        self.store.close()

    def test_gap_marks_cursor_non_contiguous(self):
        self.store.commit_event("s", ev("2"))
        self.store.record_gap("s", "2", None, "retention_exhausted")
        last_id, contiguous = self.store.get_cursor("s")
        self.assertEqual(last_id, "2")      # 位置保留
        self.assertFalse(contiguous)        # 但不再声称连续
        gaps = self.store.list_gaps("s")
        self.assertEqual(gaps[0]["reason"], "retention_exhausted")

    def test_contiguous_flag_never_auto_heals(self):
        self.store.commit_event("s", ev("2"))
        self.store.record_gap("s", "2", None, "sequence_gap")
        self.store.commit_event("s", ev("9"))  # 之后正常提交也不会把标记改回连续
        _, contiguous = self.store.get_cursor("s")
        self.assertFalse(contiguous)


if __name__ == "__main__":
    unittest.main()
