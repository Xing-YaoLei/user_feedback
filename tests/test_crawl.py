"""End-to-end tests for the manual indexer against the bundled demo site."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from indexer.crawl import (  # noqa: E402
    Crawler,
    PageLoader,
    chapter_title,
    to_url,
)

SITE = Path(__file__).resolve().parents[1] / "site"


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


class CrawlDemoSiteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "out"
        cls.crawler = Crawler(root=SITE)
        cls.result = cls.crawler.crawl(to_url(str(SITE / "index.html")), cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def chapter(self, needle: str):
        for chapter in self.result.chapters:
            if needle in chapter.url:
                return chapter
        self.fail(f"chapter not indexed: {needle}")

    def exception(self, needle: str):
        for exception in self.result.exceptions:
            if needle in exception["chapter"]:
                return exception
        self.fail(f"chapter not in exceptions: {needle}")

    # -- file layout ----------------------------------------------------

    def test_one_jsonl_per_indexed_chapter(self):
        files = sorted(p.name for p in (self.out / "index").glob("*.jsonl"))
        self.assertEqual(len(files), len(self.result.chapters))
        self.assertEqual(len(files), 4)
        for chapter in self.result.chapters:
            self.assertTrue((self.out / "index" / f"{chapter.slug}.jsonl").exists())

    def test_chapter_record_first(self):
        path = self.out / "index" / f"{self.chapter('chapter-1').slug}.jsonl"
        records = read_jsonl(path)
        self.assertEqual(records[0]["type"], "chapter")
        self.assertEqual(records[0]["chapter_url"], "guide/chapter-1.html")
        self.assertEqual(records[0]["title"], "第 1 章 普通链接")
        self.assertTrue(all(r["type"] == "paragraph" for r in records[1:]))

    def test_manifest_lists_chapters_and_exceptions(self):
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["chapters"]), 4)
        self.assertEqual(
            sorted(item["kind"] for item in manifest["exceptions"]),
            ["cycle", "missing-anchor", "missing-page"],
        )

    # -- plain links ----------------------------------------------------

    def test_plain_links_keep_visible_text(self):
        chapter = self.chapter("chapter-1")
        text = " ".join(p["text"] for p in chapter.paragraphs)
        self.assertIn("先阅读 安装基础，然后回到本章继续", text)
        self.assertIn("这一段的链接包含", text)
        self.assertNotIn("安装之前请先确认系统版本满足要求", text)

    def test_paragraph_sources(self):
        chapter = self.chapter("chapter-1")
        first = chapter.paragraphs[0]
        self.assertEqual(first["source"], "guide/chapter-1.html")
        self.assertEqual(first["anchor"], "overview")
        later = [p for p in chapter.paragraphs if p["anchor"] == "details"][0]
        self.assertEqual(later["source"], "guide/chapter-1.html")

    # -- includes -------------------------------------------------------

    def test_cross_directory_include(self):
        chapter = self.chapter("chapter-2")
        texts = [p["text"] for p in chapter.paragraphs]
        self.assertIn("安装之前请先确认系统版本满足要求。", texts)
        install_sources = [
            p["source"] for p in chapter.paragraphs if p["text"].startswith("安装之前")
        ]
        # The same fragment is reached both directly and via a nested include.
        self.assertTrue(install_sources)
        self.assertTrue(all(source == "shared/basics.html" for source in install_sources))
        self.assertTrue(all(p["anchor"] == "install" for p in chapter.paragraphs if p["text"].startswith("安装之前")))

    def test_nested_include_expands_in_place(self):
        chapter = self.chapter("chapter-2")
        texts = [p["text"] for p in chapter.paragraphs]
        checklist = [
            "检查清单的第一项是确认依赖已经安装。",
            "第二项见下面的深入说明：",
            "深入说明的第一段解释了配置项的优先级。",
            "深入说明里还会展开共享的入门片段：",
            "安装之前请先确认系统版本满足要求。",
            "安装完成后运行 check 命令验证环境。",
            "检查清单的最后一项是记录检查结果。",
        ]
        start = texts.index(checklist[0])
        self.assertEqual(texts[start : start + len(checklist)], checklist)
        nested = [p for p in chapter.paragraphs if p["text"] == checklist[5]][0]
        self.assertEqual(nested["source"], "shared/basics.html")
        self.assertEqual(nested["anchor"], "install")

    def test_two_level_relative_path(self):
        chapter = self.chapter("sub/chapter-3")
        texts = [p["text"] for p in chapter.paragraphs]
        self.assertIn("安装之前请先确认系统版本满足要求。", texts)
        self.assertIn("第 4 章", " ".join(texts))
        self.assertIn("检查清单的第一项是确认依赖已经安装。", texts)
        # Paragraph after the anchored heading belongs to its own heading anchor and is not part of includes.
        self.assertIn("这一段属于后续小节，不属于上面的片段。", texts)

    # -- repeated fragments --------------------------------------------

    def test_same_fragment_twice_emits_twice(self):
        chapter = self.chapter("sub/chapter-4")
        install_paragraphs = [
            p for p in chapter.paragraphs if p["text"] == "安装之前请先确认系统版本满足要求。"
        ]
        self.assertEqual(len(install_paragraphs), 3)
        positions = [chapter.paragraphs.index(p) for p in install_paragraphs]
        self.assertEqual(positions, sorted(positions))

    def test_repeat_occurrence_keeps_occurrence_order(self):
        chapter = self.chapter("sub/chapter-4")
        texts = [p["text"] for p in chapter.paragraphs]
        self.assertEqual(
            texts,
            [
                "同一个片段在本章会出现两次，索引里也应出现两次。",
                "第一次展开安装步骤：",
                "安装之前请先确认系统版本满足要求。",
                "安装完成后运行 check 命令验证环境。",
                "中间插入一段普通正文，用来确认两次出现之间仍有本章自己的段落。",
                "第二次展开深入说明：",
                "深入说明的第一段解释了配置项的优先级。",
                "深入说明里还会展开共享的入门片段：",
                "安装之前请先确认系统版本满足要求。",
                "安装完成后运行 check 命令验证环境。",
                "收尾段落。",
                "这里再次引用安装片段：",
                "安装之前请先确认系统版本满足要求。",
                "安装完成后运行 check 命令验证环境。",
            ],
        )

    # -- error handling -------------------------------------------------

    def test_cycle_chapter_excluded_with_chain(self):
        exception = self.exception("chapter-5")
        self.assertEqual(exception["kind"], "cycle")
        self.assertEqual(exception["title"], "第 5 章 循环引用")
        slugs = {p.stem for p in (self.out / "index").glob("*.jsonl")}
        self.assertNotIn("guide-chapter-5", slugs)
        page_anchors = [(step["target"], step["anchor"]) for step in exception["chain"]]
        self.assertEqual(
            page_anchors,
            [
                ("shared/advanced.html", "loop-a"),
                ("shared/advanced.html", "loop-b"),
                ("shared/advanced.html", "loop-a"),
            ],
        )
        self.assertEqual(
            exception["include_chain"],
            [
                "guide/chapter-5.html",
                "shared/advanced.html#loop-a",
                "shared/advanced.html#loop-b",
                "shared/advanced.html#loop-a",
            ],
        )

    def test_missing_anchor_excluded(self):
        exception = self.exception("chapter-6")
        self.assertEqual(exception["kind"], "missing-anchor")
        self.assertIn("#no-such-anchor", exception["message"])
        self.assertEqual(len(exception["chain"]), 1)
        self.assertEqual(exception["chain"][0]["anchor"], "no-such-anchor")
        self.assertFalse(((self.out / "index") / "guide-chapter-6.jsonl").exists())

    def test_missing_page_excluded(self):
        exception = self.exception("chapter-7")
        self.assertEqual(exception["kind"], "missing-page")
        self.assertEqual(exception["chain"][0]["target"], "shared/missing.html")

    def test_other_chapters_continue(self):
        self.assertEqual(len(self.result.chapters), 4)
        self.assertEqual(len(self.result.exceptions), 3)

    def test_missing_chapter_page_is_excluded(self):
        crawler = Crawler(root=SITE)
        chapter, exception = crawler.index_chapter(to_url(str(SITE / "guide" / "does-not-exist.html")))
        self.assertIsNone(chapter)
        assert exception is not None
        self.assertEqual(exception["kind"], "missing-page")
        self.assertEqual(exception["chapter"], "guide/does-not-exist.html")

    # -- caching ---------------------------------------------------------

    def test_page_read_once_per_crawl(self):
        counts = self.crawler.loader.read_counts
        canonical = to_url(str(SITE / "shared" / "basics.html"))
        self.assertEqual(counts[canonical], 1)
        advanced = to_url(str(SITE / "shared" / "advanced.html"))
        self.assertEqual(counts[advanced], 1)

    def test_page_loader_parses_once(self):
        loader = PageLoader()
        url = to_url(str(SITE / "shared" / "basics.html"))
        a = loader.load(url + "#install")
        b = loader.load(url + "#checklist")
        self.assertIs(a, b)
        self.assertEqual(loader.read_counts[url], 1)


class SyntheticChapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "shared").mkdir()
        (self.root / "shared" / "frags.html").write_text(
            """<!doctype html><html><body><main>
            <section id="a"><p>fragment a one</p><p>fragment a two</p></section>
            <section id="b"><p>fragment b</p></section>
            </main></body></html>""",
            encoding="utf-8",
        )
        self.loader = PageLoader()
        self.crawler = Crawler(root=self.root, loader=self.loader)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_chapter(self, body: str) -> str:
        path = self.root / "chapter.html"
        path.write_text(
            f"""<!doctype html><html><head><meta charset="utf-8"><title>C</title></head>
            <body><main><h1>C</h1>{body}</main></body></html>""",
            encoding="utf-8",
        )
        return to_url(str(path))

    def test_different_anchors_same_chain_are_not_a_cycle(self):
        url = self._write_chapter(
            """<p><a data-include href="shared/frags.html#a">A</a></p>
            <p><a data-include href="shared/frags.html#b">B</a></p>"""
        )
        chapter, exception = self.crawler.index_chapter(url)
        self.assertIsNone(exception)
        assert chapter is not None
        self.assertEqual(
            [p["text"] for p in chapter.paragraphs],
            ["fragment a one", "fragment a two", "fragment b"],
        )

    def test_include_without_fragment_is_missing_anchor(self):
        url = self._write_chapter(
            """<p><a data-include href="shared/frags.html">no fragment</a></p>"""
        )
        chapter, exception = self.crawler.index_chapter(url)
        self.assertIsNone(chapter)
        assert exception is not None
        self.assertEqual(exception["kind"], "missing-anchor")

    def test_include_chain_cycle_detected(self):
        # frags#a -> frags#b -> frags#a
        (self.root / "shared" / "frags.html").write_text(
            """<!doctype html><html><body><main>
            <section id="a"><p>start</p>
              <p><a data-include href="frags.html#b">go b</a></p></section>
            <section id="b"><p>middle</p>
              <p><a data-include href="frags.html#a">go a</a></p></section>
            </main></body></html>""",
            encoding="utf-8",
        )
        url = self._write_chapter(
            """<p><a data-include href="shared/frags.html#a">start</a></p>"""
        )
        chapter, exception = self.crawler.index_chapter(url)
        self.assertIsNone(chapter)
        assert exception is not None
        self.assertEqual(exception["kind"], "cycle")
        self.assertEqual(
            [(s["target"], s["anchor"]) for s in exception["chain"]],
            [
                ("shared/frags.html", "a"),
                ("shared/frags.html", "b"),
                ("shared/frags.html", "a"),
            ],
        )


class ChapterTitleTest(unittest.TestCase):
    def test_title_prefers_h1(self):
        from indexer.htmlnode import parse_html

        root = parse_html("<html><head><title>t</title></head><body><h1> 标题 </h1></body></html>")
        self.assertEqual(chapter_title(root), "标题")

    def test_title_falls_back_to_title_tag(self):
        from indexer.htmlnode import parse_html

        root = parse_html("<html><head><title>页面标题</title></head><body></body></html>")
        self.assertEqual(chapter_title(root), "页面标题")


if __name__ == "__main__":
    unittest.main()
