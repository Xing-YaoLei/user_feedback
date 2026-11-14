"""表格展开与多级表头识别的单元测试。"""

import unittest

from water_outage.html import parse_html
from water_outage.tables import expand_table, parse_table, resolve_columns


class GridExpansionTest(unittest.TestCase):
    def test_rowspan_and_colspan(self):
        markup = """
        <table>
          <tr><th rowspan="2">区域</th><th colspan="2">时间</th></tr>
          <tr><th>开始</th><th>结束</th></tr>
          <tr><td>甲区</td><td>09:00</td><td>10:00</td></tr>
        </table>
        """
        table = parse_html(markup).find("table")
        grid = expand_table(table)
        self.assertEqual(len(grid), 3)
        for row in grid:
            self.assertEqual(len(row), 3)
        # 左上角 th 向下延伸，第二行第一格引用同一节点
        self.assertIs(grid[0][0]["node"], grid[1][0]["node"])
        self.assertEqual(grid[0][0]["text"], "区域")
        # 第一行的“时间”横向延伸两格
        self.assertEqual(grid[0][1]["text"], "时间")
        self.assertEqual(grid[0][2]["text"], "时间")
        self.assertIs(grid[0][1]["node"], grid[0][2]["node"])
        # 第二行子表头
        self.assertEqual(grid[1][1]["text"], "开始")
        self.assertEqual(grid[1][2]["text"], "结束")

    def test_resolve_multilevel_columns(self):
        markup = """
        <table>
          <thead>
            <tr><th rowspan="2">停水区域</th><th colspan="2">停水时间</th></tr>
            <tr><th>开始时间</th><th>结束时间</th></tr>
          </thead>
          <tbody>
            <tr><td>甲区</td><td>2026-01-01 09:00</td><td>2026-01-01 10:00</td></tr>
          </tbody>
        </table>
        """
        table = parse_html(markup).find("table")
        grid = expand_table(table)
        mapping, header_count = resolve_columns(grid, table)
        self.assertEqual(mapping, {"region": 0, "start": 1, "end": 2})
        self.assertEqual(header_count, 2)

    def test_missing_column_detected(self):
        markup = """
        <table>
          <tr><th>区域</th><th>开始时间</th></tr>
          <tr><td>甲区</td><td>2026-01-01 09:00</td></tr>
        </table>
        """
        table = parse_html(markup).find("table")
        body_rows, mapping = parse_table(table)
        self.assertIn("region", mapping)
        self.assertIn("start", mapping)
        self.assertNotIn("end", mapping)
        self.assertEqual(len(body_rows), 1)


if __name__ == "__main__":
    unittest.main()
