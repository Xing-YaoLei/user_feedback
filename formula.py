# -*- coding: utf-8 -*-
"""派生项公式的解析与安全求值。

公式只允许：十进制数字、{测量项} 引用、+ - * /、括号和一元正负号。
不使用 eval，避免字典内容变成可执行代码。
"""

import re
from decimal import Decimal, localcontext

_TOKEN_RE = re.compile(
    r"\s*(?:(?P<number>\d+(?:\.\d+)?)"
    r"|(?P<ref>\{[^{}]*\})"
    r"|(?P<op>[()+\-*/]))",
    re.ASCII,
)


class FormulaError(Exception):
    """公式语法错误。"""


def _tokenize(text):
    tokens = []
    pos = 0
    while pos < len(text):
        m = _TOKEN_RE.match(text, pos)
        if not m or m.end() == pos:
            raise FormulaError(f"公式在第 {pos + 1} 个字符处无法解析: {text!r}")
        pos = m.end()
        if m.group("number") is not None:
            tokens.append(("number", Decimal(m.group("number"))))
        elif m.group("ref") is not None:
            name = m.group("ref")[1:-1].strip()
            if not name:
                raise FormulaError(f"公式含空的测量项引用: {text!r}")
            tokens.append(("ref", name))
        else:
            tokens.append(("op", m.group("op")))
    if not tokens:
        raise FormulaError("公式为空")
    return tokens


class _Parser:
    """递归下降：expr := term ((+|-) term)*; term := unary ((*|/) unary)*。"""

    def __init__(self, tokens, text):
        self.tokens = tokens
        self.pos = 0
        self.text = text

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else (None, None)

    def take(self):
        tok = self.peek()
        self.pos += 1
        return tok

    def parse(self):
        node = self.expr()
        if self.pos != len(self.tokens):
            raise FormulaError(f"公式存在多余内容: {self.text!r}")
        return node

    def expr(self):
        node = self.term()
        while self.peek() == ("op", "+") or self.peek() == ("op", "-"):
            op = self.take()[1]
            node = (op, node, self.term())
        return node

    def term(self):
        node = self.unary()
        while self.peek() == ("op", "*") or self.peek() == ("op", "/"):
            op = self.take()[1]
            node = (op, node, self.unary())
        return node

    def unary(self):
        if self.peek() == ("op", "-"):
            self.take()
            return ("neg", self.unary())
        if self.peek() == ("op", "+"):
            self.take()
            return self.unary()
        return self.atom()

    def atom(self):
        kind, value = self.take()
        if kind == "number":
            return ("num", value)
        if kind == "ref":
            return ("ref", value)
        if (kind, value) == ("op", "("):
            node = self.expr()
            if self.take() != ("op", ")"):
                raise FormulaError(f"公式括号不匹配: {self.text!r}")
            return node
        raise FormulaError(f"公式缺少数值或测量项: {self.text!r}")


def parse_formula(text):
    """把公式解析为语法树；语法错误抛 FormulaError。"""
    if not isinstance(text, str) or not text.strip():
        raise FormulaError("公式必须是非空字符串")
    return _Parser(_tokenize(text.strip()), text).parse()


def formula_references(node):
    """按出现顺序返回公式引用的测量项名（去重）。"""
    found = []
    stack = [node]
    while stack:
        item = stack.pop()
        kind = item[0]
        if kind == "ref":
            if item[1] not in found:
                found.append(item[1])
        elif kind == "num":
            continue
        elif kind == "neg":
            stack.append(item[1])
        else:
            stack.append(item[2])
            stack.append(item[1])
    return found


def evaluate(node, values, context):
    """用 values（测量项 -> Decimal）求值。

    values 缺少某个引用时抛 KeyError；除零、溢出等抛 ArithmeticError。
    """
    kind = node[0]
    if kind == "num":
        return node[1]
    if kind == "ref":
        return values[node[1]]
    if kind == "neg":
        return -evaluate(node[1], values, context)
    left = evaluate(node[1], values, context)
    right = evaluate(node[2], values, context)
    with localcontext(context):
        if kind == "+":
            return left + right
        if kind == "-":
            return left - right
        if kind == "*":
            return left * right
        return left / right
