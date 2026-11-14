"""Crawl a manual's table of contents into one JSONL search index per chapter.

Design notes
------------
* A chapter is one page named by a link in the manual's TOC.
* Body units are paragraphs (``<p>``) and block-level include links, in
  document order.  Ordinary links contribute their visible text.
* A link carrying ``data-include`` contributes the paragraphs of the fragment
  it points at, in place of the link.  Included fragments may include more
  fragments (recursive expansion).
* Relative hrefs are resolved against the page that contains the link.
* Pages are parsed once per crawl and cached by URL (fragment excluded), so
  many anchors on one page share a single read.
* A fragment may be included any number of times in a chapter; it is only an
  error when the same page+fragment appears again on the *current* include
  chain.
* A chapter with a cycle, a missing target page, or a missing anchor is written
  to the exception list instead of the index; other chapters are unaffected.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
from urllib.parse import unquote, urldefrag, urljoin, urlsplit
from urllib.request import url2pathname, urlopen

from .htmlnode import (
    HEADING_RE,
    Node,
    find_first,
    iter_elements,
    normalize_text,
    parse_html,
    region_for_anchor,
    text_content,
)

INCLUDE_ATTR = "data-include"


# ---------------------------------------------------------------------------
# URLs and page loading
# ---------------------------------------------------------------------------


def to_url(value: str) -> str:
    """Turn a local path or URL into an absolute URL."""

    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", value):
        return value
    return Path(value).expanduser().resolve().as_uri()


def local_path(url: str) -> Optional[Path]:
    parts = urlsplit(url)
    if parts.scheme != "file":
        return None
    return Path(url2pathname(parts.path))


def display_url(url: str, root: Optional[Path]) -> str:
    """Render *url* relative to the manual root when possible."""

    path = local_path(url)
    if path is not None and root is not None:
        try:
            return path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            return path.as_posix()
    return url


def _read_page(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme == "file":
        path = local_path(url)
        assert path is not None
        return path.read_text(encoding="utf-8")
    if parts.scheme in ("http", "https"):
        with urlopen(url, timeout=30) as response:  # noqa: S310 - explicit scheme check
            return response.read().decode("utf-8", "replace")
    raise ValueError(f"unsupported URL scheme: {parts.scheme}")


@dataclass
class LoadedPage:
    url: str
    root: Optional[Node] = None
    error: Optional[str] = None
    anchor_map: Dict[int, Optional[str]] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.root is not None and self.error is None


class PageLoader:
    """Fetch and parse each page at most once per crawl."""

    def __init__(self) -> None:
        self.cache: Dict[str, LoadedPage] = {}
        self.read_counts: Dict[str, int] = {}

    def load(self, url: str) -> LoadedPage:
        page_url, _ = urldefrag(url)
        if page_url in self.cache:
            return self.cache[page_url]

        self.read_counts[page_url] = self.read_counts.get(page_url, 0) + 1
        try:
            source = _read_page(page_url)
        except (OSError, ValueError) as exc:
            page = LoadedPage(page_url, error=f"{type(exc).__name__}: {exc}")
        else:
            root = parse_html(source)
            page = LoadedPage(page_url, root=root, anchor_map=build_anchor_map(root))
        self.cache[page_url] = page
        return page


def build_anchor_map(root: Node) -> Dict[int, Optional[str]]:
    """Map each element to the nearest preceding heading id.

    ``id()`` is used only on nodes owned by *root*, which stays alive as long
    as the map does.
    """

    mapping: Dict[int, Optional[str]] = {}
    current: Optional[str] = None
    for node in iter_elements(root):
        mapping[id(node)] = current
        if HEADING_RE.match(node.tag) and node.get("id"):
            current = node.get("id")
    return mapping


def anchor_for(node: Node, root: Node, anchor_map: Dict[int, Optional[str]]) -> Optional[str]:
    """Return the fragment anchor a chapter paragraph belongs to."""

    current: Optional[Node] = node
    while current is not None and current is not root:
        if current.get("id"):
            return current.get("id")
        current = current.parent
    return anchor_map.get(id(node))


def find_anchor(root: Node, fragment: str) -> Optional[Node]:
    """Find the element defining *fragment* (``id`` or legacy ``a[name]``)."""

    for node in iter_elements(root):
        if node.get("id") == fragment:
            return node
        if node.tag == "a" and node.get("name") == fragment:
            return node
    return None


# ---------------------------------------------------------------------------
# HTML body traversal
# ---------------------------------------------------------------------------


def is_include_link(node: Node) -> bool:
    return node.tag == "a" and INCLUDE_ATTR in node.attrs


def iter_units(node: Node) -> Iterator[Tuple[str, Node]]:
    """Yield ``("p", node)`` and ``("include", link)`` units in document order.

    Paragraphs are leaves: their inline includes are handled while rendering
    the paragraph.  Other elements are descended into so block-level include
    links are found too.
    """

    for child in node.children:
        if not isinstance(child, Node):
            continue
        if child.tag in ("script", "style"):
            continue
        if child.tag == "p":
            yield "p", child
        elif is_include_link(child):
            yield "include", child
        else:
            yield from iter_units(child)


def paragraph_blocks(blocks: Sequence[Node]) -> List[Tuple[str, Node]]:
    """Flatten an anchored region's blocks into paragraph/include units."""

    units: List[Tuple[str, Node]] = []
    for block in blocks:
        if block.tag == "p":
            units.append(("p", block))
        elif is_include_link(block):
            units.append(("include", block))
        else:
            units.extend(iter_units(block))
    return units


