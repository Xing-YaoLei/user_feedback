import json
import time
import unittest
import urllib.request

from shuttle.config import Config, ParkConfig
from shuttle.dispatcher import DispatcherServer
from shuttle.model import Snapshot
from shuttle.poller import Scheduler, TransportResult


class DispatcherTests(unittest.TestCase):
    def test_status_snapshots_and_page(self):
        cfg = Config(
            max_concurrency=2,
            backoff_base_seconds=1.0,
            backoff_cap_seconds=10.0,
            parks=[ParkConfig("north", "http://local/north", 2.0, 1.0)],
        )

        def transport(url, timeout, etag):
            return TransportResult(status=200, etag='"e1"', body={"arrivals": [1, 2]})

        scheduler = Scheduler(cfg, transport=transport)
        server = DispatcherServer(scheduler)
        scheduler.start()
        server.start()
        try:
            time.sleep(0.3)
            base = server.url

            with urllib.request.urlopen(base + "api/status", timeout=5) as resp:
                payload = json.loads(resp.read())
            row = payload["parks"][0]
            self.assertEqual(row["park_id"], "north")
            self.assertEqual(row["last_status"], 200)
            self.assertTrue(row["has_snapshot"])

            with urllib.request.urlopen(base + "api/snapshots", timeout=5) as resp:
                payload = json.loads(resp.read())
            self.assertEqual(payload["snapshots"]["north"]["etag"], '"e1"')
            self.assertEqual(payload["snapshots"]["north"]["body"], {"arrivals": [1, 2]})

            with urllib.request.urlopen(base, timeout=5) as resp:
                html = resp.read().decode("utf-8")
            self.assertIn("园区班车到站监控", html)
            self.assertIn("north", html)
            self.assertIn('"e1"', html)  # 快照 JSON 已渲染进页面
        finally:
            scheduler.stop()
            server.stop()

    def test_snapshot_view_none_before_first_success(self):
        cfg = Config(
            max_concurrency=1,
            backoff_base_seconds=1.0,
            backoff_cap_seconds=10.0,
            parks=[ParkConfig("north", "http://local/north", 2.0, 1.0)],
        )
        scheduler = Scheduler(cfg, transport=lambda *a: TransportResult(status=503))
        scheduler.start()
        try:
            time.sleep(0.2)
            view = scheduler.snapshot_view()
            self.assertIsNone(view["north"])
        finally:
            scheduler.stop()


if __name__ == "__main__":
    unittest.main()
