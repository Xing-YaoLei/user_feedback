import unittest

from shuttle.backoff import next_backoff, parse_retry_after


class BackoffTests(unittest.TestCase):
    def test_exponential_growth(self):
        self.assertAlmostEqual(next_backoff(1, 1.0, 30.0), 1.0)
        self.assertAlmostEqual(next_backoff(2, 1.0, 30.0), 2.0)
        self.assertAlmostEqual(next_backoff(3, 1.0, 30.0), 4.0)
        self.assertAlmostEqual(next_backoff(4, 1.0, 30.0), 8.0)

    def test_cap(self):
        self.assertAlmostEqual(next_backoff(10, 1.0, 30.0), 30.0)
        self.assertAlmostEqual(next_backoff(10, 2.0, 7.5), 7.5)

    def test_invalid_attempt(self):
        self.assertAlmostEqual(next_backoff(0, 1.0, 30.0), 1.0)

    def test_negative_params_rejected(self):
        with self.assertRaises(ValueError):
            next_backoff(1, -1.0, 30.0)
        with self.assertRaises(ValueError):
            next_backoff(1, 1.0, -30.0)

    def test_parse_retry_after(self):
        self.assertEqual(parse_retry_after("30"), 30)
        self.assertEqual(parse_retry_after("  5 "), 5)
        self.assertEqual(parse_retry_after("0"), 0)
        self.assertIsNone(parse_retry_after(None))
        self.assertIsNone(parse_retry_after(""))
        # HTTP-date 形式不支持，交由调用方退回退避策略
        self.assertIsNone(parse_retry_after("Wed, 21 Oct 2099 07:28:00 GMT"))
        self.assertIsNone(parse_retry_after("soon"))
        self.assertIsNone(parse_retry_after("-3"))


if __name__ == "__main__":
    unittest.main()
