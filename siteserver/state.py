# -*- coding: utf-8 -*-
"""服务端会话与隐藏状态机。

每个会话持有一对一次性隐藏状态（viewstate / nonce）：
* 任何成功响应都会轮转这对状态；
* 使用上一次响应里的旧状态回发会被拒绝，且会话立即作废；
* 不同会话（不同 Cookie）拥有完全独立的状态链，互不可见。
"""

import secrets
import threading


class Session:
    def __init__(self, sid: str):
        self.sid = sid
        self.viewstate = ""
        self.nonce = ""
        # 查询条件与服务端页码，页码只信服务端，不接受客户端传参
        self.keyword = ""
        self.category = "全部"
        self.page = 0
        # 故障注入开关（仅测试模式下可通过 /__test__/* 设置）
        self.regress_next = False
        self.mutate_next = False
        self.rotate()

    def rotate(self):
        """轮转隐藏状态。每次成功出页后调用。"""
        self.viewstate = secrets.token_hex(16)
        self.nonce = secrets.token_hex(8)


class SessionStore:
    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()

    def create(self) -> Session:
        sid = secrets.token_hex(12)
        sess = Session(sid)
        with self._lock:
            self._sessions[sid] = sess
        return sess

    def get(self, sid: str):
        if not sid:
            return None
        with self._lock:
            return self._sessions.get(sid)

    def drop(self, sid: str):
        with self._lock:
            self._sessions.pop(sid, None)
