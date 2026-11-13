"""CSS 选择器的一个小子集，支持配置里需要的全部写法。

支持的单个复合选择器（以空格/ >/ +/ ~ 组合）：
  tag, *, #id, .class, [attr], [attr=val], [attr~=val], [attr^=val],
  [attr$=val], [attr*=val], [attr!=val]（工具扩展：不等于）
组合器：后代（空格）、子（>）、相邻兄弟（+）、后续兄弟（~）
选择器列表：逗号分隔
伪类仅支持 :not(...)，:not 内支持复合选择器列表
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .dom import Node, TEXT_TAG

_SIMPLE_RE = re.compile(
    r"""
    (?P<tag>[a-zA-Z][\w-]*|\*)?
    (?:\#(?P<id>[\w-]+))?
    (?P<classes>(?:\.[\w-]+)*)
    (?P<attrs>(?:\[[^\]]+\])*)
    (?P<not>:not\([^)]*\))?
    """,
    re.VERBOSE,
)
_ATTR_RE = re.compile(
    r"""\[\s*([\w-]+)\s*(?:([~^$*!]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]\s'"]+)\s*)?\]"""
)
_COMBINATOR_RE = re.compile(r"\s*([ >+~])\s*|\s+")


@dataclass
class SimpleSelector:
    tag: str | None = None
    elem_id: str | None = None
    classes: tuple[str, ...] = ()
    attrs: tuple[tuple[str, str | None, str | None], ...] = ()  # (name, op, value)
    not_selectors: tuple["CompoundSelector", ...] = ()

    def matches(self, node: Node) -> bool:
        if node.tag == TEXT_TAG:
            return False
        if self.tag is not None and self.tag != "*" and node.tag != self.tag:
            return False
        if self.elem_id is not None and node.id != self.elem_id:
            return False
        if self.classes:
            node_classes = set(node.classes())
            if any(c not in node_classes for c in self.classes):
                return False
        for name, op, value in self.attrs:
            actual = node.get(name)
            if not _attr_match(actual, op, value):
                return False
        for compound in self.not_selectors:
            if compound.matches(node):
                return False
        return True


def _attr_match(actual: str | None, op: str | None, value: str | None) -> bool:
    if op is None:
        return actual is not None
    if actual is None:
        return False
    if value is not None and len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        value = value[1:-1].replace("\\" + value[0], value[0])
    if op == "=":
        return actual == value
    if op == "!=":
        return actual != value
    if op == "~=":
        return value in actual.split()
    if op == "^=":
        return actual.startswith(value or "")
    if op == "$=":
        return actual.endswith(value or "")
    if op == "*=":
        return value in actual
    return False


@dataclass
class CompoundSelector:
    """左→右链式结构：left 指向左侧段，combinator 是 left 到本段的关系。"""
    simple: SimpleSelector
    left: "CompoundSelector | None" = None
    combinator: str = " "  # ' ' 后代, '>' 子, '+' 相邻, '~' 兄弟

    def matches(self, node: Node) -> bool:
        # 先命中最右段，再沿 left 链逐段向左验证组合器
        if not self.simple.matches(node):
            return False
        if self.left is None:
            return True
        if self.combinator == " ":
            ancestor = node.parent
            while ancestor is not None and ancestor.tag != "#document":
                if self.left.matches(ancestor):
                    return True
                ancestor = ancestor.parent
            return False
        if self.combinator == ">":
            parent = node.parent
            return parent is not None and self.left.matches(parent)
        if self.combinator == "+":
            prev = _previous_element(node)
            return prev is not None and self.left.matches(prev)
        if self.combinator == "~":
            sibling = _previous_element(node)
            while sibling is not None:
                if self.left.matches(sibling):
                    return True
                sibling = _previous_element(sibling)
            return False
        return False


def _previous_element(node: Node) -> Node | None:
    parent = node.parent
    if parent is None:
        return None
    found_self = False
    for sib in reversed(parent.children):
        if found_self and sib.tag != TEXT_TAG:
            return sib
        if sib is node:
            found_self = True
    return None


def _parse_simple(token: str) -> SimpleSelector:
    not_parts: tuple[CompoundSelector, ...] = ()
    not_match = re.search(r":not\(([^)]*)\)", token)
    if not_match:
        inner = not_match.group(1)
        not_parts = tuple(parse_selector_list(inner))
        token = token[: not_match.start()] + token[not_match.end():]

    m = _SIMPLE_RE.fullmatch(token)
    if not m or not (m.group("tag") or m.group("id") or m.group("classes") or m.group("attrs")):
        raise ValueError(f"无法解析选择器: {token!r}")
    attrs = tuple(
        (name, op or None, value if op else None)
        for name, op, value in _ATTR_RE.findall(m.group("attrs") or "")
    )
    return SimpleSelector(
        tag=m.group("tag"),
        elem_id=m.group("id"),
        classes=tuple(re.findall(r"\.([\w-]+)", m.group("classes") or "")),
        attrs=attrs,
        not_selectors=not_parts,
    )


def _parse_compound(text: str) -> CompoundSelector:
    # 拆出组合器与简单选择器段
    tokens: list[tuple[str, str]] = []  # (combinator, simple-token)
    i = 0
    first = True
    text = text.strip()
    while i < len(text):
        if not first:
            m = _COMBINATOR_RE.match(text, i)
            if not m:
                raise ValueError(f"选择器语法错误: {text!r}")
            combinator = m.group(1) or " "
            i = m.end()
        else:
            combinator = " "
            first = False
        start = i
        depth = 0
        while i < len(text):
            ch = text[i]
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
            elif depth == 0 and ch in " >+~":
                break
            i += 1
        token = text[start:i].strip()
        if not token:
            raise ValueError(f"选择器语法错误: {text!r}")
        tokens.append((combinator, token))

    # 从左向右构建：最左段是根，每段把左侧段挂在自己的 left 上
    root = CompoundSelector(simple=_parse_simple(tokens[0][1]))
    current = root
    for combinator, token in tokens[1:]:
        current = CompoundSelector(
            simple=_parse_simple(token), left=current, combinator=combinator
        )
    return current


def parse_selector_list(text: str) -> list[CompoundSelector]:
    """解析逗号分隔的选择器列表。"""
    result = []
    for part in _split_top_level(text, ","):
        part = part.strip()
        if part:
            result.append(_parse_compound(part))
    if not result:
        raise ValueError(f"空选择器: {text!r}")
    return result


def _split_top_level(text: str, sep: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(text):
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return parts


def select(root: Node, selector_text: str) -> list[Node]:
    """在 root 的后代中选择匹配节点（不含 root 自身，除非它是文档节点）。"""
    compounds = parse_selector_list(selector_text)
    candidates = [n for n in root.iter() if n.tag not in (TEXT_TAG, "#document")]
    out: list[Node] = []
    seen: set[int] = set()
    for node in candidates:
        for compound in compounds:
            if compound.matches(node) and id(node) not in seen:
                seen.add(id(node))
                out.append(node)
                break
    return out


def select_first(root: Node, selector_text: str) -> Node | None:
    compounds = parse_selector_list(selector_text)
    for node in root.iter():
        if node.tag in (TEXT_TAG, "#document"):
            continue
        for compound in compounds:
            if compound.matches(node):
                return node
    return None
