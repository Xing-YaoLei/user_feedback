import json
import tempfile
import unittest

from shuttle.config import load_config


def _write(payload: dict) -> str:
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(payload, f)
    f.close()
    return f.name


VALID = {
    "max_concurrency": 3,
    "backoff_base_seconds": 1,
    "backoff_cap_seconds": 30,
    "parks": [
        {"id": "north", "url": "http://127.0.0.1:8080/shuttle/parks/north",
         "interval_seconds": 3, "timeout_seconds": 2},
        {"id": "south", "url": "http://127.0.0.1:8080/shuttle/parks/south",
         "interval_seconds": 5, "timeout_seconds": 2},
    ],
}


class ConfigTests(unittest.TestCase):
    def test_load_valid(self):
        config = load_config(_write(VALID))
        self.assertEqual(config.max_concurrency, 3)
        self.assertEqual(len(config.parks), 2)
        self.assertEqual(config.parks[0].park_id, "north")
        self.assertIsNone(config.dispatcher)

    def test_dispatcher_and_logfile(self):
        payload = dict(VALID)
        payload["dispatcher"] = {"host": "0.0.0.0", "port": 9000}
        payload["logfile"] = "out.log"
        config = load_config(_write(payload))
        self.assertEqual(config.dispatcher.port, 9000)
        self.assertEqual(config.dispatcher.host, "0.0.0.0")
        self.assertEqual(config.logfile, "out.log")

    def test_duplicate_park_id(self):
        payload = json.loads(json.dumps(VALID))
        payload["parks"][1]["id"] = "north"
        with self.assertRaises(ValueError):
            load_config(_write(payload))

    def test_bad_url(self):
        payload = json.loads(json.dumps(VALID))
        payload["parks"][0]["url"] = "ftp://nope"
        with self.assertRaises(ValueError):
            load_config(_write(payload))

    def test_zero_interval(self):
        payload = json.loads(json.dumps(VALID))
        payload["parks"][0]["interval_seconds"] = 0
        with self.assertRaises(ValueError):
            load_config(_write(payload))

    def test_cap_smaller_than_base(self):
        payload = json.loads(json.dumps(VALID))
        payload["backoff_cap_seconds"] = 0.5
        with self.assertRaises(ValueError):
            load_config(_write(payload))

    def test_empty_parks(self):
        payload = json.loads(json.dumps(VALID))
        payload["parks"] = []
        with self.assertRaises(ValueError):
            load_config(_write(payload))


if __name__ == "__main__":
    unittest.main()
