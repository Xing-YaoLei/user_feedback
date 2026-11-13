"""极简 DOM：基于 html.parser 构建节点树，不依赖第三方库。

只实现比对工具需要的能力：节点遍历、属性访问、文本提取。
"""

from __future__ import annotations

from html.parser import HTMLParser

VOID_TAGS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)

# 隐式闭合规则：打开这些标签时，栈顶同类型（或同族）标签先关闭
_IMPLICIT_CLOSE = {
    "li": {"li"},
    "dt": {"dt", "dd"},
    "dd": {"dt", "dd"},
    "option": {"option", "optgroup"},
    "optgroup": {"optgroup"},
    "tr": {"tr"},
    "td": {"td", "th"},
    "th": {"td", "th"},
    "thead": {"thead", "tbody", "tfoot"},
    "tbody": {"thead", "tbody", "tfoot"},
    "tfoot": {"thead", "tbody"},
    "p": {"p"},
}

BLOCK_TAGS = frozenset(
    """address article aside blockquote body dd div dl dt fieldset figcaption
    figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav noscript ol p
    pre section table tbody td tfoot th thead tr ul""".split()
)

TEXT_TAG = "#text"


class Node:
    __slots__ = ("tag", "attrs", "parent", "children", "data")

    def __init__(self, tag: str | None, attrs: dict | None = None):
        self.tag = tag
        self.attrs = attrs if attrs is not None else {}
        self.parent: Node | None = None
        self.children: list[Node] = []
        self.data: str = ""  # 仅 #text 节点使用

    # ---- 基础属性 ----
    def get(self, name: str, default: str | None = None) -> str | None:
        return self.attrs.get(name.lower(), default)

    @property
    def id(self) -> str | None:
        return self.get("id")

    def classes(self) -> list[str]:
        raw = self.get("class") or ""
        return raw.split()

    def iter(self):
        """深度优先遍历自身及全部后代。"""
        yield self
        for child in self.children:
            yield from child.iter()

    def descendants(self):
        for child in self.children:
            yield from child.iter()

    def text_content(self) -> str:
        parts: list[str] = []
        self._collect_text(parts)
        return "".join(parts)

    def _collect_text(self, parts: list[str]) -> None:
        if self.tag == TEXT_TAG:
            parts.append(self.data)
            return
        block = self.tag in BLOCK_TAGS
        if block and parts and not parts[-1].endswith("\n"):
            parts.append("\n")
        for child in self.children:
            child._collect_text(parts)
        if block and parts and not parts[-1].endswith("\n"):
            parts.append("\n")


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#document")
        self.stack: list[Node] = [self.root]
        self._raw_tag: str | None = None  # script/style 原文收集

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self._raw_tag is not None:
            return
        self._implicit_close(tag)
        attr_map: dict[str, str] = {}
        for name, value in attrs:
            attr_map.setdefault(name.lower(), value if value is not None else "")
        node = Node(tag, attr_map)
        self._attach(node)
        if tag in VOID_TAGS:
            return
        self.stack.append(node)
        if tag in ("script", "style"):
            self._raw_tag = tag

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if self._raw_tag is not None:
            return
        self._implicit_close(tag)
        attr_map = {}
        for name, value in attrs:
            attr_map.setdefault(name.lower(), value if value is not None else "")
        self._attach(Node(tag, attr_map))

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self._raw_tag is not None:
            if tag == self._raw_tag:
                self._raw_tag = None
                self._pop_if_top(tag)
            return
        # 找到栈中最近的同名标签，闭合到它；找不到则忽略（容错）
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth].tag == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data):
        if self._raw_tag is not None:
            # script/style 内容保留在文本节点里，但不参与正文提取
            text = Node(TEXT_TAG)
            text.data = data
            self._attach(text)
            return
        if not data:
            return
        text = Node(TEXT_TAG)
        text.data = data
        self._attach(text)

    def handle_comment(self, data):
        return  # 注释不进树

    def handle_decl(self, decl):
        return

    def _implicit_close(self, tag: str) -> None:
        close_set = _IMPLICIT_CLOSE.get(tag)
        if not close_set:
            return
        while len(self.stack) > 1 and self.stack[-1].tag in close_set:
            self.stack.pop()

    def _attach(self, node: Node) -> None:
        node.parent = self.stack[-1]
        self.stack[-1].children.append(node)

    def _pop_if_top(self, tag: str) -> None:
        if len(self.stack) > 1 and self.stack[-1].tag == tag:
            self.stack.pop()


def parse_html(html_text: str) -> Node:
    """把 HTML 文本解析成 DOM 树根节点（#document）。"""
    builder = _TreeBuilder()
    builder.feed(html_text)
    builder.close()
    return builder.root
