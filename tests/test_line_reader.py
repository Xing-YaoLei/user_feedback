"""LineReader 单元测试：字节切分、半行、汉字被切开、偏移语义。"""

import unittest

from collector.line_reader import LineReader


class TestLineReader(unittest.TestCase):
    def test_basic_lines_and_offsets(self) -> None:
        r = LineReader()
        out = r.feed(b"ab\ncd\nef")
        self.assertEqual(out, [(b"ab", 0, 3), (b"cd", 3, 6)])
        self.assertEqual(r.pending, b"ef")
        self.assertEqual(r.pending_offset, 6)
        out = r.feed(b"g\n")
        self.assertEqual(out, [(b"efg", 6, 10)])
        self.assertEqual(r.pending, b"")
        self.assertEqual(r.pending_offset, 10)

    def test_multibyte_character_split_across_chunks(self) -> None:
        line = '{"v":"卷筒纸缺陷-皱褶"}\n'.encode("utf-8")
        # 逐字节喂入，强制每个多字节字符都被切开
        r = LineReader()
        collected: list[bytes] = []
        for i in range(len(line)):
            collected.extend(item[0] for item in r.feed(line[i : i + 1]))
        self.assertEqual(len(collected), 1)
        self.assertEqual(collected[0].decode("utf-8"), '{"v":"卷筒纸缺陷-皱褶"}')

    def test_half_line_ends_inside_multibyte_char(self) -> None:
        text = '{"msg":"纸张检测正常"}\n尾'
        data = text.encode("utf-8")
        # 切在“尾”字的第一个 UTF-8 字节之后
        head = data[: -2]
        tail = data[-2:]
        r = LineReader()
        out = r.feed(head)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0][0].decode("utf-8"), '{"msg":"纸张检测正常"}')
        self.assertTrue(r.pending)  # 半个汉字滞留
        # 缓冲区此刻无法整体解码为合法 UTF-8，这是允许的；补齐后即可
        out = r.feed(tail)
        self.assertEqual(out, [])
        self.assertEqual(r.pending.decode("utf-8"), "尾")

    def test_base_offset_is_absolute(self) -> None:
        r = LineReader(base_offset=100)
        out = r.feed(b"x\n")
        self.assertEqual(out, [(b"x", 100, 102)])
        self.assertEqual(r.pending_offset, 102)

    def test_crlf_stripped_but_offsets_keep_raw_bytes(self) -> None:
        r = LineReader()
        out = r.feed(b"a\r\nb\r\n")
        self.assertEqual([item[0] for item in out], [b"a", b"b"])
        self.assertEqual(out[0][1:], (0, 3))
        self.assertEqual(out[1][1:], (3, 6))

    def test_drop_pending_on_finish(self) -> None:
        r = LineReader(base_offset=7)
        r.feed(b"dangling")
        tail = r.drop_pending()
        self.assertEqual(tail, b"dangling")
        self.assertEqual(r.pending, b"")
        self.assertEqual(r.pending_offset, 7 + len(tail))


if __name__ == "__main__":
    unittest.main()
