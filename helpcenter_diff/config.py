"""采集与提取规则：加载、校验、默认值。

规则文件为 JSON，顶层结构：
{
  "old": { ...站点规则... },
  "new": { ...站点规则... }
}
站点规则字段见 docs/rules-template.json 的注释版模板。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_INDEX = ("index.html",)
DEFAULT_ATTACHMENT_EXCLUDES = (r"^#", r"^mailto:", r"^tel:", r"^javascript:")
_CONTENT_EXT = re.compile(r"\.(html?|htm|shtml|xhtml|php|asp|aspx|jsp)$", re.IGNORECASE)


class ConfigError(ValueError):
    pass


@dataclass
class LanguageRule:
    from_mode: str = "url"                 # url | element | fixed
    pattern: str | None = None
    group: int = 1
    selector: str | None = None
    attr: str | None = "lang"
    fixed: str | None = None
    default: str | None = None             # 解析失败时的兜底语言
    _regex: re.Pattern | None = field(default=None, repr=False)

    def resolve(self, url: str, page_root) -> str | None:
        if self.from_mode == "fixed":
            return self.fixed
        if self.from_mode == "url":
            if self._regex is None:
                return self.default
            m = self._regex.search(url)
            if not m:
                return self.default
            try:
                return m.group(self.group)
            except IndexError:
                return self.default
        if self.from_mode == "element":
            from .selector import select_first
            node = select_first(page_root, self.selector or "html")
            if node is None:
                return self.default
            if self.attr:
                return node.get(self.attr) or self.default
            value = node.text_content().strip()
            return value or self.default
        return self.default


@dataclass
class AttachmentRule:
    container_selector: str | None = None   # 默认取正文容器
    link_selector: str = "a[href]"
    href_attr: str = "href"
    include_patterns: tuple[str, ...] = ()
    exclude_patterns: tuple[str, ...] = DEFAULT_ATTACHMENT_EXCLUDES
    _includes: tuple[re.Pattern, ...] = field(default=(), repr=False)
    _excludes: tuple[re.Pattern, ...] = field(default=(), repr=False)

    def is_attachment(self, url: str) -> bool:
        for rx in self._excludes:
            if rx.search(url):
                return False
        if self._includes:
            return any(rx.search(url) for rx in self._includes)
        # 默认：非页面类资源都算附件
        return not _CONTENT_EXT.search(url)


@dataclass
class ArticleRule:
    # 文章识别：url 模式（推荐）或页面元素
    url_pattern: str | None = None
    url_group: int = 1
    id_selector: str | None = None          # 配置后改用元素模式识别文章
    id_attr: str = "content"
    # 字段提取
    language: LanguageRule = field(default_factory=LanguageRule)
    title_selector: str | None = None
    title_attr: str | None = None           # None 表示取文本
    body_selector: str | None = None
    body_mode: str = "text"                 # text | html
    attachments: AttachmentRule = field(default_factory=AttachmentRule)

    _url_regex: re.Pattern | None = field(default=None, repr=False)


@dataclass
class CrawlRule:
    index_pages: tuple[str, ...] = DEFAULT_INDEX
    base_url: str | None = None             # 如 https://help.example.com/
    stay_inside_root: bool = True
    include_patterns: tuple[str, ...] = ()  # 只采集匹配的路径
    exclude_patterns: tuple[str, ...] = ()
    max_pages: int = 0                      # 0 不限
    _includes: tuple[re.Pattern, ...] = field(default=(), repr=False)
    _excludes: tuple[re.Pattern, ...] = field(default=(), repr=False)


@dataclass
class SiteRule:
    name: str
    root: Path
    crawl: CrawlRule
    article: ArticleRule

    @classmethod
    def load(cls, name: str, raw: dict, config_path: Path) -> "SiteRule":
        if not isinstance(raw, dict):
            raise ConfigError(f"{name}: 站点规则必须是对象")
        root_raw = raw.get("root")
        if not root_raw or not isinstance(root_raw, str):
            raise ConfigError(f"{name}.root: 必须填写站点副本目录")
        root = Path(root_raw)
        if not root.is_absolute():
            root = (config_path.parent / root).resolve()
        if not root.is_dir():
            raise ConfigError(f"{name}.root: 目录不存在: {root}")

        crawl_raw = raw.get("crawl", {}) or {}
        crawl = CrawlRule(
            index_pages=tuple(crawl_raw.get("index_pages", DEFAULT_INDEX)),
            base_url=crawl_raw.get("base_url"),
            stay_inside_root=bool(crawl_raw.get("stay_inside_root", True)),
            include_patterns=tuple(crawl_raw.get("include_patterns", ())),
            exclude_patterns=tuple(crawl_raw.get("exclude_patterns", ())),
            max_pages=int(crawl_raw.get("max_pages", 0)),
        )
        crawl._includes = _compile(crawl.include_patterns, f"{name}.crawl.include_patterns")
        crawl._excludes = _compile(crawl.exclude_patterns, f"{name}.crawl.exclude_patterns")
        if crawl.base_url:
            try:
                crawl.base_url = crawl.base_url.rstrip("/") + "/"
            except AttributeError:
                raise ConfigError(f"{name}.crawl.base_url 必须是字符串")

        art_raw = raw.get("article", {}) or {}
        lang_raw = art_raw.get("language", {}) or {}
        language = LanguageRule(
            from_mode=lang_raw.get("from", "url"),
            pattern=lang_raw.get("pattern"),
            group=int(lang_raw.get("group", 1)),
            selector=lang_raw.get("selector"),
            attr=lang_raw.get("attr", "lang"),
            fixed=lang_raw.get("fixed"),
            default=lang_raw.get("default"),
        )
        if language.from_mode not in ("url", "element", "fixed"):
            raise ConfigError(f"{name}.article.language.from 只能是 url/element/fixed")
        if language.from_mode == "url":
            if not language.pattern:
                raise ConfigError(f"{name}.article.language: from=url 时必须给 pattern")
            language._regex = _compile_one(language.pattern, f"{name}.article.language.pattern")
        elif language.from_mode == "element" and not language.selector:
            raise ConfigError(f"{name}.article.language: from=element 时必须给 selector")
        elif language.from_mode == "fixed" and not language.fixed:
            raise ConfigError(f"{name}.article.language: from=fixed 时必须给 fixed")

        att_raw = art_raw.get("attachments", {}) or {}
        attachment = AttachmentRule(
            container_selector=att_raw.get("container_selector"),
            link_selector=att_raw.get("link_selector", "a[href]"),
            href_attr=att_raw.get("href_attr", "href"),
            include_patterns=tuple(att_raw.get("include_patterns", ())),
            exclude_patterns=tuple(att_raw.get("exclude_patterns", DEFAULT_ATTACHMENT_EXCLUDES)),
        )
        attachment._includes = _compile(
            attachment.include_patterns, f"{name}.article.attachments.include_patterns"
        )
        attachment._excludes = _compile(
            attachment.exclude_patterns, f"{name}.article.attachments.exclude_patterns"
        )

        article = ArticleRule(
            url_pattern=art_raw.get("url_pattern"),
            url_group=int(art_raw.get("url_group", 1)),
            id_selector=art_raw.get("id_selector"),
            id_attr=art_raw.get("id_attr", "content"),
            language=language,
            title_selector=art_raw.get("title_selector"),
            title_attr=art_raw.get("title_attr"),
            body_selector=art_raw.get("body_selector"),
            body_mode=art_raw.get("body_mode", "text"),
            attachments=attachment,
        )
        if article.body_mode not in ("text", "html"):
            raise ConfigError(f"{name}.article.body_mode 只能是 text/html")
        if not article.url_pattern and not article.id_selector:
            raise ConfigError(
                f"{name}.article: 必须提供 url_pattern 或 id_selector 之一用于识别文章"
            )
        if article.url_pattern:
            article._url_regex = _compile_one(
                article.url_pattern, f"{name}.article.url_pattern"
            )
        if not article.body_selector:
            raise ConfigError(f"{name}.article.body_selector 不能为空")

        return cls(name=name, root=root, crawl=crawl, article=article)


def _compile(patterns: tuple[str, ...], where: str) -> tuple[re.Pattern, ...]:
    return tuple(_compile_one(p, where) for p in patterns)


def _compile_one(pattern: str, where: str) -> re.Pattern:
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise ConfigError(f"{where}: 正则非法: {exc}") from exc


@dataclass
class DiffConfig:
    old: SiteRule
    new: SiteRule

    @classmethod
    def load(cls, path: str | Path) -> "DiffConfig":
        config_path = Path(path).resolve()
        try:
            raw = json.loads(config_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ConfigError(f"规则文件不存在: {config_path}")
        except json.JSONDecodeError as exc:
            raise ConfigError(f"规则文件不是合法 JSON: {exc}") from exc
        if not isinstance(raw, dict) or "old" not in raw or "new" not in raw:
            raise ConfigError("规则文件顶层必须包含 old 和 new 两个站点规则")
        return cls(
            old=SiteRule.load("old", raw["old"], config_path),
            new=SiteRule.load("new", raw["new"], config_path),
        )
