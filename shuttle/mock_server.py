"""本地模拟班车接口。

每个园区可独立配置：
- 响应延迟 delay（秒）
- 状态序列 sequence：一组按顺序循环/一次性回放的响应
  - 200              返回当前快照（带 ETag）
  - 304              仅在客户端 If-None-Match 命中当前 ETag 时返回 304，否则 200
  - 429[:retry]      返回 429，Retry-After 为 retry 秒（默认 30）
  - 500 / 502 / 503  返回对应 5xx
  - timeout[:secs]   睡眠 secs 秒不响应（secs 缺省用 delay，用于触发客户端超时）
- 当前快照内容可通过控制接口替换，替换后 ETag 随之改变

所有请求都写入该园区的请求记录，供核对"一个园区退避时，另一个园区仍在刷新"。

控制接口（POST JSON）：
- /control/parks/{id}/config        {"delay": 0.2, "sequence": ["429:30", "200"], "loop": true}
- /control/parks/{id}/snapshot      {"body": {...}}   替换快照并生成新 ETag
- /control/parks/{id}/records/reset 清空请求记录
- /control/reset                     清空所有园区
读取接口（GET）：
- /shuttle/parks/{id}               模拟的班车数据接口（支持 If-None-Match）
- /control/parks                    园区列表
- /control/parks/{id}/records       请求记录
"""

from __future__ import annotations

import hashlib
import json
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urlparse

MAX_RECORDS_PER_PARK = 2000