# ---------------------------------------------------------------------------
# Crawl model
# ---------------------------------------------------------------------------


class IncludeFailure(Exception):
    def __init__(self, kind: str, message: str, steps: List[dict]):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.steps = steps


@dataclass
class ChapterResult:
    url: str  # display form
    canonical_url: str
    title: str
    paragraphs: List[dict]
    slug: str = ""

    def chapter_record(self) -> dict:
        return {
            "type": "chapter",
            "chapter_url": self.url,
            "title": self.title,
            "paragraphs": len(self.paragraphs),
        }


@dataclass
class CrawlResult:
    chapters: List[ChapterResult] = field(default_factory=list)
    exceptions: List[dict] = field(default_factory=list)


def _error_chain(steps: List[dict]) -> List[str]:
    return [f"{step['target']}#{step['anchor']}" for step in steps]


class Crawler:
    def __init__(self, root: Optional[Path] = None, loader: Optional[PageLoader] = None):
        self.root = root.resolve() if root is not None else None
        self.loader = loader or PageLoader()

    # -- URL helpers --------------------------------------------------------

    def display(self, url: str) -> str:
        return display_url(url, self.root)

    # -- chapter indexing ---------------------------------------------------

    def index_chapter(self, chapter_url: str) -> Tuple[Optional[ChapterResult], Optional[dict]]:
        chapter_page = self.loader.load(chapter_url)
        chapter_display = self.display(chapter_url)

        if not chapter_page.ok:
            exception = self._exception(
                chapter_display,
                "",
                "missing-page",
                f"章节页面不存在：{chapter_display}",
                [],
            )
            return None, exception

        root = chapter_page.root
        assert root is not None
        title = chapter_title(root) or chapter_display
        body = (
            find_first(root, "main")
            or find_first(root, "article")
            or find_first(root, "body")
            or root
        )

        root_chain: List[Tuple[str, Optional[str]]] = [(chapter_page.url, None)]
        paragraphs: List[dict] = []
        try:
            for kind, node in iter_units(body):
                if kind == "p":
                    anchor = anchor_for(node, root, chapter_page.anchor_map)
                    paragraphs.extend(
                        self._paragraph_records(
                            node, chapter_page.url, anchor, root_chain, []
                        )
                    )
                else:
                    paragraphs.extend(
                        self._expand_include(node, chapter_page.url, root_chain, [])
                    )
        except IncludeFailure as failure:
            exception = self._exception(
                chapter_display,
                title,
                failure.kind,
                failure.message,
                failure.steps,
            )
            return None, exception

        return (
            ChapterResult(
                url=chapter_display,
                canonical_url=chapter_page.url,
                title=title,
                paragraphs=paragraphs,
            ),
            None,
        )

    def _exception(
        self, chapter: str, title: str, kind: str, message: str, steps: List[dict]
    ) -> dict:
        return {
            "type": "exception",
            "chapter": chapter,
            "title": title,
            "kind": kind,
            "message": message,
            "chain": steps,
            "include_chain": [chapter] + _error_chain(steps),
        }

    def _paragraph_records(
        self,
        paragraph: Node,
        page_url: str,
        anchor: Optional[str],
        chain_keys: List[Tuple[str, Optional[str]]],
        chain_steps: List[dict],
    ) -> List[dict]:
        records: List[dict] = []
        buffer: List[str] = []

        def flush() -> None:
            text = normalize_text("".join(buffer))
            buffer.clear()
            # A paragraph cut in two by an inline include can leave a fragment
            # that is only punctuation; it carries no searchable content.
            if text and re.search(r"\w", text):
                records.append(
                    {
                        "type": "paragraph",
                        "text": text,
                        "source": self.display(page_url),
                        "anchor": anchor,
                    }
                )

        def walk(node: Node) -> None:
            for child in node.children:
                if isinstance(child, str):
                    buffer.append(child)
                elif child.tag in ("script", "style"):
                    continue
                elif child.tag == "br":
                    buffer.append(" ")
                elif is_include_link(child):
                    flush()
                    records.extend(
                        self._expand_include(child, page_url, chain_keys, chain_steps)
                    )
                else:
                    walk(child)

        walk(paragraph)
        flush()
        return records

    def _expand_include(
        self,
        link: Node,
        page_url: str,
        chain_keys: List[Tuple[str, Optional[str]]],
        chain_steps: List[dict],
    ) -> List[dict]:
        href = (link.get("href") or "").strip()
        if not href:
            raise IncludeFailure(
                "missing-anchor",
                "包含链接缺少 href",
                chain_steps,
            )

        target_abs = urljoin(page_url, href)
        target_page, fragment = urldefrag(target_abs)
        fragment_text = unquote(fragment)
        step = {
            "page": self.display(page_url),
            "href": href,
            "target": self.display(target_page),
            "anchor": fragment_text,
        }
        steps = chain_steps + [step]

        if not fragment_text:
            raise IncludeFailure(
                "missing-anchor",
                f"包含链接没有指定片段：{self.display(target_page)}",
                steps,
            )

        key = (target_page, fragment_text)
        if key in chain_keys:
            route = self._route(chain_keys, steps)
            raise IncludeFailure("cycle", f"检测到循环引用：{route}", steps)

        target = self.loader.load(target_page)
        if not target.ok:
            raise IncludeFailure(
                "missing-page",
                f"目标页面不存在：{self.display(target_page)}",
                steps,
            )

        root = target.root
        assert root is not None
        anchor_node = find_anchor(root, fragment_text)
        if anchor_node is None:
            raise IncludeFailure(
                "missing-anchor",
                f"目标锚点不存在：{self.display(target_page)}#{fragment_text}",
                steps,
            )

        next_keys = chain_keys + [key]
        records: List[dict] = []
        for kind, unit in paragraph_blocks(region_for_anchor(anchor_node)):
            if kind == "p":
                records.extend(
                    self._paragraph_records(
                        unit, target_page, fragment_text, next_keys, steps
                    )
                )
            else:
                records.extend(
                    self._expand_include(unit, target_page, next_keys, steps)
                )
        return records

    def _route(
        self,
        chain_keys: List[Tuple[str, Optional[str]]],
        steps: List[dict],
    ) -> str:
        parts = [self.display(chain_keys[0][0])]
        for step in steps:
            parts.append(f"{step['target']}#{step['anchor']}")
        return " -> ".join(parts)

    # -- TOC ----------------------------------------------------------------

    def chapter_links(self, toc_url: str) -> List[str]:
        toc = self.loader.load(toc_url)
        if not toc.ok:
            raise RuntimeError(f"无法读取目录页：{self.display(toc_url)}")
        assert toc.root is not None

        scope = self._toc_scope(toc.root)
        toc_page, _ = urldefrag(toc.url)
        links: List[str] = []
        seen = set()
        for node in iter_elements(scope):
            if node.tag != "a":
                continue
            href = (node.get("href") or "").strip()
            if not href or href.startswith("#") or href.lower().startswith("javascript:"):
                continue
            page, _ = urldefrag(urljoin(toc.url, href))
            if page == toc_page or page in seen:
                continue
            seen.add(page)
            links.append(page)
        return links

    @staticmethod
    def _toc_scope(root: Node) -> Node:
        for node in iter_elements(root):
            classes = (node.get("class") or "").split()
            if node.get("id") in ("toc", "contents") or "toc" in classes:
                return node
        nav = find_first(root, "nav")
        if nav is not None:
            return nav
        main = find_first(root, "main")
        if main is not None:
            return main
        return root

    # -- whole crawl --------------------------------------------------------

    def crawl(self, toc_url: str, out_dir: Path) -> CrawlResult:
        result = CrawlResult()
        used_slugs = set()
        out_dir.mkdir(parents=True, exist_ok=True)

        for chapter_url in self.chapter_links(toc_url):
            chapter, exception = self.index_chapter(chapter_url)
            if exception is not None:
                result.exceptions.append(exception)
                continue
            assert chapter is not None
            chapter.slug = unique_slug(chapter.url, used_slugs)
            result.chapters.append(chapter)
            write_chapter(out_dir / "index" / f"{chapter.slug}.jsonl", chapter)

        write_exceptions(out_dir / "exceptions.jsonl", result.exceptions)
        write_manifest(out_dir / "manifest.json", result)
        return result


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def chapter_title(root: Node) -> str:
    heading = find_first(root, "h1")
    if heading is not None:
        title = text_content(heading)
        if title:
            return title
    title_node = find_first(root, "title")
    if title_node is not None:
        return text_content(title_node)
    return ""


