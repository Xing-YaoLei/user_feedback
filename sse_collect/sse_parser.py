"""增量式 SSE(Server-Sent Events)解析器。

遵循 WHATWG SSE 规范的核心部分:
- 行结束符支持 CRLF / CR / LF,且跨网络分块安全(半个 \\r 会等待下一块);
- 多个 data: 字段以 \\n 拼接(多行 data);
- 以 ":" 开头的行是注释,本服务把它当作心跳(heartbeat)上报;
- retry: 字段即时生效,更新建议重连间隔;
- id: 含 NUL 字符时按规范忽略;
- 连接结束时缓冲中未派发完的半个事件一律丢弃,等待重连后由对端重传。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_LINE_END = re.compile(r"\r\n|\r|\n")


@dataclass
class SSEMessage:
    """一条解析结果。kind 为 "event"(带 data 的事件)或 "heartbeat"(注释行)。"""

    kind: str  # "event" | "heartbeat"
    event: str = "message"
    data: str = ""
    event_id: str | None = None
    retry: int | None = None
    raw: str = ""  # 原始报文文本(不含派发用的空行),用于原样持久化


class SSEParser:
    """按任意大小的文本块喂入,返回已完整派发的事件列表。"""

    def __init__(self) -> None:
        self._buf = ""
        self._strip_bom = True
        self.reconnect_ms: int | None = None  # 对端通过 retry: 建议的重连间隔
        self.last_event_id: str | None = None
        self._reset_event()

    def _reset_event(self) -> None:
        self._data: list[str] = []
        self._type = ""
        self._id: str | None = None
        self._retry: int | None = None
        self._raw: list[str] = []

    def feed(self, text: str) -> list[SSEMessage]:
        """喂入一段解码后的文本,返回本次完整派发出来的消息。"""
        if self._strip_bom and text:
            self._strip_bom = False
            if text.startswith("\ufeff"):  # BOM
                text = text[1:]
        self._buf += text
        out: list[SSEMessage] = []
        while True:
            m = _LINE_END.search(self._buf)
            if not m:
                break
            # 缓冲末尾恰好是 \r:可能是 \r\n 的前半,等下一块再定
            if m.group() == "\r" and m.end() == len(self._buf):
                break
            line = self._buf[: m.start()]
            self._buf = self._buf[m.end():]
            msg = self._process_line(line)
            if msg is not None:
                out.append(msg)
        return out

    def close(self) -> str:
        """连接关闭时调用。返回被丢弃的未完成残余字节(已解码),便于排查截断。"""
        leftover = self._buf
        self._buf = ""
        self._reset_event()
        return leftover

    # ------------------------------------------------------------------

    def _process_line(self, line: str) -> SSEMessage | None:
        if line == "":
            return self._dispatch()
        self._raw.append(line)
        if line.startswith(":"):
            # 注释行:作为心跳立即上报,不参与事件派发
            return SSEMessage(kind="heartbeat", raw=line)
        if ":" in line:
            name, _, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]
        else:
            name, value = line, ""
        if name == "data":
            self._data.append(value)
        elif name == "event":
            self._type = value
        elif name == "id":
            if "\x00" not in value:  # 规范:含 NUL 的 id 忽略
                self._id = value
        elif name == "retry":
            if value.isdigit():
                self._retry = int(value)
                self.reconnect_ms = self._retry  # 即时生效
        # 未知字段按规范忽略
        return None

    def _dispatch(self) -> SSEMessage | None:
        if not self._data:
            # 规范:data 缓冲为空则不派发事件(但 retry/id 等副作用已生效)
            self._reset_event()
            return None
        data = "\n".join(self._data)
        if self._id is not None:
            self.last_event_id = self._id
        msg = SSEMessage(
            kind="event",
            event=self._type or "message",
            data=data,
            event_id=self._id,
            retry=self._retry,
            raw="\n".join(self._raw),
        )
        self._reset_event()
        return msg
