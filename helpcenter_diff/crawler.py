"""沿站内链接 BFS 采集页面，记录链接边、断链与解析错误。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from .config import SiteRule
from .dom import Node, parse_html
from .siteio import SiteIO


@dataclass
class LinkEdge:
    source_url: str
    target_url: str
    link_text: str
    depth: int


@dataclass
class PageRecord:
    url: str
    rel_path: str
    depth: int
    is_textual: bool
    dom: Node | None = None
    in_edges: list[LinkEdge] = field(default_factory=list)
    read_error: str | None = None
    parse_error: str | None = None


@dataclass
class BrokenLink:
    source_url: str
    target_url: str
    link_text: str
    depth: int


@dataclass
class CrawlResult:
    site: str
    pages: dict[str, PageRecord]
    broken_links: list[BrokenLink]
    edges: list[LinkEdge]
    seed_urls: list[str]
    truncated: bool = False  # 触发 max_pages


class Crawler:
    def __init__(self, rule: SiteRule):
        self.rule = rule
        self.io = SiteIO(rule)
        self.pages: dict[str, PageRecord] = {}
        self.broken_links: list[BrokenLink] = []
        self.edges: list[LinkEdge] = []

    def run(self) -> CrawlResult:
        seeds = [self.io.base_url.rstrip("/") + "/" + p.lstrip("/")
                 for p in self.rule.crawl.index_pages]
        # 队列元素：(url, depth, 入队前已收集的入边)
        queue: list[tuple[str, int, list[LinkEdge]]] = [(u, 0, []) for u in seeds]
        queued: set[str] = set(seeds)
        truncated = False

        while queue:
            url, depth, pending_edges = queue.pop(0)
            if url in self.pages:
                continue
            if self.rule.crawl.max_pages and len(self.pages) >= self.rule.crawl.max_pages:
                truncated = True
                break
            page = self._fetch(url, depth)
            page.in_edges.extend(pending_edges)
            self.pages[url] = page
            if page.dom is None:
                continue
            for edge in self._extract_edges(page):
                self.edges.append(edge)
                target = edge.target_url
                if not self.io.is_internal(target):
                    continue
                if not self.io.exists(target):
                    self.broken_links.append(BrokenLink(
                        source_url=url,
                        target_url=target,
                        link_text=edge.link_text,
                        depth=edge.depth,
                    ))
                    continue
                if target in self.pages:
                    self.pages[target].in_edges.append(edge)
                    continue
                queued_item = self._find_queued(queue, target)
                if queued_item is not None:
                    queued_item[2].append(edge)
                    continue
                if not self._passes_filters(target):
                    continue
                if not self.io.is_textual(target):
                    # 资源文件登记存在性即可，不解析、不入队
                    self._ensure_resource_page(target, edge.depth, edge)
                    continue
                queued.add(target)
                queue.append((target, depth + 1, [edge]))

        return CrawlResult(
            site=self.rule.name,
            pages=self.pages,
            broken_links=self.broken_links,
            edges=self.edges,
            seed_urls=seeds,
            truncated=truncated,
        )

    @staticmethod
    def _find_queued(queue, target: str):
        for item in queue:
            if item[0] == target:
                return item
        return None

    # ---------- 内部 ----------
    def _fetch(self, url: str, depth: int) -> PageRecord:
        path = self.io.to_path(url)
        rel = self._rel(path) if path else url
        page = PageRecord(url=url, rel_path=rel, depth=depth, is_textual=False)
        try:
            text, actual_path = self.io.read_text(url)
        except (OSError, UnicodeError) as exc:
            page.read_error = f"{type(exc).__name__}: {exc}"
            return page
        page.rel_path = self._rel(actual_path)
        if not self.io.is_textual(url):
            return page
        page.is_textual = True
        try:
            page.dom = parse_html(text)
        except Exception as exc:  # 解析器容错很强，这里兜底
            page.parse_error = f"{type(exc).__name__}: {exc}"
        return page

    def _extract_edges(self, page: PageRecord) -> list[LinkEdge]:
        assert page.dom is not None
        out: list[LinkEdge] = []
        for node in page.dom.iter():
            if node.tag != "a":
                continue
            href = node.get("href")
            if href is None:
                continue
            target = self.io.resolve_link(page.url, href)
            if target is None:
                continue
            out.append(LinkEdge(
                source_url=page.url,
                target_url=target,
                link_text=_clean_text(node.text_content()),
                depth=page.depth + 1,
            ))
        return out

    def _ensure_resource_page(self, url: str, depth: int,
                              edge: LinkEdge | None = None) -> None:
        if url in self.pages:
            if edge is not None:
                self.pages[url].in_edges.append(edge)
            return
        path = self.io.to_path(url)
        page = PageRecord(
            url=url,
            rel_path=self._rel(path) if path else url,
            depth=depth,
            is_textual=False,
        )
        if edge is not None:
            page.in_edges.append(edge)
        self.pages[url] = page

    def _passes_filters(self, url: str) -> bool:
        path = urlsplit(url).path
        includes = self.rule.crawl._includes
        excludes = self.rule.crawl._excludes
        if includes and not any(rx.search(path) for rx in includes):
            return False
        if any(rx.search(path) for rx in excludes):
            return False
        return True

    def _rel(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.io.root).as_posix()
        except (ValueError, OSError):
            return str(path)


def _clean_text(text: str) -> str:
    return " ".join(text.split())
