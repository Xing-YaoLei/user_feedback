"""本地可控 SSE 测试源。

用于在没有真实上游的情况下演练采集器的各种边界:
- 历史重放:        按 Last-Event-ID 续传,或从保留期起点全量重放;
- 重复事件:        每条事件额外重发 dups 次(模拟上游重试/多活重复);
- 连接中途截断:    在指定 id 的事件写到一半时直接断开 TCP(只发生一次);
- 历史保留期耗尽:  Last-Event-ID 早于 retention_from 时返回 410 Gone;
- 其他:            心跳、retry 提示、多行 data、无 id 事件、小块分片写入。

GET /stream 支持查询参数覆盖场景配置,例如:
  /stream?history=50&dups=1&truncate_at=10&chunk_bytes=7
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs


@dataclass
class Scenario:
    history: int = 20            # 历史事件总数,id 为 "1".."history"
    retention_from: int = 1      # 最早保留的历史 id(更早的已被保留期淘汰)
    live: int = 0                # 重放完成后继续产生的实时事件数(编号接续)
    interval_ms: int = 50        # 事件发送间隔
    heartbeat_ms: int = 0        # 心跳间隔,0 = 不发
    dups: int = 0                # 每条事件额外重复发送次数
    truncate_at: int | None = None   # 在该 id 的事件写到一半时断开连接(仅一次)
    truncate_bytes: int = 5      # 截断前写出的字节数
    skip: int | None = None      # 完全跳过该 id(制造序号缺口)
    idless_every: int = 0        # 每 N 条事件有 1 条不带 id
    multiline_every: int = 0     # 每 N 条事件有 1 条多行 data
    retry_ms: int | None = None  # 在事件中附带 retry: 提示
    chunk_bytes: int = 0         # >0 时按该大小小块写入,模拟网络分块

    def with_overrides(self, params: dict[str, list[str]]) -> "Scenario":
        kv = {}
        for key in (
            "history", "retention_from", "live", "interval_ms", "heartbeat_ms",
            "dups", "truncate_at", "truncate_bytes", "skip", "idless_every",
            "multiline_every", "retry_ms", "chunk_bytes",
        ):
            if key in params and params[key] and params[key][0] != "":
                kv[key] = int(params[key][0])
        return replace(self, **kv)


def build_event_block(k: int, sc: Scenario) -> str:
    """构造一条事件的原始报文。"""
    lines = []
    if not (sc.idless_every and k % sc.idless_every == 0):
        lines.append(f"id: {k}")
    lines.append("event: tick")
    payload = json.dumps({"seq": k, "message": f"event-{k}"}, ensure_ascii=False)
    if sc.multiline_every and k % sc.multiline_every == 0:
        lines.append(f"data: {payload}")
        lines.append(f'data: {{"continuation": "line2-of-{k}"}}')
    else:
        lines.append(f"data: {payload}")
    if sc.retry_ms:
        lines.append(f"retry: {sc.retry_ms}")
    return "\n".join(lines) + "\n\n"


class _SourceState:
    """跨连接共享的一次性状态(截断只发生一次,重连后应能正常续传)。"""

    def __init__(self) -> None:
        self.truncated = False


class SourceHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # 关闭连接即结束响应体,便于流式推送

    def log_message(self, *args) -> None:  # 静音
        pass

    def do_GET(self) -> None:
        path, _, qs = self.path.partition("?")
        if path != "/stream":
            self.send_error(404, "only /stream is served")
            return
        sc: Scenario = self.server.scenario.with_overrides(parse_qs(qs))  # type: ignore[attr-defined]
        state: _SourceState = self.server.state  # type: ignore[attr-defined]

        last_id = self.headers.get("Last-Event-ID")
        start = sc.retention_from
        if last_id is not None:
            try:
                lid = int(last_id)
            except ValueError:
                lid = -1
            if lid < sc.retention_from:
                # 请求的历史已被保留期淘汰:明确告知 410,由采集器记录缺口
                body = json.dumps({
                    "error": "retention_exhausted",
                    "oldest_retained": sc.retention_from,
                    "requested_after": last_id,
                }).encode()
                self.send_response(410)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            start = lid + 1

        live_base = max(sc.history, start - 1)
        replay_ids = [k for k in range(start, sc.history + 1) if k != sc.skip]
        live_ids = [k for k in range(live_base + 1, live_base + 1 + sc.live) if k != sc.skip]

        if not replay_ids and not live_ids:
            # 没有更多数据:204 告诉客户端不要再重连
            self.send_response(204)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        try:
            last_hb = time.monotonic()
            for k in replay_ids + live_ids:
                block = build_event_block(k, sc)
                if sc.truncate_at == k and not state.truncated:
                    # 写到一半直接断开,模拟网络截断;只发生一次
                    self.wfile.write(block.encode()[: sc.truncate_bytes])
                    self.wfile.flush()
                    state.truncated = True
                    return
                self._write(block, sc)
                for _ in range(sc.dups):  # 重复事件(模拟上游重试造成的重发)
                    self._write(block, sc)
                if sc.heartbeat_ms:
                    now = time.monotonic()
                    if (now - last_hb) * 1000 >= sc.heartbeat_ms:
                        self._write(f": hb {k}\n\n", sc)
                        last_hb = now
                if sc.interval_ms:
                    time.sleep(sc.interval_ms / 1000)
            # 数据发完:若配置了心跳则保持连接持续发心跳,否则直接关闭
            while sc.heartbeat_ms:
                time.sleep(sc.heartbeat_ms / 1000)
                self._write(": hb\n\n", sc)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return  # 客户端断开

    def _write(self, text: str, sc: Scenario) -> None:
        data = text.encode()
        if sc.chunk_bytes > 0:
            for i in range(0, len(data), sc.chunk_bytes):
                self.wfile.write(data[i : i + sc.chunk_bytes])
                self.wfile.flush()
                time.sleep(0.001)
        else:
            self.wfile.write(data)
            self.wfile.flush()


class SourceServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, scenario: Scenario, addr=("127.0.0.1", 0)) -> None:
        super().__init__(addr, SourceHandler)
        self.scenario = scenario
        self.state = _SourceState()

    @property
    def url(self) -> str:
        host, port = self.server_address[:2]
        return f"http://{host}:{port}/stream"

    def start_background(self) -> threading.Thread:
        t = threading.Thread(target=self.serve_forever, name="sse-source", daemon=True)
        t.start()
        return t
