"""pytest 夹具：测试站服务、故障注入控制、浏览器会话。"""
from __future__ import annotations

import json
import threading
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

from crawler.browser import BrowserSession
from testsite.server import STATE, make_server

PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def server() -> Iterator[str]:
    """每个测试一个干净的测试站（计数器与故障配置复位）。"""
    STATE.reset()
    httpd = make_server("127.0.0.1", 0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address
    base_url = f"http://{host}:{port}"
    try:
        yield base_url
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def set_fault(server_url: str, **patch) -> dict:
    body = json.dumps(patch).encode("utf-8")
    req = urllib.request.Request(
        server_url + "/api/control", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def get_control(server_url: str) -> dict:
    with urllib.request.urlopen(server_url + "/api/control", timeout=5) as resp:
        return json.loads(resp.read())


@pytest.fixture()
def fault_ctl(server):
    return lambda **patch: set_fault(server, **patch)


@pytest.fixture()
def browser(server) -> Iterator[BrowserSession]:
    with BrowserSession(server, headless=True) as session:
        yield session


@pytest.fixture()
def state_dir(tmp_path: Path) -> Path:
    return tmp_path / "state"
