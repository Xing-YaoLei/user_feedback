"""从采集到的页面里识别文章、提取编号/语言/标题/正文/附件。"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from .config import ArticleRule, SiteRule
from .crawler import CrawlResult, PageRecord
from .dom import TEXT_TAG, Node, parse_html
from .selector import select, select_first
from .siteio import SiteIO

_WS_RE = re.compile(r"[ \t\r\f\v]+")
_NL_RE = re.compile(r"\n{3,}")


@dataclass
class Entry:
    url: str
    source_pages: list[str] = field(default_factory=list)  # 从哪些页面链过来
    link_texts: list[str] = field(default_factory=list)
    depth: int = 0


@dataclass
class Attachment:
    url: str
    exists: bool
    referenced_by: list[str] = field(default_factory=list)  # 引用它的文章页面 URL


@dataclass
class ArticleRecord:
    article_id: str
    language: str
    entries: list[Entry] = field(default_factory=list)
    title: str | None = None
    body_text: str | None = None
    body_html: str | None = None
    body_hash: str | None = None
    title_hash: str | None = None
    attachments: list[Attachment] = field(default_factory=list)
    page_urls: list[str] = field(default_factory=list)
    extraction_errors: list[str] = field(default_factory=list)
    orphan: bool = False


@dataclass
class ExtractionResult:
    articles: dict[tuple[str, str], ArticleRecord]
    orphans: list[str]                    # 页面存在但无入口的页面 URL
    parse_failed_pages: list[str]         # DOM 解析失败
    read_failed_pages: list[str]          # 读取失败


class Extractor:
    def __init__(self, rule: SiteRule, crawl: CrawlResult):
        self.rule = rule
        self.crawl = crawl
        self.io = SiteIO(rule)
        self.articles: dict[tuple[str, str], ArticleRecord] = {}

    def run(self) -> ExtractionResult:
        parse_failed: list[str] = []
        read_failed: list[str] = []
        for url, page in self.crawl.pages.items():
            if page.read_error:
                read_failed.append(url)
                continue
            if page.parse_error:
                parse_failed.append(url)
                continue
            if page.dom is None or not page.is_textual:
                continue
            article_id = self._identify(page)
            if article_id is None:
                continue
            self._extract(article_id, page)

        # 全站扫描：存在但从未被爬到的文章页（无入口）
        orphans = self._scan_orphans()
        return ExtractionResult(
            articles=self.articles,
            orphans=orphans,
            parse_failed_pages=parse_failed,
            read_failed_pages=read_failed,
        )

    # ---------- 文章识别 ----------
    def _identify(self, page: PageRecord) -> str | None:
        rule = self.rule.article
        assert page.dom is not None
        if rule._url_regex is not None:
            m = rule._url_regex.search(urlsplit(page.url).path)
            if not m:
                return None
            try:
                return m.group(rule.url_group)
            except IndexError:
                return None
        # 元素模式
        node = select_first(page.dom, rule.id_selector or "")
        if node is None:
            return None
        value = node.get(rule.id_attr) if rule.id_attr != "content" \
            else node.text_content().strip()
        return value or None

    # ---------- 单页提取 ----------
    def _extract(self, article_id: str, page: PageRecord) -> None:
        assert page.dom is not None
        rule = self.rule.article
        errors: list[str] = []

        language = rule.language.resolve(page.url, page.dom)
        if not language:
            errors.append("language: 未能解析语言")
            language = "_unknown_"

        key = (article_id, language)
        record = self.articles.get(key)
        if record is None:
            record = ArticleRecord(article_id=article_id, language=language)
            self.articles[key] = record
        record.page_urls.append(page.url)
        self._add_entry(record, page)

        title = self._extract_title(page.dom, rule, errors)
        body_node, body_text, body_html = self._extract_body(page.dom, rule, errors)

        if title is not None:
            record.title = title
            record.title_hash = hashlib.sha256(title.encode("utf-8")).hexdigest()
        if body_text is not None:
            record.body_text = body_text
            record.body_html = body_html
            record.body_hash = hashlib.sha256(body_text.encode("utf-8")).hexdigest()

        attachments = self._extract_attachments(page.dom, body_node, page, rule)
        self._merge_attachments(record, attachments, page.url)

        if errors:
            record.extraction_errors.extend(
                f"{page.rel_path}: {msg}" for msg in errors
            )
        if not page.in_edges and page.url not in self.crawl.seed_urls:
            record.orphan = True

    def _add_entry(self, record: ArticleRecord, page: PageRecord) -> None:
        for edge in page.in_edges:
            entry = self._find_entry(record, edge.target_url)
            if entry is None:
                entry = Entry(url=edge.target_url, depth=edge.depth)
                record.entries.append(entry)
            if edge.source_url not in entry.source_pages:
                entry.source_pages.append(edge.source_url)
            if edge.link_text and edge.link_text not in entry.link_texts:
                entry.link_texts.append(edge.link_text)
        if not page.in_edges:
            # 种子页/无入链页：自身 URL 也是入口
            entry = self._find_entry(record, page.url)
            if entry is None:
                record.entries.append(Entry(url=page.url, depth=page.depth))

    @staticmethod
    def _find_entry(record: ArticleRecord, url: str) -> Entry | None:
        for entry in record.entries:
            if entry.url == url:
                return entry
        return None

    def _extract_title(self, dom: Node, rule: ArticleRule,
                       errors: list[str]) -> str | None:
        if not rule.title_selector:
            return None
        node = select_first(dom, rule.title_selector)
        if node is None:
            errors.append(f"title: 选择器无匹配 ({rule.title_selector})")
            return None
        value = (node.get(rule.title_attr) if rule.title_attr
                 else node.text_content()).strip()
        if not value:
            errors.append("title: 标题为空")
            return None
        return _normalize_ws(value)

    def _extract_body(self, dom: Node, rule: ArticleRule,
                      errors: list[str]) -> tuple[Node | None, str | None, str | None]:
        node = select_first(dom, rule.body_selector or "")
        if node is None:
            errors.append(f"body: 选择器无匹配 ({rule.body_selector})")
            return None, None, None
        text = _normalize_body(node.text_content())
        if not text:
            errors.append("body: 正文为空")
            return node, None, None
        html = None
        if rule.body_mode == "html":
            html = serialize_children(node)
        return node, text, html

    def _extract_attachments(self, dom: Node, body_node: Node | None,
                             page: PageRecord, rule: ArticleRule) -> list[Attachment]:
        att = rule.attachments
        scope = body_node
        if att.container_selector:
            scope = select_first(dom, att.container_selector) or body_node
        if scope is None:
            return []
        out: list[Attachment] = []
        seen: set[str] = set()
        for node in select(scope, att.link_selector):
            href = node.get(att.href_attr)
            if href is None:
                continue
            url = self.io.resolve_link(page.url, href)
            if url is None or url in seen:
                continue
            if not att.is_attachment(urlsplit(url).path):
                continue
            seen.add(url)
            exists = True
            if self.io.is_internal(url):
                exists = self.io.exists(url)
            out.append(Attachment(url=url, exists=exists,
                                  referenced_by=[page.url]))
        return out

    @staticmethod
    def _merge_attachments(record: ArticleRecord, attachments: list[Attachment],
                           page_url: str) -> None:
        existing = {a.url: a for a in record.attachments}
        for att in attachments:
            old = existing.get(att.url)
            if old is None:
                record.attachments.append(att)
                existing[att.url] = att
            else:
                old.exists = old.exists and att.exists
                if page_url not in old.referenced_by:
                    old.referenced_by.append(page_url)

    # ---------- 孤儿扫描 ----------
    def _scan_orphans(self) -> list[str]:
        visited = set(self.crawl.pages)
        orphans: list[str] = []
        known_article_urls = {u for r in self.articles.values() for u in r.page_urls}
        for path in sorted(self.io.root.rglob("*")):
            if not path.is_file() or not self.io.is_textual(self.io.to_url(path)):
                continue
            url = self.io.to_url(path)
            if url in visited:
                continue
            if not self._looks_like_article_file(url, path):
                continue
            page = self._try_parse(url, path)
            if page is None:
                continue
            article_id = self._identify(page)
            if article_id is None:
                continue
            language = self.rule.article.language.resolve(url, page.dom) or "_unknown_"
            key = (article_id, language)
            record = self.articles.get(key)
            if record is None:
                record = ArticleRecord(article_id=article_id, language=language)
                self.articles[key] = record
            record.orphan = True
            record.page_urls.append(url)
            if not self._find_entry(record, url):
                record.entries.append(Entry(url=url, depth=-1))
            self._extract_orphan_content(record, page)
            orphans.append(url)
            known_article_urls.add(url)
        return orphans

    def _looks_like_article_file(self, url: str, path: Path) -> bool:
        rule = self.rule.article
        if rule._url_regex is not None:
            return bool(rule._url_regex.search(urlsplit(url).path))
        return True  # 元素模式：解析后再判断

    def _try_parse(self, url: str, path: Path) -> PageRecord | None:
        try:
            text, _ = self.io.read_text(url)
            dom = parse_html(text)
        except (OSError, UnicodeError, ValueError):  # 解析失败的页面交由其它统计处理
            return None
        page = PageRecord(url=url, rel_path=self._rel(path), depth=-1,
                          is_textual=True, dom=dom)
        return page

    def _extract_orphan_content(self, record: ArticleRecord, page: PageRecord) -> None:
        assert page.dom is not None
        rule = self.rule.article
        errors: list[str] = []
        title = self._extract_title(page.dom, rule, errors)
        body_node, body_text, body_html = self._extract_body(page.dom, rule, errors)
        if title is not None and record.title is None:
            record.title = title
            record.title_hash = hashlib.sha256(title.encode("utf-8")).hexdigest()
        if body_text is not None and record.body_text is None:
            record.body_text = body_text
            record.body_html = body_html
            record.body_hash = hashlib.sha256(body_text.encode("utf-8")).hexdigest()
        attachments = self._extract_attachments(page.dom, body_node, page, rule)
        self._merge_attachments(record, attachments, page.url)
        record.extraction_errors.extend(
            f"{page.rel_path}: {msg}" for msg in errors
        )

    def _rel(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.io.root).as_posix()
        except (ValueError, OSError):
            return str(path)


# ---------- 文本规范化与 HTML 序列化 ----------
def _normalize_ws(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def _normalize_body(text: str) -> str:
    lines = [_WS_RE.sub(" ", line).strip() for line in text.split("\n")]
    out = "\n".join(line for line in lines if line)
    return _NL_RE.sub("\n\n", out).strip()


_VOID_SERIALIZE = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)


def serialize_children(node: Node) -> str:
    parts: list[str] = []
    for child in node.children:
        _serialize_node(child, parts)
    return "".join(parts).strip()


def _serialize_node(node: Node, parts: list[str]) -> None:
    if node.tag == TEXT_TAG:
        parts.append(node.data)
        return
    attrs = "".join(
        f' {name}="{_escape_attr(value)}"' for name, value in node.attrs.items()
    )
    parts.append(f"<{node.tag}{attrs}>")
    if node.tag not in _VOID_SERIALIZE:
        for child in node.children:
            _serialize_node(child, parts)
        parts.append(f"</{node.tag}>")


def _escape_attr(value: str) -> str:
    return (value.replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))
