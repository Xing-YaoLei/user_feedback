# -*- coding: utf-8 -*-
"""单查询采集会话：按状态机驱动 Cookie + 隐藏状态 + POST 回发。

状态链：
    ENTRY --GET--> 解析查询表单（取隐藏状态/按钮参数）
          --POST /query--> 第 1 页结果（成功后服务端轮转隐藏状态）
          --POST /pager（表单 action，禁止自造地址）--> 后续页 ...

每个查询拥有独立 HttpClient（独立 CookieJar），不同查询不共享状态链。
状态过期（错误页/4xx/会话失效）时从入口重建状态链并重跑，
恢复后用查询身份标记与数据行 ID 序列校验“拿到的还是同一批结果”。
"""

import hashlib
import re

from .form_parser import FormParseError, find_button, parse_forms, select_form
from .http_client import HttpClient
from .page_parser import parse_result_page


def _ascii_slug(text: str) -> str:
    """把查询名转成可用于 HTTP 头的 ASCII 短标识。

    非 ASCII 字符以 - 替代，并追加原名的短哈希后缀，
    保证不同中文名（如“全量商品”“电子类”）不会坍缩成同一标识。
    """
    raw = str(text)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", raw).strip("-") or "job"
    suffix = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:6]
    return f"{slug}-{suffix}"


class CollectorError(Exception):
    pass


class StateExpiredError(CollectorError):
    """隐藏状态/会话失效，需要从入口恢复。"""


class PageOrderError(CollectorError):
    """响应页序与期望顺序不符（页序回退）。"""


class IdentityMismatchError(CollectorError):
    """恢复后的结果身份与恢复前不一致。"""


class UrlPolicyError(CollectorError):
    """请求地址不在“入口/页面表单 action”白名单内。"""


# 服务端错误页或隐藏状态校验失败的提示特征
_EXPIRY_HINTS = (
    "过期", "作废", "无效", "viewstate", "nonce", "会话", "已被使用",
)


