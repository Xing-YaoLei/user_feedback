"""helpcenter_diff 测试套件，纯 unittest，运行：python -I -m unittest -v"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from helpcenter_diff.config import DiffConfig  # noqa: E402
from helpcenter_diff.crawler import Crawler  # noqa: E402
from helpcenter_diff.differ import (  # noqa: E402
    ATTACHMENT_LOST,
    BODY_CHANGED,
    EXTRACT_FAILED,
    MISSING_IN_NEW,
    MISSING_IN_OLD,
    ORPHAN,
    TITLE_CHANGED,
    Differ,
)
from helpcenter_diff.dom import parse_html  # noqa: E402
from helpcenter_diff.extractor import Extractor  # noqa: E402
from helpcenter_diff.selector import select, select_first  # noqa: E402
from helpcenter_diff.siteio import SiteIO  # noqa: E402

from fixtures import build_rules  # noqa: E402


class DomTest(unittest.TestCase):
    def test_text_content_blocks(self):
        dom = parse_html("<div><h1>标题</h1><p>第一行<br>第二行</p></div>")
        text = select_first(dom, "div").text_content()
        self.assertIn("标题", text)
        self.assertIn("第一行", text)
        self.assertIn("第二行", text)
        self.assertTrue(text.count("\n") >= 2)

    def test_implicit_li_close(self):
        dom = parse_html("<ul><li>一<li>二<li>三</ul>")
        lis = select(dom, "ul li")
        self.assertEqual(len(lis), 3)
        self.assertEqual(lis[1].text_content().strip(), "二")

    def test_malformed_tolerance(self):
        dom = parse_html("<p>未闭合<p>段落<div>嵌套<span>文本")
        self.assertTrue(any(n.tag == "div" for n in dom.iter()))
        self.assertIn("文本", dom.text_content())


class SelectorTest(unittest.TestCase):
    def setUp(self):
        self.dom = parse_html("""
        <html><body>
        <div id="main" class="wrap v2">
          <ul class="list">
            <li class="item" data-id="a1"><a href="/x">X</a></li>
            <li class="item active" data-id="a2"><a href="/y">Y</a></li>
          </ul>
          <p data-tags="alpha beta">hello</p>
          <span>sibling1</span><b>sibling2</b>
        </div>
        </body></html>""")

    def test_tag_id_class(self):
        self.assertEqual(len(select(self.dom, "li.item")), 2)
        self.assertEqual(select_first(self.dom, "#main").get("id"), "main")
        self.assertEqual(len(select(self.dom, ".wrap.v2")), 1)

    def test_attr_operators(self):
        self.assertEqual(select_first(self.dom, "[data-id='a2']").get("data-id"), "a2")
        self.assertEqual(select_first(self.dom, "[data-id^=a]").get("data-id"), "a1")
        self.assertEqual(select_first(self.dom, "[data-id$=2]").get("data-id"), "a2")
        self.assertEqual(select_first(self.dom, "[data-id*=1]").get("data-id"), "a1")
        self.assertEqual(select_first(self.dom, "[data-tags~=beta]").tag, "p")
        self.assertEqual(select_first(self.dom, "li[data-id!='a1']").get("data-id"), "a2")
        self.assertEqual(select_first(self.dom, "a[href]").get("href"), "/x")

    def test_combinators(self):
        self.assertEqual(len(select(self.dom, "div li")), 2)
        self.assertEqual(len(select(self.dom, "ul > li")), 2)
        self.assertEqual(select_first(self.dom, "span + b").tag, "b")
        self.assertEqual(select_first(self.dom, "ul ~ p").tag, "p")

    def test_not_and_list(self):
        nodes = select(self.dom, "li:not(.active)")
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0].get("data-id"), "a1")
        self.assertEqual(len(select(self.dom, "span, b")), 2)


class SiteIOTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.rules_path = build_rules(self.base)
        self.config = DiffConfig.load(self.rules_path)
        self.io = SiteIO(self.config.old)

    def tearDown(self):
        self.tmp.cleanup()

    def test_url_path_roundtrip(self):
        path = self.config.old.root / "articles/1001-zh.html"
        url = self.io.to_url(path)
        self.assertEqual(url, "http://help.test/articles/1001-zh.html")
        self.assertEqual(self.io.to_path(url).resolve(), path.resolve())

    def test_directory_index(self):
        path = self.io.to_path("http://help.test/")
        self.assertEqual(path.name, "index.html")
        self.assertTrue(path.is_file())

    def test_relative_link_resolution(self):
        base = "http://help.test/category/guide.html"
        resolved = self.io.resolve_link(base, "../articles/1001-zh.html")
        self.assertEqual(resolved, "http://help.test/articles/1001-zh.html")

    def test_external_and_special_links(self):
        self.assertIsNone(self.io.resolve_link("http://help.test/x", "#section"))
        self.assertIsNone(self.io.resolve_link("http://help.test/x", "mailto:a@b.c"))
        external = self.io.resolve_link("http://help.test/x", "https://other.com/p")
        self.assertEqual(external, "https://other.com/p")
        self.assertFalse(self.io.is_internal(external))

    def test_path_traversal_blocked(self):
        self.assertIsNone(self.io.to_path("http://help.test/../../etc/passwd"))


class EndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name)
        cls.rules_path = build_rules(cls.base)
        cls.config = DiffConfig.load(cls.rules_path)
        cls.old_crawl = Crawler(cls.config.old).run()
        cls.new_crawl = Crawler(cls.config.new).run()
        cls.old_extract = Extractor(cls.config.old, cls.old_crawl).run()
        cls.new_extract = Extractor(cls.config.new, cls.new_crawl).run()
        cls.report = Differ(
            cls.old_extract, cls.new_extract, cls.old_crawl, cls.new_crawl
        ).build()
        cls.diff_map = {
            (d.article_id, d.language): d for d in cls.report.article_diffs
        }

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _cats(self, article_id: str, lang: str = "zh") -> set[str]:
        return set(self.diff_map[(article_id, lang)].categories)

    def test_article_count_and_languages(self):
        keys = set(self.diff_map)
        self.assertIn(("1001", "zh"), keys)
        self.assertIn(("1001", "en"), keys)
        # 编号×语言对齐，1001 有两条语言记录
        ids = {k[0] for k in keys}
        for expected in ("1001", "1002", "1003", "1004", "1005",
                         "1006", "1007", "1008", "1009", "1010"):
            self.assertIn(expected, ids)

    def test_body_changed(self):
        self.assertIn(BODY_CHANGED, self._cats("1001"))
        diff = self.diff_map[("1001", "zh")]
        self.assertTrue(diff.body_changed)
        self.assertIn("第三步", diff.entries_new and self.new_extract
                      .articles[("1001", "zh")].body_text)

    def test_title_changed(self):
        self.assertIn(TITLE_CHANGED, self._cats("1001", "en"))
        diff = self.diff_map[("1001", "en")]
        self.assertEqual(diff.title_old, "Getting Started")
        self.assertEqual(diff.title_new, "Getting Started Guide")

    def test_missing_in_new(self):
        self.assertIn(MISSING_IN_NEW, self._cats("1002"))
        self.assertEqual(self.diff_map[("1002", "zh")].pages_new, [])

    def test_missing_in_old(self):
        self.assertIn(MISSING_IN_OLD, self._cats("1003"))

    def test_attachment_file_lost(self):
        self.assertIn(ATTACHMENT_LOST, self._cats("1004"))
        diff = self.diff_map[("1004", "zh")]
        att = next(a for a in diff.attachments if "manual-1004" in a["url"])
        self.assertEqual(att["status_old"], "ok")
        self.assertEqual(att["status_new"], "missing")

    def test_attachment_reference_removed(self):
        self.assertIn(ATTACHMENT_LOST, self._cats("1005"))
        diff = self.diff_map[("1005", "zh")]
        att = next(a for a in diff.attachments if "table-1005" in a["url"])
        self.assertEqual(att["status_new"], "absent")

    def test_orphan(self):
        self.assertIn(ORPHAN, self._cats("1006"))
        self.assertTrue(self.diff_map[("1006", "zh")].orphan_new)
        self.assertIn(
            "http://help.test/help/article/1006-zh.html",
            self.new_extract.orphans,
        )

    def test_extract_failed(self):
        self.assertIn(EXTRACT_FAILED, self._cats("1007"))
        self.assertTrue(
            any("body" in e for e in self.diff_map[("1007", "zh")].errors_new)
        )

    def test_broken_link(self):
        targets = {b.target_url for b in self.report.broken_links if b.site == "new"}
        self.assertIn("help/article/9999-zh.html", targets)
        row = next(b for b in self.report.broken_links
                   if "9999" in b.target_url and b.site == "new")
        self.assertEqual(row.link_text, "不存在的相关文章")
        self.assertGreaterEqual(len(self.report.broken_links), 1)

    def test_multiple_entries_preserved(self):
        record = self.old_extract.articles[("1009", "zh")]
        entry_urls = {e.url for e in record.entries}
        self.assertIn("http://help.test/articles/1009-zh.html", entry_urls)
        # 同一 URL 只有一条 entry，但来源页有两个
        entry = next(e for e in record.entries if "1009" in e.url)
        sources = set(entry.source_pages)
        self.assertIn("http://help.test/index.html", sources)
        self.assertIn("http://help.test/category/guide.html", sources)
        # 报告层 URL 收敛为相对路径后，入口仍然完整
        diff = self.diff_map[("1009", "zh")]
        report_entry_urls = {e["url"] for e in diff.entries_old}
        self.assertIn("articles/1009-zh.html", report_entry_urls)
        report_sources = {s for e in diff.entries_old for s in e["source_pages"]}
        self.assertIn("index.html", report_sources)
        self.assertIn("category/guide.html", report_sources)

    def test_dead_attachment_references_article(self):
        rows = [r for r in self.report.dead_attachments if "broken-1010" in r.url]
        self.assertEqual(len(rows), 2)  # 新旧两版文件都不存在
        for row in rows:
            self.assertEqual(row.article_id, "1010")
            self.assertEqual(row.language, "zh")
            self.assertTrue(any("1010" in p for p in row.referrer_pages))

    def test_one_record_per_id_language(self):
        # 1001 zh 被首页和分类页同时链接，仍只有一条记录
        zh_keys = [k for k in self.old_extract.articles if k == ("1001", "zh")]
        self.assertEqual(len(zh_keys), 1)

    def test_stats_and_json_serializable(self):
        self.assertGreaterEqual(self.report.new_stats.orphan_pages, 1)
        payload = json.dumps(self.report.to_json(), ensure_ascii=False)
        decoded = json.loads(payload)
        self.assertIn("article_diffs", decoded)
        self.assertIn("summary", decoded)


class MarkdownReportTest(unittest.TestCase):
    def test_report_files_written(self):
        from helpcenter_diff.report import write_json, write_markdown

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        config = DiffConfig.load(build_rules(base))
        old_crawl = Crawler(config.old).run()
        new_crawl = Crawler(config.new).run()
        report = Differ(
            Extractor(config.old, old_crawl).run(),
            Extractor(config.new, new_crawl).run(),
            old_crawl, new_crawl,
        ).build()
        out = base / "out"
        write_json(report, out / "report.json")
        write_markdown(report, out / "report.md")
        md = (out / "report.md").read_text(encoding="utf-8")
        for heading in ("总览", "正文变化", "新版页面缺失", "链接断开",
                        "失效附件及引用文章", "存在但无入口", "正文提取失败"):
            self.assertIn(heading, md)


class ConfigValidationTest(unittest.TestCase):
    def test_bad_configs_raise(self):
        from helpcenter_diff.config import ConfigError

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        base.mkdir(exist_ok=True)
        good_site = {
            "root": str(base),
            "article": {
                "url_pattern": r"/a/(\d+)",
                "language": {"from": "fixed", "fixed": "zh"},
                "body_selector": "div.body",
            },
        }

        def load(payload):
            rp = base / "r.json"
            rp.write_text(json.dumps(payload), encoding="utf-8")
            return DiffConfig.load(rp)

        with self.assertRaises(ConfigError):
            load({"old": good_site})  # 缺 new
        bad_root = {"old": {**good_site, "root": str(base / "nope")},
                    "new": good_site}
        with self.assertRaises(ConfigError):
            load(bad_root)  # 目录不存在
        no_id = {"old": {**good_site, "article": {
            "language": {"from": "fixed", "fixed": "zh"},
            "body_selector": "div.body"}}, "new": good_site}
        with self.assertRaises(ConfigError):
            load(no_id)  # 既无 url_pattern 也无 id_selector
        bad_regex = {"old": {**good_site, "article": {
            "url_pattern": "(/(",
            "language": {"from": "fixed", "fixed": "zh"},
            "body_selector": "div.body"}}, "new": good_site}
        with self.assertRaises(ConfigError):
            load(bad_regex)  # 非法正则


class ElementModeTest(unittest.TestCase):
    def test_element_id_html_body_and_truncation(self):
        import json as _json
        from helpcenter_diff.report import write_markdown

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name) / "site"
        (base / "index").mkdir(parents=True)
        (base / "index/index.html").write_text(
            '<html><body><a href="/page/a.html">A</a>'
            '<a href="/page/b.html">B</a></body></html>', encoding="utf-8")
        (base / "page").mkdir(parents=True)
        (base / "page/a.html").write_text(
            '<html><body><article data-aid="A-100"><h1>T1</h1>'
            '<div class="bd"><p>Hello <strong>world</strong></p></div>'
            '</article></body></html>', encoding="utf-8")
        (base / "page/b.html").write_text(
            '<html><body><p>no article</p></body></html>', encoding="utf-8")
        site_rule = {
            "root": str(base),
            "crawl": {"index_pages": ["index/index.html"]},
            "article": {
                "id_selector": "article", "id_attr": "data-aid",
                "language": {"from": "fixed", "fixed": "zh"},
                "title_selector": "h1",
                "body_selector": "div.bd", "body_mode": "html",
            },
        }
        rules = {"old": dict(site_rule), "new": dict(site_rule)}
        rules["old"]["crawl"] = {"index_pages": ["index/index.html"], "max_pages": 2}
        rp = Path(tmp.name) / "rules.json"
        rp.write_text(_json.dumps(rules), encoding="utf-8")

        cfg = DiffConfig.load(rp)
        old_crawl = Crawler(cfg.old).run()
        self.assertTrue(old_crawl.truncated)  # max_pages 截断标记
        ext = Extractor(cfg.old, old_crawl).run()
        rec = ext.articles.get(("A-100", "zh"))
        self.assertIsNotNone(rec)
        self.assertEqual(rec.title, "T1")
        self.assertIn("<strong>world</strong>", rec.body_html)
        self.assertEqual(rec.body_text, "Hello world")
        self.assertEqual(list(ext.articles.keys()), [("A-100", "zh")])  # 非文章页不入库

        # 不截断时两页都能采到，报告可正常生成
        full_crawl = Crawler(cfg.new).run()
        self.assertFalse(full_crawl.truncated)
        report = Differ(
            Extractor(cfg.old, old_crawl).run(),
            Extractor(cfg.new, full_crawl).run(),
            old_crawl, full_crawl,
        ).build()
        out = Path(tmp.name) / "out"
        write_markdown(report, out / "r.md")
        self.assertTrue((out / "r.md").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
