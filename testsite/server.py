"""测试站 HTTP 服务。

纯标准库实现，提供：
  GET /                 页面
  GET /app.js           前端脚本
  GET /api/regions
  GET /api/institutions?region=...
  GET /api/types?institution=...
  GET /api/devices?region=&institution=&type=
  POST /api/control     故障注入配置（测试使用）
  GET  /api/control     读取计数器 / 配置

故障注入（fault 配置，见 FaultConfig）：
  delay_range      每个请求额外延迟的随机区间（秒）
  fail_first       devices 接口前 N 次请求返回 500，之后正常
  fail_remaining   或按“剩余失败次数”失败（每次成功失败后递减）
  shuffle          打乱选项顺序，要求爬虫依赖 id 而非位置
  slow_mode        devices 慢响应：响应到达前页面会先保留旧内容
  overtake         响应超车：每个组合的【首个】devices 请求延迟，
                   复现切换组合时旧请求晚到、覆盖新结果的竞态
"""
from __future__ import annotations

import json
import random
import threading
import time
from dataclasses import dataclass, field, asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from testsite import data

STATIC_DIR = Path(__file__).parent / "static"


@dataclass
class FaultConfig:
    delay_range: list[float] = field(default_factory=lambda: [0.0, 0.02])
    fail_first: int = 0              # 前 N 次 devices 请求失败
    fail_remaining: int = 0          # 剩余失败配额（一次失败减一）
    shuffle: bool = False
    shuffle_seed: int = 20261111
    slow_mode: bool = False          # 响应较慢，页面存在“旧内容残留”窗口
    overtake: bool = False           # 每个组合首个 devices 请求迟到
    overtake_delay: float = 1.0

    def update(self, patch: dict) -> None:
        for key, value in patch.items():
            if hasattr(self, key):
                setattr(self, key, value)


class SiteState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.fault = FaultConfig()
        self.counters: dict[str, int] = {
            "regions": 0, "institutions": 0, "types": 0, "devices": 0,
            "devices_failed": 0,
        }
        self._shuffle_rng = random.Random(self.fault.shuffle_seed)
        self._overtake_seen: set[tuple] = set()

    def reset(self) -> None:
        with self.lock:
            self.fault = FaultConfig()
            self.counters = {k: 0 for k in self.counters}
            self._shuffle_rng = random.Random(self.fault.shuffle_seed)
            self._overtake_seen.clear()

    def maybe_shuffle(self, items: list) -> list:
        if not self.fault.shuffle:
            return items
        items = list(items)
        self._shuffle_rng.shuffle(items)
        return items

    def should_fail_devices(self) -> bool:
        with self.lock:
            if self.fault.fail_first > 0:
                self.fault.fail_first -= 1
                self.counters["devices_failed"] += 1
                return True
            if self.fault.fail_remaining > 0:
                self.fault.fail_remaining -= 1
                self.counters["devices_failed"] += 1
                return True
            return False

    def device_request_timing(self, key: tuple) -> float:
        """返回该请求应额外 sleep 的秒数；实现 overtake / slow_mode。"""
        f = self.fault
        delay = random.uniform(*f.delay_range)
        if f.overtake:
            with self.lock:
                first = key not in self._overtake_seen
                if first:
                    self._overtake_seen.add(key)
            if first:
                # 首个请求迟到：切换到别的组合时，它可能晚于新组合响应到达
                delay += f.overtake_delay
        if f.slow_mode:
            delay += 0.5
        return delay


STATE = SiteState()


