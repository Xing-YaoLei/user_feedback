"""极简 HTML 解析：基于 html.parser 构建可遍历的节点树。"""

from __future__ import annotations

from html.parser import HTMLParser

_VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


class Node:
    """HTML 节点。tag 为 None 时表示文本节点。"""

    __slots__ = ("tag", "attrs", "children", "parent", "text")

    def __init__(self, tag=None, attrs=None, text="", parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent
        self.text = text

    def get(self, name, default=None):
        return self.attrs.get(name.lower(), default)

    def has_attr(self, name):
        return name.lower() in self.attrs

    def iter_nodes(self):
        for child in self.children:
            yield child
            yield from child.iter_nodes()

    def find_all(self, tag):
        tag = tag.lower()
        return [node for node in self.iter_nodes() if node.tag == tag]

    def find(self, tag):
        tag = tag.lower()
        for node in self.iter_nodes():
            if node.tag == tag:
                return node
        return None

    def get_text(self, sep=" "):
        parts = []

        def walk(node):
            if node.tag is None:
                stripped = node.text.strip()
                if stripped:
                    parts.append(stripped)
            for child in node.children:
                walk(child)

        walk(self)
        return sep.join(parts)


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    @staticmethod
    def _norm_attrs(attrs):
        result = {}
        for name, value in attrs:
            # 无值属性（如 <a data-notice>）在部分 Python 版本里 value 为 None
            result[name.lower()] = "" if value is None else value
        return result

    def _append(self, node):
        node.parent = self.stack[-1]
        self.stack[-1].children.append(node)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, self._norm_attrs(attrs))
        self._append(node)
        if tag not in _VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self._append(Node(tag, self._norm_attrs(attrs)))

    def handle_endtag(self, tag):
        # 容错：弹到最近的同名标签为止，忽略孤立的闭合标签
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth].tag == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data):
        if data:
            self._append(Node(text=data))


def parse_html(markup):
    """把 HTML 文本解析为节点树，返回根节点。"""
    builder = _TreeBuilder()
    builder.feed(markup)
    builder.close()
    return builder.root