def make_etag(body: Any) -> str:
    """ETag 标识整份到站快照：对规范化 JSON 取哈希，内容相同则 ETag 相同。"""
    payload = json.dumps(body, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return '"' + hashlib.sha256(payload).hexdigest()[:32] + '"'


@dataclass
class MockPark:
    park_id: str
    body: Any
    delay: float = 0.0
    sequence: list[str] = field(default_factory=list)  # 空序列表示常规 ETag 行为
    loop: bool = True
    seq_index: int = 0
    etag: str = ""
    records: deque = field(default_factory=lambda: deque(maxlen=MAX_RECORDS_PER_PARK))
    lock: threading.RLock = field(default_factory=threading.RLock)

    def __post_init__(self) -> None:
        if not self.etag:
            self.etag = make_etag(self.body)

    def next_token(self) -> str | None:
        """取出状态序列中的下一个 token；序列为空返回 None。"""
        if not self.sequence:
            return None
        if self.seq_index >= len(self.sequence):
            if not self.loop:
                # 一次性序列播完后回到常规行为
                return None
            self.seq_index = 0
        token = self.sequence[self.seq_index]
        self.seq_index += 1
        return token


class _Handler(BaseHTTPRequestHandler):
    server_version = "ShuttleMock/1.0"

    # ---- 工具方法 -------------------------------------------------------
    @property
    def parks(self) -> dict[str, MockPark]:
        return self.server.parks  # type: ignore[attr-defined]

    @property
    def server_lock(self) -> threading.RLock:
        return self.server.state_lock  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # 静默默认访问日志
        pass

    def _read_json(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("请求体不是合法 JSON")

    def _send_json(self, status: int, payload: Any, extra_headers: dict[str, str] | None = None) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _send_empty(self, status: int, extra_headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _park_or_404(self, park_id: str) -> MockPark | None:
        park = self.parks.get(park_id)
        if park is None:
            self._send_json(404, {"error": f"unknown park: {park_id}"})
            return None
        return park

    # ---- 路由 -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        try:
            if parts == ["control", "parks"]:
                with self.server_lock:
                    self._send_json(200, {"parks": [self._park_summary(p) for p in self.parks.values()]})
                return
            if len(parts) == 4 and parts[:2] == ["control", "parks"] and parts[3] == "records":
                with self.server_lock:
                    park = self._park_or_404(unquote(parts[2]))
                    if park is not None:
                        with park.lock:
                            self._send_json(200, {"park_id": park.park_id, "records": list(park.records)})
                return
            if len(parts) == 3 and parts[:2] == ["shuttle", "parks"]:
                self._handle_shuttle_get(unquote(parts[2]))
                return
            self._send_json(404, {"error": "not found", "path": parsed.path})
        except Exception as exc:  # 防御：模拟接口自身异常不能吞掉
            self._send_json(500, {"error": f"mock server failure: {exc!r}"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        try:
            if parts == ["control", "reset"]:
                with self.server_lock:
                    self.parks.clear()
                self._send_json(200, {"ok": True})
                return
            if len(parts) == 4 and parts[:2] == ["control", "parks"] and parts[3] == "config":
                self._handle_config(unquote(parts[2]))
                return
            if len(parts) == 4 and parts[:2] == ["control", "parks"] and parts[3] == "snapshot":
                self._handle_snapshot(unquote(parts[2]))
                return
            if len(parts) == 5 and parts[:2] == ["control", "parks"] and parts[3:] == ["records", "reset"]:
                with self.server_lock:
                    park = self._park_or_404(unquote(parts[2]))
                    if park is not None:
                        with park.lock:
                            park.records.clear()
                        self._send_json(200, {"ok": True})
                return
            self._send_json(404, {"error": "not found", "path": parsed.path})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"error": f"mock server failure: {exc!r}"})

    # ---- 模拟班车数据接口 -----------------------------------------------
    def _handle_shuttle_get(self, park_id: str) -> None:
        with self.server_lock:
            park = self._park_or_404(park_id)
        if park is None:
            return

        if_none_match = self.headers.get("If-None-Match")
        record: dict[str, Any] = {
            "seq": 0,
            "time": round(time.time(), 3),
            "method": "GET",
            "path": f"/shuttle/parks/{park_id}",
            "if_none_match": if_none_match,
            "delay": None,
            "duration": None,
            "status": None,
            "etag": None,
            "retry_after": None,
            "note": None,
        }
        started = time.monotonic()
        with park.lock:
            record["seq"] = len(park.records) + 1
            token = park.next_token()
            delay = park.delay
            body = park.body
            current_etag = park.etag

        record["delay"] = delay
        if delay > 0:
            time.sleep(delay)

        try:
            if token is None:
                # 常规 ETag 行为：命中返回 304，否则 200 发布快照
                if if_none_match is not None and if_none_match == current_etag:
                    self._finish_record(park, record, started, 304, etag=current_etag)
                    self._send_empty(304, {"ETag": current_etag})
                else:
                    self._finish_record(park, record, started, 200, etag=current_etag)
                    self._send_json(200, body, {"ETag": current_etag})
                return

            kind, _, arg = token.partition(":")
            kind = kind.strip().lower()

            if kind == "200":
                # 脚本明确要求 200：发布当前快照（忽略 If-None-Match）
                self._finish_record(park, record, started, 200, etag=current_etag)
                self._send_json(200, body, {"ETag": current_etag})
            elif kind == "304":
                self._finish_record(park, record, started, 304, etag=current_etag)
                self._send_empty(304, {"ETag": current_etag})
            elif kind == "429":
                retry_after = int(arg) if arg else 30
                if retry_after < 0:
                    retry_after = 0
                record["retry_after"] = retry_after
                self._finish_record(park, record, started, 429, etag=current_etag)
                self._send_empty(429, {"Retry-After": str(retry_after), "ETag": current_etag})
            elif kind in ("500", "502", "503", "504"):
                self._finish_record(park, record, started, int(kind))
                self._send_json(int(kind), {"error": f"scripted {kind}"})
            elif kind == "timeout":
                hold = float(arg) if arg else max(delay, 1.0)
                record["note"] = f"scripted timeout, holding {hold}s"
                # 分段睡眠并探测客户端是否已因超时断开
                deadline = time.monotonic() + hold
                disconnected = False
                while time.monotonic() < deadline:
                    time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
                    try:
                        self.connection.settimeout(0.0)
                        peeked = self.connection.recv(1, socket.MSG_PEEK)
                        if peeked == b"":
                            disconnected = True
                            break
                    except (BlockingIOError, OSError):
                        pass  # 客户端仍在等待
                    finally:
                        self.connection.settimeout(None)
                if disconnected:
                    record["duration"] = round(time.monotonic() - started, 3)
                    record["note"] += " | client disconnected (timeout)"
                    with park.lock:
                        park.records.append(record)
                    return
                # 客户端超时比 hold 长：正常返回 200
                self._finish_record(park, record, started, 200, etag=current_etag,
                                    note="client did not time out")
                self._send_json(200, body, {"ETag": current_etag})
            else:
                self._finish_record(park, record, started, 500, note=f"unknown token {token!r}")
                self._send_json(500, {"error": f"unknown script token: {token}"})
        except (BrokenPipeError, ConnectionResetError):
            # 客户端超时主动断开：仍把这次请求记入记录，便于核对
            record["duration"] = round(time.monotonic() - started, 3)
            record["note"] = (record["note"] or "") + " | client disconnected (likely timeout)"
            with park.lock:
                park.records.append(record)

    def _finish_record(
        self,
        park: MockPark,
        record: dict[str, Any],
        started: float,
        status: int,
        etag: str | None = None,
        note: str | None = None,
    ) -> None:
        record["status"] = status
        record["etag"] = etag
        if note:
            record["note"] = note
        record["duration"] = round(time.monotonic() - started, 3)
        with park.lock:
            park.records.append(record)

    # ---- 控制接口 -------------------------------------------------------
    def _handle_config(self, park_id: str) -> None:
        payload = self._read_json()
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        with self.server_lock:
            park = self.parks.get(park_id)
            if park is None:
                park = MockPark(park_id=park_id, body={"park_id": park_id, "arrivals": []})
                self.parks[park_id] = park
            with park.lock:
                if "delay" in payload:
                    delay = float(payload["delay"])
                    if delay < 0:
                        raise ValueError("delay 不能为负")
                    park.delay = delay
                if "sequence" in payload:
                    sequence = payload["sequence"]
                    if not isinstance(sequence, list) or not all(isinstance(t, str) for t in sequence):
                        raise ValueError("sequence 必须是字符串数组")
                    park.sequence = list(sequence)
                    park.seq_index = 0
                if "loop" in payload:
                    park.loop = bool(payload["loop"])
                summary = self._park_summary(park)
        self._send_json(200, summary)

    def _handle_snapshot(self, park_id: str) -> None:
        payload = self._read_json()
        if not isinstance(payload, dict) or "body" not in payload:
            raise ValueError("请求体必须包含 body 字段")
        with self.server_lock:
            park = self.parks.get(park_id)
            if park is None:
                park = MockPark(park_id=park_id, body=payload["body"])
                self.parks[park_id] = park
            with park.lock:
                park.body = payload["body"]
                park.etag = make_etag(park.body)
                summary = self._park_summary(park)
        self._send_json(200, summary)

    @staticmethod
    def _park_summary(park: MockPark) -> dict[str, Any]:
        with park.lock:
            return {
                "park_id": park.park_id,
                "delay": park.delay,
                "sequence": list(park.sequence),
                "loop": park.loop,
                "seq_index": park.seq_index,
                "etag": park.etag,
                "records": len(park.records),
            }


class MockShuttleServer:
    """模拟接口服务，端口为 0 时由操作系统分配。"""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._httpd = ThreadingHTTPServer((host, port), _Handler)
        self._httpd.parks = {}              # type: ignore[attr-defined]
        self._httpd.state_lock = threading.RLock()  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="mock-http", daemon=True)

    @property
    def address(self) -> tuple[str, int]:
        host, port = self._httpd.server_address[:2]
        return str(host), int(port)

    @property
    def base_url(self) -> str:
        host, port = self.address
        return f"http://{host}:{port}"

    def park_url(self, park_id: str) -> str:
        return f"{self.base_url}/shuttle/parks/{park_id}"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)

    # 便于测试直接操作内存状态
    def add_park(self, park_id: str, body: Any, delay: float = 0.0) -> MockPark:
        park = MockPark(park_id=park_id, body=body, delay=delay)
        self._httpd.parks[park_id] = park  # type: ignore[attr-defined]
        return park

    def get_park(self, park_id: str) -> MockPark | None:
        return self._httpd.parks.get(park_id)  # type: ignore[attr-defined]

    def records(self, park_id: str) -> list[dict[str, Any]]:
        park = self.get_park(park_id)
        if park is None:
            return []
        with park.lock:
            return list(park.records)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="本地模拟班车接口")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    server = MockShuttleServer(args.host, args.port)
    server.start()
    host, port = server.address
    print(f"mock shuttle server listening on http://{host}:{port}")
    print("数据接口: GET /shuttle/parks/{id}")
    print("控制接口: POST /control/parks/{id}/config | /snapshot | /records/reset")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    main()
