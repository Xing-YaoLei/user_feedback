# -*- coding: utf-8 -*-
"""结果页面解析：页面类型、页序、查询身份标记、结构化数据行。"""

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser


@dataclass
class ResultPage:
    page_type: str = "unknown"          # entry / results / error / unknown
    page_number: int = 0
    keyword: str = ""
    category: str = ""
    rows: list = field(default_factory=list)  # [{"id", "sku", "name", "category", "price"}]
    error_message: str = ""


_META_RE = re.compile(
    r'<meta\s+name=["\'](?P<name>[^"\']+)["\']\s+content=["\'](?P<value>[^"\']*)["\']',
    re.IGNORECASE,
)
_IDENTITY_RE = re.compile(
    r'<div\s+id=["\']query-identity["\'][^>]*'
    r'data-keyword=["\'](?P<keyword>[^"\']*)["\'][^>]*'
    r'data-category=["\'](?P<category>[^"\']*)["\']',
    re.IGNORECASE,
)
_ERROR_RE = re.compile(
    r'<div\s+class=["\']error-message["\'][^>]*>(?P<msg>.*?)</div>',
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")


class _RowParser(HTMLParser):
    """抽取 table#result-table 下 tr.row 的单元格数据与 data-id。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_target_table = False
        self.in_row = False
        self.in_cell = False
        self.rows = []
        self._row = None
        self._cells = None
        self._cell_classes = ("pid", "sku", "name", "category", "price")
        self._cell_idx = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table" and attrs.get("id") == "result-table":
            self.in_target_table = True
        elif self.in_target_table and tag == "tr" and "row" in (attrs.get("class") or ""):
            self.in_row = True
            self._row = {"id": attrs.get("data-id", "")}
            self._cells = []
            self._cell_idx = 0
        elif self.in_row and tag == "td":
            self.in_cell = True
            self._cells.append("")

    def handle_data(self, data):
        if self.in_cell:
            self._cells[-1] += data

    def handle_endtag(self, tag):
        if tag == "td" and self.in_cell:
            self.in_cell = False
            self._cell_idx += 1
        elif tag == "tr" and self.in_row:
            self.in_row = False
            for key, value in zip(self._cell_classes, self._cells):
                self._row[key] = value.strip()
            if not self._row.get("pid"):
                self._row["pid"] = self._row["id"]
            self.rows.append(self._row)
            self._row = None
            self._cells = None
        elif tag == "table":
            self.in_target_table = False


def parse_result_page(html_text: str) -> ResultPage:
    page = ResultPage()
    metas = {m.group("name").lower(): m.group("value")
             for m in _META_RE.finditer(html_text)}
    page.page_type = metas.get("page-type", "unknown")
    try:
        page.page_number = int(metas.get("page-number", "0") or 0)
    except ValueError:
        page.page_number = 0

    identity = _IDENTITY_RE.search(html_text)
    if identity:
        page.keyword = identity.group("keyword")
        page.category = identity.group("category")

    error = _ERROR_RE.search(html_text)
    if error:
        page.error_message = _TAG_RE.sub("", error.group("msg")).strip()

    if page.page_type == "results":
        row_parser = _RowParser()
        row_parser.feed(html_text)
        page.rows = row_parser.rows
    return page
