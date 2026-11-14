"""增量行读取器：在字节流上按换行切分，兼容被切开的多字节 UTF-8 字符。

关键事实：UTF-8 多字节序列的每个字节都大于 0x7F，而换行符 ``\\n`` 是 0x0A，
不可能出现在一个汉字的字节序列内部。因此直接在字节层面查找 ``b"\\n"`` 切行，
切下来的完整行一定终止在字符边界上，可以安全解码；只有最后一段没有换行的
“半行”（可能终止在某个汉字的一半）留在缓冲区里，等后续字节补齐即可。
"""

from __future__ import annotations


class LineReader:
    """按字节累积输入，吐出带绝对字节偏移的完整行。

    缓冲区起始位置 ``_buf_start`` 是 ``buffer[0]`` 在文件中的绝对偏移。
    每次 :meth:`feed` 返回 ``(行字节, 行首偏移, 行尾偏移)`` 三元组列表，
    行尾偏移指换行符之后的第一个字节，也就是下一行的起始偏移。
    """

    def __init__(self, base_offset: int = 0) -> None:
        self._buf = bytearray()
        self._buf_start = int(base_offset)

    def feed(self, data: bytes) -> list[tuple[bytes, int, int]]:
        if not data:
            return []
        self._buf.extend(data)
        lines: list[tuple[bytes, int, int]] = []
        cursor = 0
        while True:
            nl = self._buf.find(b"\n", cursor)
            if nl == -1:
                break
            line_start = self._buf_start + cursor
            line_end = self._buf_start + nl + 1
            line = bytes(self._buf[cursor:nl])
            # 兼容 CRLF：去掉行尾的 \r，但偏移仍按原始字节计算
            if line.endswith(b"\r"):
                line = line[:-1]
            lines.append((line, line_start, line_end))
            cursor = nl + 1
        if cursor:
            del self._buf[:cursor]
            self._buf_start += cursor
        return lines

    @property
    def pending(self) -> bytes:
        """当前滞留的半行字节（可能终止在多字节字符中间）。"""
        return bytes(self._buf)

    @property
    def pending_offset(self) -> int:
        """滞留半行的首字节在文件中的绝对偏移。"""
        return self._buf_start

    def drop_pending(self) -> bytes:
        """取出并清空滞留的半行（完成标记到达时使用）。"""
        tail = bytes(self._buf)
        self._buf_start += len(self._buf)
        self._buf.clear()
        return tail

    def decode_tail(self) -> str:
        """把残缺尾行解码成可读文本，坏字节用替换符占位。"""
        return self._buf.decode("utf-8", errors="replace")
