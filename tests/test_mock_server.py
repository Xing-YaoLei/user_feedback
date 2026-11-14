import json
import time
import unittest
import urllib.error
import urllib.request

from shuttle.mock_server import MockShuttleServer, make_etag


def _get(url: str, headers: dict | None = None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, dict(exc.headers), exc.read()


def _post(url: str, payload: dict):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, json.loads(resp.read())


class MockServerTests(unittest.TestCase):
    def setUp(self):
        self.server = MockShuttleServer()
        self.server.start()
        self.base = self.server.base_url
        self.server.add_park("p1", {"arrivals": [{"route": "A"}]}, delay=0.02)

    def tearDown(self):
        self.server.stop()

    def test_etag_200_then_304(self):
        url = self.server.park_url("p1")
        status, headers, body = _get(url)
        self.assertEqual(status, 200)
        etag = headers["ETag"]
        self.assertEqual(json.loads(body), {"arrivals": [{"route": "A"}]})

        status, headers, body = _get(url, {"If-None-Match": etag})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")
        self.assertEqual(headers["ETag"], etag)

        records = self.server.records("p1")
        self.assertEqual([r["status"] for r in records], [200, 304])

    def test_snapshot_change_changes_etag(self):
        old_etag = make_etag({"arrivals": [{"route": "A"}]})
        _post(f"{self.base}/control/parks/p1/snapshot", {"body": {"arrivals": [{"route": "B"}]}})
        status, headers, _ = _get(self.server.park_url("p1"), {"If-None-Match": old_etag})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], old_etag)

    def test_scripted_429_retry_after(self):
        _post(f"{self.base}/control/parks/p1/config",
              {"sequence": ["429:7"], "loop": False, "delay": 0})
        status, headers, _ = _get(self.server.park_url("p1"))
        self.assertEqual(status, 429)
        self.assertEqual(headers["Retry-After"], "7")
        rec = self.server.records("p1")[-1]
        self.assertEqual(rec["retry_after"], 7)

    def test_scripted_503_and_loop(self):
        _post(f"{self.base}/control/parks/p1/config",
              {"sequence": ["503", "200"], "loop": True, "delay": 0})
        s1, _, _ = _get(self.server.park_url("p1"))
        s2, _, _ = _get(self.server.park_url("p1"))
        s3, _, _ = _get(self.server.park_url("p1"))
        self.assertEqual([s1, s2, s3], [503, 200, 503])

    def test_delay_is_recorded(self):
        _post(f"{self.base}/control/parks/p1/config", {"delay": 0.15, "sequence": []})
        started = time.monotonic()
        status, _, _ = _get(self.server.park_url("p1"))
        elapsed = time.monotonic() - started
        self.assertEqual(status, 200)
        self.assertGreaterEqual(elapsed, 0.14)
        rec = self.server.records("p1")[-1]
        self.assertGreaterEqual(rec["duration"], 0.14)
        self.assertEqual(rec["delay"], 0.15)

    def test_unknown_park_404_and_records_api(self):
        status, _, _ = _get(self.server.park_url("ghost"))
        self.assertEqual(status, 404)
        status, payload = _get_via_json(f"{self.base}/control/parks/p1/records")
        self.assertEqual(status, 200)
        self.assertIn("records", payload)

    def test_records_reset(self):
        _get(self.server.park_url("p1"))
        self.assertEqual(len(self.server.records("p1")), 1)
        _post(f"{self.base}/control/parks/p1/records/reset", {})
        self.assertEqual(self.server.records("p1"), [])


def _get_via_json(url: str):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, json.loads(resp.read())


if __name__ == "__main__":
    unittest.main()
