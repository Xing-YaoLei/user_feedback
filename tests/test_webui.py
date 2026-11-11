# -*- coding: utf-8 -*-
"""查询配置页面（Web UI）测试。"""

import json
import threading
import time
import urllib.request
import urllib.error

from collector.engine import CollectionEngine
from collector.webui import CollectorWebUI
from tests._server_base import SiteServerTestBase


class TestWebUI(SiteServerTestBase):

    def setUp(self):
        super().setUp()
        self.engine = CollectionEngine()
        self.ui = CollectorWebUI(self.engine, host="127.0.0.1", port=0)
        # port=0 在 ThreadingHTTPServer 上才分配端口，因此手动建 server
        from http.server import ThreadingHTTPServer
        self.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0), self.ui.make_handler()
        )
        self.ui_port = self.httpd.server_address[1]
        self.ui_url = f"http://127.0.0.1:{self.ui_port}/"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        time.sleep(0.05)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def _get(self, path):
        with urllib.request.urlopen(self.ui_url + path, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8")

    def test_config_page_renders(self):
        status, body = self._get("")
        self.assertEqual(200, status)
        self.assertIn("传统服务端表单采集器", body)
        self.assertIn("entry_url", body)

    def test_submit_job_and_poll_structured_result(self):
        form = urllib.parse.urlencode({
            "name": "webui-job",
            "entry_url": self.base_url,
            "form_name": "search",
            "button_name": "btn",
            "button_value": "search",
            "fields": json.dumps({"q": "", "category": "电子"}),
            "pager_form_name": "pager",
            "next_button_value": "next",
            "max_pages": "10",
        }).encode("utf-8")
        req = urllib.request.Request(
            self.ui_url + "jobs", data=form, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        # urllib 默认跟随 303 重定向，最终落地配置页（200）
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(200, resp.status)
            self.assertTrue(resp.geturl().endswith("/"))

        # 轮询任务列表直到完成
        job = None
        for _ in range(50):
            status, body = self._get("jobs")
            jobs = json.loads(body)
            if jobs and jobs[0]["status"] in ("ok", "failed"):
                job = jobs[0]
                break
            time.sleep(0.1)
        self.assertIsNotNone(job)
        self.assertEqual("ok", job["status"])
        self.assertEqual(7, job["row_count"])

        # 详情页包含结构化结果
        status, detail = self._get(f"jobs/{job['id']}")
        self.assertEqual(200, status)
        self.assertIn("first_page_ids", detail)

        # 证据页输出遮盖后的 JSON
        status, evidence = self._get("evidence")
        self.assertEqual(200, status)
        records = json.loads(evidence)
        self.assertTrue(records)
        joined = json.dumps(records, ensure_ascii=False)
        self.assertIn("REDACTED", joined)
