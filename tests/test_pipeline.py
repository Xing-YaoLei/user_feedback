"""基于本地样站的端到端采集测试。"""

import json
import pathlib
import unittest

from water_outage.pipeline import collect, query_by_region

SAMPLE_ROOT = pathlib.Path(__file__).resolve().parent.parent / "sample_site"
START_URL = (SAMPLE_ROOT / "list" / "page1.html").as_uri()


class EndToEndTest(unittest.TestCase):
    def setUp(self):
        self.records, self.anomalies, self.stats = collect(START_URL)

    def test_pagination_stops_on_loop(self):
        # page3 的 rel=next 回指 page1，遍历在 page3 结束，不重复抓 page1
        visited = self.stats["list_pages_visited"]
        self.assertEqual(len(visited), 3)
        self.assertTrue(visited[0].endswith("page1.html"))
        self.assertTrue(visited[1].endswith("page2.html"))
        self.assertTrue(visited[2].endswith("page3.html"))

    def test_cross_page_duplicate_dedup_and_highest_version(self):
        # 001.html 在 page1/page2 重复（仅锚点不同），001_v1/v2 是历史版次
        self.assertEqual(self.stats["detail_links_seen"], 7)
        # 去锚点后唯一详情页：001, 002, 003, 004, 001_v2, 001_v1
        self.assertEqual(self.stats["detail_urls_unique"], 6)
        notice_001 = [r for r in self.records if r["notice_id"] == "GS-2026-001"]
        self.assertEqual(len(notice_001), 3)
        # 只保留最高数字版次第 3 版
        self.assertTrue(all(r["version"] == 3 for r in notice_001))
        self.assertTrue(all(r["source_url"].endswith("notices/001.html")
                            for r in notice_001))

    def test_records_have_required_fields(self):
        expected = {"notice_id", "version", "region",
                    "start_time", "end_time", "source_url"}
        self.assertTrue(self.records)
        for row in self.records:
            self.assertEqual(set(row), expected)

    def test_time_order_anomaly_skips_whole_notice(self):
        ids = {r["notice_id"] for r in self.records}
        self.assertNotIn("GS-2026-002", ids)
        anomaly = next(a for a in self.anomalies
                       if a["notice_id"] == "GS-2026-002")
        self.assertEqual(anomaly["error_type"], "time_order")
        self.assertIn("第", anomaly["location"])

    def test_missing_columns_anomaly_skips_whole_notice(self):
        ids = {r["notice_id"] for r in self.records}
        self.assertNotIn("GS-2026-003", ids)
        anomaly = next(a for a in self.anomalies
                       if a["notice_id"] == "GS-2026-003")
        self.assertEqual(anomaly["error_type"], "missing_columns")
        self.assertIn("结束时间列", anomaly["detail"])

    def test_chinese_time_format(self):
        notice_004 = [r for r in self.records if r["notice_id"] == "GS-2026-004"]
        self.assertEqual(len(notice_004), 2)
        first = next(r for r in notice_004 if "梨园" in r["region"])
        self.assertEqual(first["start_time"], "2026-11-25T09:00:00")
        self.assertEqual(first["end_time"], "2026-11-25T18:30:00")

    def test_region_query(self):
        hits = query_by_region(self.records, "朝阳区")
        self.assertTrue(hits)
        self.assertTrue(all("朝阳区" in r["region"] for r in hits))

    def test_jsonl_serializable(self):
        for row in self.records + self.anomalies:
            json.dumps(row, ensure_ascii=False)


if __name__ == "__main__":
    unittest.main()