class QuerySession:
    def __init__(self, config, evidence, redactor=None, timeout: float = 15.0,
                 interceptor=None):
        self.config = config
        self.evidence = evidence
        self.redactor = redactor
        self.http = HttpClient(timeout=timeout)
        self.interceptor = interceptor  # 测试钩子：在每次请求前注入故障
        self._slug = _ascii_slug(config.name)
        self.chain_id = f"chain-{self._slug}"
        self._seq = 0
        self._allowed_urls = set()      # URL 白名单：只允许入口与页面提供的 action
        self.recoveries = 0
        self.chain_attempts = 0         # 状态链编号（恢复一次加一）
        # 身份锚点：首次成功查询首页的身份（关键词/分类/行 ID 序列）。
        # 一旦建立即锁定，任何恢复都不覆盖，用于发现恢复后的身份漂移。
        self._identity_anchor = None
        # 兼容旧命名
        self._baseline_before_expiry = None

    # ------------------------------------------------------------- 底层请求
    def _next_seq(self):
        self._seq += 1
        return self._seq

    def _check_url(self, url: str):
        if url not in self._allowed_urls:
            raise UrlPolicyError(
                f"拒绝请求未由页面表单提供的地址：{url}；"
                f"当前白名单：{sorted(self._allowed_urls)}"
            )

    def _do_get(self, url: str, allow_new: bool = False):
        if not allow_new:
            self._check_url(url)
        req_id = f"req-{self._slug}-{self._next_seq()}"
        if self.interceptor:
            self.interceptor("before_get", url, self)
        resp = self.http.get(url, request_id=req_id)
        self.evidence.record(
            chain_id=self.chain_id, seq=self._seq, request_id=req_id,
            method="GET", url=url, status=resp.status,
            response_request_id=resp.request_id, body_excerpt=resp.body,
            note=f"chain_attempt={self.chain_attempts}",
        )
        return resp

    def _do_post(self, url: str, fields: dict, step: str):
        self._check_url(url)
        req_id = f"req-{self._slug}-{self._next_seq()}"
        if self.interceptor:
            self.interceptor("before_post", url, self)
        resp = self.http.post_form(url, fields, request_id=req_id)
        self.evidence.record(
            chain_id=self.chain_id, seq=self._seq, request_id=req_id,
            method="POST", url=url, form=fields, status=resp.status,
            response_request_id=resp.request_id, body_excerpt=resp.body,
            note=f"{step};chain_attempt={self.chain_attempts}",
        )
        return resp

    @staticmethod
    def _looks_expired(resp, page) -> bool:
        if resp.status >= 400:
            return True
        if page.page_type == "error":
            text = page.error_message
            return any(hint in text for hint in _EXPIRY_HINTS)
        return False

    @staticmethod
    def _entry_field_values(form):
        """从入口表单的文本框/下拉框控件提取当前回显值（不含隐藏状态与按钮）。"""
        values = {}
        for ctl in form.controls:
            if ctl.subtype == "hidden" or ctl.ctype == "button":
                continue
            if ctl.ctype == "input" and ctl.subtype in ("text", "search", ""):
                values[ctl.name] = ctl.value
            elif ctl.ctype == "select":
                values[ctl.name] = ctl.value or (
                    ctl.options[0] if ctl.options else ""
                )
            elif ctl.ctype == "textarea":
                values[ctl.name] = ctl.value
        return values

    # ------------------------------------------------------------- 状态链
    def _open_chain(self):
        """从入口建立一条全新状态链，返回入口表单。"""
        self.chain_attempts += 1
        self._allowed_urls = {self.config.entry_url}
        resp = self._do_get(self.config.entry_url, allow_new=True)
        page = parse_result_page(resp.body)
        if self._looks_expired(resp, page):
            raise StateExpiredError(f"入口页异常：{page.error_message or resp.status}")
        forms = parse_forms(resp.body, resp.url)
        form = select_form(
            forms, name=self.config.form_name,
            index=self.config.form_index, prefer_stateful=True,
        )
        if not form.has_hidden_state():
            raise FormParseError("选中的查询表单不包含隐藏状态字段，无法回发")
        # 后续允许回发的地址完全来自页面 action
        self._allowed_urls.add(form.action)
        return form

    def _submit_query(self, entry_form):
        fields = dict(entry_form.hidden)   # 隐藏字段值逐字取自当前页面
        fields.update(self.config.fields)  # 业务字段来自配置
        btn_name, btn_value = find_button(
            entry_form.buttons,
            wanted_value=self.config.button_value,
            wanted_name=self.config.button_name,
        )
        fields[btn_name] = btn_value       # 按钮参数同样必须来自页面
        resp = self._do_post(entry_form.action, fields, step="query")
        page = parse_result_page(resp.body)
        if self._looks_expired(resp, page):
            raise StateExpiredError(
                f"查询回发被拒绝（状态过期/失效）：{page.error_message or resp.status}"
            )
        if page.page_type == "entry":
            # 例如 reset 按钮：服务端回到入口表单而不是结果页。
            # 用返回页面里的新表单自动补一次 search 回发，状态仍逐字取自页面；
            # 业务字段以入口回显（已被服务端重置）为准，不再沿用配置原值。
            forms = parse_forms(resp.body, resp.url)
            entry_form = select_form(
                forms, name=self.config.form_name,
                index=self.config.form_index, prefer_stateful=True,
            )
            self._allowed_urls.add(entry_form.action)
            fields = dict(entry_form.hidden)
            fields.update(self._entry_field_values(entry_form))
            btn_name, btn_value = find_button(
                entry_form.buttons,
                wanted_value="search",
                wanted_name=self.config.button_name,
            )
            fields[btn_name] = btn_value
            resp = self._do_post(entry_form.action, fields, step="query-after-entry")
            page = parse_result_page(resp.body)
            if self._looks_expired(resp, page):
                raise StateExpiredError(
                    f"补发查询被拒绝（状态过期/失效）：{page.error_message or resp.status}"
                )
        if page.page_type != "results":
            raise CollectorError(f"查询未返回结果页，实际类型：{page.page_type}")
        return resp, page

    def _follow_pages(self, first_resp, first_page):
        """仅通过页面里的翻页表单逐页回发，不构造任何翻页地址。"""
        collected = list(first_page.rows)
        page_seq = [first_page.page_number]
        resp, page = first_resp, first_page
        expected_page = first_page.page_number

        while len(page_seq) < self.config.max_pages:
            forms = parse_forms(resp.body, resp.url)
            try:
                pager = select_form(
                    forms, name=self.config.pager_form_name,
                    prefer_stateful=True,
                )
            except FormParseError:
                break  # 本页没有翻页表单（如末页）→ 正常结束
            if not pager.has_hidden_state():
                # 只剩无隐藏状态的同名诱饵表单（单页结果/末页）→ 无下一页
                break
            try:
                btn_name, btn_value = find_button(
                    pager.buttons, wanted_value=self.config.next_button_value
                )
            except FormParseError:
                break  # 页面不再提供“下一页”按钮 → 末页，正常结束
            self._allowed_urls.add(pager.action)

            fields = dict(pager.hidden)
            fields[btn_name] = btn_value
            resp = self._do_post(pager.action, fields, step="pager")
            page = parse_result_page(resp.body)
            if self._looks_expired(resp, page):
                raise StateExpiredError(
                    f"翻页回发被拒绝（状态过期/失效）：{page.error_message or resp.status}"
                )
            if page.page_type != "results":
                raise CollectorError(
                    f"翻页未返回结果页，实际类型：{page.page_type}"
                )

            # 页序回退检测：新页编号必须严格等于上一页 +1
            expected_page += 1
            if page.page_number != expected_page:
                raise PageOrderError(
                    f"页序回退/错乱：期望第 {expected_page} 页，"
                    f"实际收到第 {page.page_number} 页"
                )
            page_seq.append(page.page_number)
            collected.extend(page.rows)

        return collected, page_seq

    # ------------------------------------------------------------- 身份校验
    @staticmethod
    def _identity(page):
        return {
            "keyword": page.keyword,
            "category": page.category,
            "ids": tuple(r["id"] for r in page.rows),
        }

    def _verify_identity(self, baseline, page):
        current = self._identity(page)
        problems = []
        if current["keyword"] != baseline["keyword"]:
            problems.append(
                f"关键词不一致：{baseline['keyword']!r} → {current['keyword']!r}"
            )
        if current["category"] != baseline["category"]:
            problems.append(
                f"分类不一致：{baseline['category']!r} → {current['category']!r}"
            )
        if current["ids"] != baseline["ids"]:
            problems.append(
                f"首页数据行 ID 序列不一致：{baseline['ids']} → {current['ids']}"
            )
        if problems:
            raise IdentityMismatchError("；".join(problems))

    # ------------------------------------------------------------- 主流程
    def run_once(self):
        """完整跑一遍状态链（不做恢复），供恢复逻辑复用。

        首页查询成功后立即更新身份基线；这样即使过期发生在翻页中途，
        恢复流程仍持有过期前的首页身份用于比对。
        """
        entry_form = self._open_chain()
        resp, page = self._submit_query(entry_form)
        baseline = self._identity(page)
        # 身份锚点只锁定一次：首次成功查询的首页身份，恢复不覆盖
        if self._identity_anchor is None:
            self._identity_anchor = baseline
        self._baseline_before_expiry = self._identity_anchor
        rows, page_seq = self._follow_pages(resp, page)
        return {
            "rows": rows,
            "page_seq": page_seq,
            "baseline": baseline,
            "first_page": page,
        }

    def collect(self):
        """执行采集，自动处理状态过期恢复与身份校验。"""
        while True:
            try:
                outcome = self.run_once()
                if self.recoveries > 0:
                    # 恢复后必须与锁定的身份锚点比对，发现身份漂移即失败
                    self._verify_identity(
                        self._identity_anchor, outcome["first_page"]
                    )
                return {
                    "query": self.config.name,
                    "status": "ok",
                    "rows": outcome["rows"],
                    "row_count": len(outcome["rows"]),
                    "page_seq": outcome["page_seq"],
                    "recoveries": self.recoveries,
                    "chain_attempts": self.chain_attempts,
                    "identity": {
                        "keyword": outcome["baseline"]["keyword"],
                        "category": outcome["baseline"]["category"],
                        "first_page_ids": list(outcome["baseline"]["ids"]),
                    },
                }
            except (StateExpiredError, PageOrderError) as exc:
                if self.recoveries >= self.config.max_recoveries:
                    return self._failure(exc)
                self.recoveries += 1
                self.evidence.record(
                    chain_id=self.chain_id, seq=self._next_seq(),
                    request_id=f"req-{self._slug}-{self._seq}",
                    method="RECOVER", url=self.config.entry_url,
                    status=0, response_request_id="",
                    body_excerpt=f"触发恢复：{exc}",
                    note=f"recovery={self.recoveries}",
                )
                # 全新 HTTP 客户端：旧 Cookie/旧状态链整体丢弃，
                # _baseline_before_expiry 保留，供恢复后身份校验
                self.http = HttpClient(timeout=self.http.timeout)
            except IdentityMismatchError as exc:
                return self._failure(exc)

    def _failure(self, exc):
        return {
            "query": self.config.name,
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "rows": [],
            "row_count": 0,
            "page_seq": [],
            "recoveries": self.recoveries,
            "chain_attempts": self.chain_attempts,
        }
