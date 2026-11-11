# -*- coding: utf-8 -*-
"""HTML 表单解析。

只使用标准库 html.parser，输出结构化的 FormInfo；
解析结果完全来自页面实际内容，采集器不硬编码任何隐藏字段值，
也不自行拼接翻页地址——回发地址一律取表单 action。
"""

from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin


@dataclass
class Control:
    name: str
    value: str = ""
    ctype: str = "input"          # input / select / button / textarea
    subtype: str = ""             # hidden / submit / text ...
    options: list = field(default_factory=list)  # select 的全部 option value


@dataclass
class FormInfo:
    index: int                     # 该表单在文档中的序号（同名消歧依据）
    name: str
    form_id: str
    method: str
    action: str                    # 已解析为绝对地址
    controls: list = field(default_factory=list)
    hidden: dict = field(default_factory=dict)
    buttons: list = field(default_factory=list)  # [(name, value, label)]

    def has_hidden_state(self) -> bool:
        return bool(self.hidden)

    def hidden_control_names(self):
        return [c.name for c in self.controls if c.subtype == "hidden"]


class _FormHTMLParser(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.forms = []
        self._form = None
        self._select = None
        self._button = None
        self._button_label = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self._form = {
                "name": attrs.get("name", ""),
                "id": attrs.get("id", ""),
                "method": (attrs.get("method") or "get").lower(),
                "action": urljoin(self.base_url, attrs.get("action") or ""),
                "controls": [],
                "hidden": {},
                "buttons": [],
            }
        elif self._form is None:
            return
        elif tag == "input":
            ctl = Control(
                name=attrs.get("name", ""),
                value=attrs.get("value", ""),
                ctype="input",
                subtype=(attrs.get("type") or "text").lower(),
            )
            if ctl.name:
                self._form["controls"].append(ctl)
                if ctl.subtype == "hidden":
                    self._form["hidden"][ctl.name] = ctl.value
                if ctl.subtype == "submit":
                    self._form["buttons"].append((ctl.name, ctl.value, ctl.value))
        elif tag == "select":
            ctl = Control(name=attrs.get("name", ""), ctype="select",
                          subtype="select", options=[])
            if ctl.name:
                self._form["controls"].append(ctl)
                self._select = ctl
        elif tag == "option" and self._select is not None:
            value = attrs.get("value", "")
            self._select.options.append(value)
            if attrs.get("selected") is not None:
                self._select.value = value
        elif tag == "button":
            ctl = Control(
                name=attrs.get("name", ""),
                value=attrs.get("value", ""),
                ctype="button",
                subtype=(attrs.get("type") or "submit").lower(),
            )
            if ctl.name and ctl.subtype == "submit":
                self._form["controls"].append(ctl)
                self._button = ctl
                self._button_label = []
        elif tag == "textarea" and self._form is not None:
            ctl = Control(name=attrs.get("name", ""), ctype="textarea",
                          subtype="textarea")
            if ctl.name:
                self._form["controls"].append(ctl)

    def handle_data(self, data):
        if self._button is not None:
            self._button_label.append(data)

    def handle_endtag(self, tag):
        if tag == "select":
            self._select = None
        elif tag == "button" and self._button is not None and self._form is not None:
            label = "".join(self._button_label).strip() or self._button.value
            self._form["buttons"].append(
                (self._button.name, self._button.value, label)
            )
            self._button = None
            self._button_label = []
        elif tag == "form" and self._form is not None:
            self.forms.append(self._form)
            self._form = None


def parse_forms(html_text: str, base_url: str):
    parser = _FormHTMLParser(base_url)
    parser.feed(html_text)
    result = []
    for i, raw in enumerate(parser.forms):
        result.append(FormInfo(
            index=i,
            name=raw["name"],
            form_id=raw["id"],
            method=raw["method"],
            action=raw["action"],
            controls=list(raw["controls"]),
            hidden=dict(raw["hidden"]),
            buttons=list(raw["buttons"]),
        ))
    return result


def select_form(forms, name: str = "", prefer_stateful: bool = True,
                index: int = None) -> FormInfo:
    """在（同名）表单集合里选出目标表单。

    * index 直接指定文档序号，优先级最高；
    * 否则按 name 过滤，并优先 method=post 的回发表单；
    * prefer_stateful=True 时优先选择带隐藏状态字段的真实表单，
      从而跳过没有隐藏字段的同名诱饵表单。
    """
    candidates = list(forms)
    if index is not None:
        for form in forms:
            if form.index == index:
                return form
        raise FormParseError(f"页面中不存在序号为 {index} 的表单")
    if name:
        candidates = [f for f in candidates if f.name == name]
    if not candidates:
        raise FormParseError(f"页面中未找到 name={name!r} 的表单")
    post_forms = [f for f in candidates if f.method == "post"]
    if post_forms:
        candidates = post_forms
    if prefer_stateful:
        stateful = [f for f in candidates if f.has_hidden_state()]
        if stateful:
            candidates = stateful
    if len(candidates) == 1:
        return candidates[0]
    # 多个候选且无法消歧时显式失败，禁止猜测
    raise FormParseError(
        "存在多个同名字表且无法消歧：" +
        ", ".join(f"#{f.index}(id={f.form_id or '-'})" for f in candidates)
    )


def find_button(buttons, wanted_value: str = "", wanted_name: str = ""):
    """按按钮的 value/name 匹配页面真实存在的提交按钮，返回 (name, value)。"""
    for name, value, label in buttons:
        if wanted_value and value != wanted_value:
            continue
        if wanted_name and name != wanted_name:
            continue
        return name, value
    raise FormParseError(
        f"页面按钮中找不到 value={wanted_value!r}/name={wanted_name!r}，"
        f"现有按钮：{buttons}"
    )


class FormParseError(Exception):
    pass
