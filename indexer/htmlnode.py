"""Small, dependency-free helpers for turning HTML into an indexable tree."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Iterator, List, Optional

VOID_TAGS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)

# Block-level elements.  Starting one of these implicitly closes an open <p>,
# which keeps hand-written pages without explicit </p> well nested enough.
BLOCK_TAGS = frozenset(
    {
        "address",
        "article",
        "aside",
        "blockquote",
        "details",
        "div",
        "dl",
        "dt",
        "dd",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "ul",
    }
)

# Elements that can carry a fragment anchor and define a region themselves.
CONTAINER_TAGS = frozenset(
    {
        "article",
        "aside",
        "blockquote",
        "dd",
        "details",
        "div",
        "dl",
        "dt",
        "figure",
        "li",
        "main",
        "ol",
        "section",
        "table",
        "tbody",
        "td",
        "th",
        "tfoot",
        "thead",
        "tr",
        "ul",
    }
)

HEADING_RE = re.compile(r"^h([1-6])$")


def normalize_text(value: str) -> str:
    """Collapse all whitespace runs to a single space and trim."""

    return " ".join(value.split())


class Node:
    """An element node; text children are plain ``str`` objects."""

    __slots__ = ("tag", "attrs", "children", "parent", "line")

    def __init__(self, tag: str, attrs=None, parent: Optional["Node"] = None, line: int = 0):
        self.tag = tag
        self.attrs = {key: (value if value is not None else "") for key, value in (attrs or ())}
        self.children: List[object] = []
        self.parent = parent
        self.line = line

    def get(self, name: str, default=None):
        return self.attrs.get(name, default)

    def has(self, name: str) -> bool:
        return name in self.attrs

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Node {self.tag} attrs={self.attrs!r} children={len(self.children)}>"


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("#document")
        self._stack = [self.root]
        self._raw_text_depth = 0

    @property
    def _current(self) -> Node:
        return self._stack[-1]

    def _close_open_paragraph(self) -> None:
        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == "p":
                del self._stack[index:]
                return

    def handle_starttag(self, tag, attrs):
        if self._raw_text_depth:
            return
        if tag in ("script", "style"):
            self._raw_text_depth += 1
            return
        if tag in BLOCK_TAGS:
            self._close_open_paragraph()
        node = Node(tag, attrs, self._current, self.getpos()[0])
        self._current.children.append(node)
        if tag not in VOID_TAGS:
            self._stack.append(node)

    def handle_startendtag(self, tag, attrs):
        if self._raw_text_depth:
            return
        if tag in ("script", "style"):
            return
        node = Node(tag, attrs, self._current, self.getpos()[0])
        self._current.children.append(node)

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            if self._raw_text_depth:
                self._raw_text_depth -= 1
            return
        if self._raw_text_depth or tag in VOID_TAGS:
            return
        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == tag:
                del self._stack[index:]
                return

    def handle_data(self, data):
        if self._raw_text_depth or not data:
            return
        self._current.children.append(data)


def parse_html(source: str) -> Node:
    builder = _TreeBuilder()
    builder.feed(source)
    builder.close()
    return builder.root


def iter_elements(root: Node) -> Iterator[Node]:
    """Yield all descendant elements of *root* in document order."""

    stack = [child for child in reversed(root.children) if isinstance(child, Node)]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(child for child in reversed(node.children) if isinstance(child, Node))


def find_first(root: Node, tag: str) -> Optional[Node]:
    for node in iter_elements(root):
        if node.tag == tag:
            return node
    return None


def text_content(node: Node) -> str:
    """Return the visible text of *node*, whitespace-normalized."""

    chunks: List[str] = []

    def walk(current: Node) -> None:
        for child in current.children:
            if isinstance(child, str):
                chunks.append(child)
            elif child.tag in ("script", "style"):
                continue
            elif child.tag == "br":
                chunks.append(" ")
            else:
                walk(child)

    walk(node)
    return normalize_text("".join(chunks))


def following_siblings(node: Node) -> Iterator[Node]:
    parent = node.parent
    if parent is None:
        return
    seen = False
    for child in parent.children:
        if not isinstance(child, Node):
            continue
        if child is node:
            seen = True
            continue
        if seen:
            yield child


def _has_anchor(node: Node) -> bool:
    return bool(node.get("id")) or (node.tag == "a" and bool(node.get("name")))


def region_for_anchor(anchor: Node) -> List[Node]:
    """Return the block nodes that form the region anchored by *anchor*.

    * a <p> -> that paragraph alone;
    * a container (<section>, <div>, <article>, ...) -> the container itself;
    * a heading -> the following sibling blocks up to the next equal/higher
      heading or the next anchored element;
    * a legacy empty <a id>/<a name> -> the following sibling block run;
    * an inline element carrying the id -> the region of its nearest block
      ancestor.
    """

    if anchor.tag == "p":
        return [anchor]
    if anchor.tag in CONTAINER_TAGS:
        return [anchor]

    if HEADING_RE.match(anchor.tag):
        level = int(HEADING_RE.match(anchor.tag).group(1))
        return _collect_region(following_siblings(anchor), level)

    if anchor.tag == "a" and not text_content(anchor):
        return _collect_region(following_siblings(anchor), None)

    ancestor = anchor.parent
    while ancestor is not None:
        if (
            ancestor.tag == "p"
            or ancestor.tag in CONTAINER_TAGS
            or HEADING_RE.match(ancestor.tag)
        ):
            return region_for_anchor(ancestor)
        ancestor = ancestor.parent
    return [anchor]


def _collect_region(start_nodes, stop_heading_level: Optional[int]) -> List[Node]:
    region: List[Node] = []
    boundary = stop_heading_level
    first = True
    for sibling in start_nodes:
        if not first and _has_anchor(sibling):
            break
        first = False
        match = HEADING_RE.match(sibling.tag)
        if match:
            level = int(match.group(1))
            if boundary is None:
                boundary = level
            elif level <= boundary:
                break
        region.append(sibling)
    return region