def _devices_payload(region: str, institution: str, dev_type: str) -> dict:
    devices = data.devices_for(region, institution, dev_type)
    sig = f"{region}|{institution}|{dev_type}|{len(devices)}"
    return {
        "ok": True,
        "signature": sig,
        "devices": devices,
        "query": {"region": region, "institution": institution, "type": dev_type},
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "TestSite/1.0"

    def log_message(self, *args):  # 静音
        pass

    # -- helpers ----------------------------------------------------------
    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, filename: str, ctype: str) -> None:
        path = STATIC_DIR / filename
        if not path.exists():
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        # 测试站资源随时可能调整，禁止缓存，避免浏览器跑旧版前端
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- routing ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        route, qs = parsed.path, parse_qs(parsed.query)
        try:
            if route == "/":
                return self._send_static("index.html", "text/html")
            if route == "/app.js":
                return self._send_static("app.js", "application/javascript")
            if route == "/api/regions":
                return self._handle_regions()
            if route == "/api/institutions":
                return self._handle_institutions(qs)
            if route == "/api/types":
                return self._handle_types(qs)
            if route == "/api/devices":
                return self._handle_devices(qs)
            if route == "/api/control":
                return self._send_json({"ok": True, "fault": asdict(STATE.fault),
                                        "counters": STATE.counters})
            self.send_error(404, "unknown route")
        except Exception as exc:  # pragma: no cover - 防御
            self._send_json({"ok": False, "error": f"server error: {exc}"}, status=500)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/control":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            patch = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send_json({"ok": False, "error": "invalid json"}, status=400)
        with STATE.lock:
            STATE.fault.update(patch)
            STATE._shuffle_rng = random.Random(STATE.fault.shuffle_seed)
        self._send_json({"ok": True, "fault": asdict(STATE.fault)})

    # -- api handlers -----------------------------------------------------
    def _handle_regions(self) -> None:
        time.sleep(random.uniform(*STATE.fault.delay_range))
        with STATE.lock:
            STATE.counters["regions"] += 1
        items = [{"id": rid, "label": label} for rid, label in
                 STATE.maybe_shuffle(data.REGIONS)]
        self._send_json({"ok": True, "regions": items})

    def _handle_institutions(self, qs: dict) -> None:
        region = (qs.get("region") or [""])[0]
        time.sleep(random.uniform(*STATE.fault.delay_range))
        with STATE.lock:
            STATE.counters["institutions"] += 1
        if region not in data.INSTITUTIONS:
            return self._send_json({"ok": False, "error": "unknown region"}, status=400)
        items = [{"id": iid, "label": label} for iid, label in
                 STATE.maybe_shuffle(data.INSTITUTIONS[region])]
        self._send_json({"ok": True, "institutions": items})

    def _handle_types(self, qs: dict) -> None:
        institution = (qs.get("institution") or [""])[0]
        time.sleep(random.uniform(*STATE.fault.delay_range))
        with STATE.lock:
            STATE.counters["types"] += 1
        if institution not in data.TYPE_SUPPORT:
            return self._send_json({"ok": False, "error": "unknown institution"}, status=400)
        labels = dict(data.DEVICE_TYPES)
        items = [{"id": tid, "label": labels[tid]}
                 for tid in STATE.maybe_shuffle(data.TYPE_SUPPORT[institution])]
        self._send_json({"ok": True, "types": items})

    def _handle_devices(self, qs: dict) -> None:
        region = (qs.get("region") or [""])[0]
        institution = (qs.get("institution") or [""])[0]
        dev_type = (qs.get("type") or [""])[0]
        key = (region, institution, dev_type)
        with STATE.lock:
            STATE.counters["devices"] += 1
        # 故障注入优先：失败也要花时间，避免失败路径“秒回”被当空分支
        time.sleep(STATE.device_request_timing(key))
        if STATE.should_fail_devices():
            return self._send_json(
                {"ok": False, "error": "simulated transient failure (500)"}, status=500)
        if institution not in data.TYPE_SUPPORT or dev_type not in data.TYPE_SUPPORT.get(institution, []):
            return self._send_json({"ok": False, "error": "invalid filter combination"}, status=400)
        self._send_json(_devices_payload(region, institution, dev_type))


def make_server(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    return server
