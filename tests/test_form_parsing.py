# -*- coding: utf-8 -*-
"""表单解析测试：同名表单消歧、按钮参数、隐藏字段只能来自页面。"""

from collector.form_parser import (
    FormParseError, find_button, parse_forms, select_form,
)
from collector.http_client import HttpClient
from tests._server_base import SiteServerTestBase


ENTRY_HTML = """
<html><body>
<form name="search" id="decoy" action="/dead-end" method="post">
  <input type="text" name="q">
  <button name="btn" value="search" type="submit">查询</button>
</form>
<form name="search" id="real" action="/query" method="post">
  <input type="hidden" name="_viewstate" value="VS123">
  <input type="hidden" name="_nonce" value="NC456">
  <input type="text" name="q" value="">
  <select name="category">
    <option value="全部" selected>全部</option>
    <option value="电子">电子</option>
  </select>
  <button name="btn" value="search" type="submit">查询</button>
  <button name="btn" value="reset" type="submit">重置</button>
</form>
</body></html>
"""


class TestFormParsing(SiteServerTestBase):

    def test_same_named_forms_select_stateful_one(self):
        forms = parse_forms(ENTRY_HTML, "http://example.test/")
        self.assertEqual(2, len(forms))
        self.assertEqual("search", forms[0].name)
        self.assertEqual("search", forms[1].name)

        chosen = select_form(forms, name="search", prefer_stateful=True)
        self.assertEqual("real", chosen.form_id)
        self.assertEqual("http://example.test/query", chosen.action)
        self.assertEqual({"_viewstate": "VS123", "_nonce": "NC456"}, chosen.hidden)

    def test_index_selection_overrides_preference(self):
        forms = parse_forms(ENTRY_HTML, "http://example.test/")
        chosen = select_form(forms, name="search", index=0)
        self.assertEqual("decoy", chosen.form_id)

    def test_unknown_index_raises(self):
        forms = parse_forms(ENTRY_HTML, "http://example.test/")
        with self.assertRaises(FormParseError):
            select_form(forms, name="search", index=9)

    def test_button_lookup_uses_page_values(self):
        forms = parse_forms(ENTRY_HTML, "http://example.test/")
        chosen = select_form(forms, name="search")
        name, value = find_button(chosen.buttons, wanted_value="reset")
        self.assertEqual(("btn", "reset"), (name, value))
        with self.assertRaises(FormParseError):
            find_button(chosen.buttons, wanted_value="fabricated")

    def test_live_page_contains_two_same_named_forms(self):
        client = HttpClient()
        resp = client.get(self.base_url)
        forms = parse_forms(resp.body, resp.url)
        search_forms = [f for f in forms if f.name == "search"]
        self.assertEqual(2, len(search_forms))
        real = select_form(forms, name="search")
        self.assertIn("_viewstate", real.hidden)
        self.assertTrue(real.action.endswith("/query"))
