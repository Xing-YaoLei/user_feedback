"""详情页解析与异常判定测试。"""

import unittest

from water_outage.notice import parse_notice

URL = "http://example.test/notices/x.html"


class NoticeParseTest(unittest.TestCase):
    def test_layout_table_skipped_then_data_table_parsed(self):
        markup = """
        <html><body>
          <meta name="notice-id" content="N-1">
          <meta name="notice-version" content="第1版">
          <table><tr><td>页眉装饰表，没有任何可识别表头</td></tr></table>
          <table>
            <tr><th>区域</th><th>开始时间</th><th>结束时间</th></tr>
            <tr><td>甲区</td><td>2026-01-01 09:00</td><td>2026-01-01 10:00</td></tr>
          </table>
        </body></html>
        """
        records, anomalies = parse_notice(markup, URL)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["region"], "甲区")
        self.assertEqual(anomalies, [])

    def test_missing_column_returns_anomaly_and_no_records(self):
        markup = """
        <html><body>
          <table>
            <tr><th>区域</th><th>开始时间</th></tr>
            <tr><td>甲区</td><td>2026-01-01 09:00</td></tr>
          </table>
        </body></html>
        """
        records, anomalies = parse_notice(markup, URL, "N-2", 3)
        self.assertEqual(records, [])
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0]["error_type"], "missing_columns")
        self.assertEqual(anomalies[0]["notice_id"], "N-2")
        self.assertEqual(anomalies[0]["version"], 3)

    def test_time_order_skips_entire_notice(self):
        markup = """
        <html><body>
          <table>
            <tr><th>区域</th><th>开始时间</th><th>结束时间</th></tr>
            <tr><td>正常行</td><td>2026-01-01 09:00</td><td>2026-01-01 10:00</td></tr>
            <tr><td>颠倒行</td><td>2026-01-02 20:00</td><td>2026-01-02 08:00</td></tr>
          </table>
        </body></html>
        """
        records, anomalies = parse_notice(markup, URL)
        self.assertEqual(records, [])  # 整则公告的时段全部跳过
        self.assertEqual(anomalies[0]["error_type"], "time_order")
        self.assertIn("第3行", anomalies[0]["location"])

    def test_equal_start_and_end_counts_as_invalid_order(self):
        markup = """
        <html><body>
          <table>
            <tr><th>区域</th><th>开始时间</th><th>结束时间</th></tr>
            <tr><td>零时长</td><td>2026-01-01 09:00</td><td>2026-01-01 09:00</td></tr>
          </table>
        </body></html>
        """
        records, anomalies = parse_notice(markup, URL)
        self.assertEqual(records, [])
        self.assertEqual(anomalies[0]["error_type"], "time_order")

    def test_meta_attributes_do_not_leak_into_body_text(self):
        # 正文提到历史版次第1版，但 meta 标注当前为第4版；以 meta 为准，
        # 且正文回退匹配不应被 head 里的属性值污染
        markup = """
        <html><head>
          <meta name="notice-id" content="GS-9">
          <meta name="notice-version" content="第4版">
        </head><body>
          <p>本公告替代第1版，公告编号：GS-9</p>
          <table>
            <tr><th>区域</th><th>开始时间</th><th>结束时间</th></tr>
            <tr><td>甲区</td><td>2026-01-01 09:00</td><td>2026-01-01 10:00</td></tr>
          </table>
        </body></html>
        """
        records, anomalies = parse_notice(markup, URL)
        self.assertEqual(anomalies, [])
        self.assertEqual(len(records), 1)

    def test_body_fallback_when_no_meta(self):
        markup = """
        <html><body>
          <p>公告编号: GS-77　版次：第5版</p>
          <table>
            <tr><th>区域</th><th>开始时间</th><th>结束时间</th></tr>
            <tr><td>甲区</td><td>2026-01-01 09:00</td><td>2026-01-01 10:00</td></tr>
          </table>
        </body></html>
        """
        records, anomalies = parse_notice(markup, URL)
        self.assertEqual(anomalies, [])
        self.assertEqual(records[0]["region"], "甲区")
        from water_outage.html import parse_html
        from water_outage.notice import extract_notice_id, extract_version
        root = parse_html(markup)
        self.assertEqual(extract_notice_id(root), "GS-77")
        self.assertEqual(extract_version(root), 5)


if __name__ == "__main__":
    unittest.main()
