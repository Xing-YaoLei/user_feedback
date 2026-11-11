"""SSE 解析器单元测试:跨分块、多行 data、心跳、retry、CRLF、截断丢弃。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sse_collect.sse_parser import SSEParser


class TestChunkedParsing(unittest.TestCase):
    STREAM = (
        "id: 1\r\n"
        "event: tick\r\n"
        "data: {\"a\": 1}\r\n"
        "\r\n"
        ": heartbeat\n"
        "\n"
        "id: 2\n"
        "data: first line\n"
        "data: second line\n"
        "retry: 250\n"
        "\n"
    )

    def test_feed_byte_by_byte_equals_feed_all(self):
        whole = SSEParser()
        expected = whole.feed(self.STREAM)

        bytewise = SSEParser()
        got = []
        for ch in self.STREAM:
            got.extend(bytewise.feed(ch))

        self.assertEqual(
            [(m.kind, m.event, m.data, m.event_id, m.retry) for m in got],
            [(m.kind, m.event, m.data, m.event_id, m.retry) for m in expected],
        )

    def test_events_heartbeat_multiline_retry(self):
        p = SSEParser()
        msgs = p.feed(self.STREAM)
        kinds = [m.kind for m in msgs]
        self.assertEqual(kinds, ["event", "heartbeat", "event"])

        e1, hb, e2 = msgs
        self.assertEqual((e1.event_id, e1.event, e1.data), ("1", "tick", '{"a": 1}'))
        self.assertEqual(hb.raw, ": heartbeat")
        self.assertEqual(e2.data, "first line\nsecond line")  # 多行 data 用 \n 拼接
        self.assertEqual(e2.retry, 250)
        self.assertEqual(p.reconnect_ms, 250)  # retry 即时生效
        self.assertEqual(p.last_event_id, "2")

    def test_cr_at_chunk_boundary(self):
        p = SSEParser()
        # "\r" 在块末尾,必须等下一块判断是 \r 还是 \r\n
        self.assertEqual(p.feed("data: x\r"), [])
        msgs = p.feed("\n\n")
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0].data, "x")

    def test_bom_stripped(self):
        p = SSEParser()
        msgs = p.feed("\ufeffdata: x\n\n")
        self.assertEqual(msgs[0].data, "x")

    def test_id_with_nul_ignored(self):
        p = SSEParser()
        msgs = p.feed("id: 1\nid: bad\x00id\ndata: x\n\n")
        self.assertEqual(msgs[0].event_id, "1")  # 含 NUL 的 id 被忽略,保留旧值

    def test_event_without_data_not_dispatched(self):
        p = SSEParser()
        self.assertEqual(p.feed("event: ping\n\n"), [])

    def test_close_discards_partial_event(self):
        p = SSEParser()
        self.assertEqual(p.feed("id: 9\ndata: never finished"), [])
        leftover = p.close()
        self.assertIn("never finished", leftover)  # 残余被丢弃并上报,等待重传

    def test_raw_preserved(self):
        p = SSEParser()
        msgs = p.feed("id: 5\nevent: t\ndata: a\ndata: b\n\n")
        self.assertEqual(msgs[0].raw, "id: 5\nevent: t\ndata: a\ndata: b")


if __name__ == "__main__":
    unittest.main()
