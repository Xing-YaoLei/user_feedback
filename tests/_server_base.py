# -*- coding: utf-8 -*-
"""测试公共工具：在随机端口启动测试模式站点，并提供故障注入调用。"""

import json
import threading
import time
import unittest
import urllib.request
from http.cookiejar import CookieJar

from siteserver.app import build_server


class SiteServerTestBase(unittest.TestCase):
    HOST = "127.0.0.1"

    @classmethod
    def setUpClass(cls):
        cls.httpd, cls.app = build_server(cls.HOST, 0, test_mode=True)
        cls.port = cls.httpd.server_address[1]
        cls.base_url = f"http://{cls.HOST}:{cls.port}/"
        cls.server_thread = threading.Thread(
            target=cls.httpd.serve_forever, daemon=True
        )
        cls.server_thread.start()
        time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    # ---------------------------------------------------------- 故障注入
    def _new_session_cookie(self):
        """访问入口，拿到一个有效会话的 Cookie 字符串。"""
        jar = CookieJar()
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar)
        )
        opener.open(self.base_url, timeout=10).read()
        cookie = next(iter(jar))
        return f"{cookie.name}={cookie.value}"

    def _control(self, action: str, cookie: str):
        req = urllib.request.Request(
            self.base_url + f"__test__/{action}",
            data=b"", method="POST",
            headers={"Cookie": cookie},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def force_expire(self, cookie: str):
        return self._control("expire", cookie)

    def arm_regress(self, cookie: str):
        return self._control("regress", cookie)

    def arm_mutate(self, cookie: str):
        return self._control("mutate", cookie)

    def disarm_mutate(self, cookie: str):
        """关闭全局身份变异（通过 mutate 控制端的 off=1 参数）。"""
        req = urllib.request.Request(
            self.base_url + "__test__/mutate",
            data=b"off=1", method="POST",
            headers={"Cookie": cookie,
                     "Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