def unique_slug(url: str, used: set) -> str:
    """Build a stable, filesystem-safe slug from a page URL or path."""

    parts = urlsplit(url)
    if parts.scheme and parts.netloc:
        path = parts.netloc + parts.path
    else:
        path = url
    segments = [segment for segment in path.split("/") if segment not in ("", ".", "..")]
    if not segments:
        segments = ["chapter"]
    segments[-1] = re.sub(r"\.[^./]+$", "", segments[-1]) or "index"
    raw = "-".join(segments)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-") or "chapter"
    candidate = slug
    counter = 2
    while candidate in used:
        candidate = f"{slug}-{counter}"
        counter += 1
    used.add(candidate)
    return candidate


def _write_jsonl(path: Path, records: Iterable[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")


def write_chapter(path: Path, chapter: ChapterResult) -> None:
    _write_jsonl(path, [chapter.chapter_record(), *chapter.paragraphs])


def write_exceptions(path: Path, exceptions: List[dict]) -> None:
    _write_jsonl(path, exceptions)


def write_manifest(path: Path, result: CrawlResult) -> None:
    payload = {
        "chapters": [
            {
                "url": chapter.url,
                "title": chapter.title,
                "index": f"index/{chapter.slug}.jsonl",
                "paragraphs": len(chapter.paragraphs),
            }
            for chapter in result.chapters
        ],
        "exceptions": [
            {
                "chapter": exception["chapter"],
                "title": exception["title"],
                "kind": exception["kind"],
                "message": exception["message"],
            }
            for exception in result.exceptions
        ],
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m indexer",
        description="Crawl a manual TOC into one JSONL index file per chapter.",
    )
    parser.add_argument("--toc", required=True, help="manual table-of-contents page")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument(
        "--root",
        help="manual root used to make URLs relative (default: TOC directory)",
    )
    args = parser.parse_args(argv)

    toc_url = to_url(args.toc)
    if args.root:
        root = Path(args.root)
    else:
        toc_path = local_path(toc_url)
        root = toc_path.parent if toc_path is not None else Path.cwd()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Remove a previous index so chapters that now fail do not leave stale files.
    index_dir = out_dir / "index"
    if index_dir.exists():
        shutil.rmtree(index_dir)
    index_dir.mkdir(parents=True)

    crawler = Crawler(root=root)
    result = crawler.crawl(toc_url, out_dir)

    for chapter in result.chapters:
        print(f"indexed  {chapter.url} -> index/{chapter.slug}.jsonl ({len(chapter.paragraphs)} paragraphs)")
    for exception in result.exceptions:
        print(f"excluded {exception['chapter']}: {exception['message']}")
    print(
        f"done: {len(result.chapters)} chapter(s) indexed, "
        f"{len(result.exceptions)} chapter(s) excluded"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
