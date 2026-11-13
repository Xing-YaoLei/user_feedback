"""站点副本的本地读取：URL 与文件路径互转、编码处理、链接解析。"""

from __future__ import annotations

import codecs
import re
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlsplit, unquote

from .config import SiteRule

_INDEX_FILES = ("index.html", "index.htm")
_CHARSET_RE = re.compile(
    rb"""<meta[^>]+charset\s*=\s*["']?\s*([\w\-]+)""", re.IGNORECASE
)
_XML_ENC_RE = re.compile(rb"""<\?xml[^>]+encoding\s*=\s*["']([\w\-]+)""", re.IGNORECASE)
_TEXTUAL_EXT = re.compile(
    r"\.(html?|htm|shtml|xhtml|xml|txt|css|js|json|md)$", re.IGNORECASE
)


class SiteIO:
    """把一个本地站点副本当作“站点”来访问。"""

    def __init__(self, rule: SiteRule):
        self.rule = rule
        self.root = rule.root.resolve()
        self.base_url = rule.crawl.base_url or "http://site.local/"

    # ---------- URL 与路径互转 ----------
    def to_url(self, path: Path) -> str:
        """本地文件路径 -> 站点内 URL（绝对形式，基于 base_url）。"""
        resolved = path.resolve()
        try:
            rel = resolved.relative_to(self.root)
        except ValueError:
            return resolved.as_uri()
        return self.base_url + rel.as_posix()

    def to_path(self, url: str) -> Path | None:
        """站点 URL -> 本地文件路径；站点外的绝对 URL 返回 None。"""
        clean, _frag = urldefrag(url)
        parts = urlsplit(clean)
        if parts.scheme or parts.netloc:
            base_parts = urlsplit(self.base_url)
            if parts.netloc and parts.netloc != base_parts.netloc:
                return None
            if parts.scheme and parts.scheme not in ("http", "https", "file"):
                return None
            rel_path = parts.path.lstrip("/")
        else:
            rel_path = clean.lstrip("/")
        rel_path = unquote(rel_path)
        if not rel_path:
            return self._directory_index(self.root)
        candidate = (self.root / rel_path).resolve()
        # 防目录穿越
        if not self._within_root(candidate):
            return None
        if candidate.is_dir():
            return self._directory_index(candidate)
        return candidate

    def _within_root(self, path: Path) -> bool:
        try:
            path.resolve().relative_to(self.root)
            return True
        except ValueError:
            return False

    @staticmethod
    def _directory_index(directory: Path) -> Path:
        for name in _INDEX_FILES:
            candidate = directory / name
            if candidate.is_file():
                return candidate
        return directory / _INDEX_FILES[0]  # 不存在也返回，由 exists 检查暴露

    def resolve_link(self, base_url: str, href: str) -> str | None:
        """解析页面内相对链接为绝对 URL；纯锚点/非 http 协议返回 None。"""
        href = (href or "").strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            return None
        joined = urljoin(base_url, href)
        clean, _frag = urldefrag(joined)
        parts = urlsplit(clean)
        if parts.scheme and parts.scheme not in ("http", "https", "file"):
            return None
        return clean

    def is_internal(self, url: str) -> bool:
        parts = urlsplit(url)
        if not parts.netloc:
            return True
        return parts.netloc == urlsplit(self.base_url).netloc

    # ---------- 文件读取 ----------
    def exists(self, url: str) -> bool:
        path = self.to_path(url)
        return path is not None and path.is_file()

    def read_text(self, url: str) -> tuple[str, Path]:
        """读取页面文本，自动探测编码；返回 (文本, 实际文件路径)。"""
        path = self.to_path(url)
        if path is None or not path.is_file():
            raise FileNotFoundError(url)
        raw = path.read_bytes()
        encoding = self._detect_encoding(raw, path)
        return raw.decode(encoding, errors="replace"), path

    @staticmethod
    def _detect_encoding(raw: bytes, path: Path) -> str:
        bom_enc = {
            codecs.BOM_UTF8: "utf-8",
            codecs.BOM_UTF16_LE: "utf-16-le",
            codecs.BOM_UTF16_BE: "utf-16-be",
        }
        for bom, enc in bom_enc.items():
            if raw.startswith(bom):
                return enc
        head = raw[:4096]
        m = _CHARSET_RE.search(head) or _XML_ENC_RE.search(head)
        if m:
            candidate = m.group(1).decode("ascii", "replace").lower()
            try:
                codecs.lookup(candidate)
                return candidate
            except LookupError:
                pass
        return "utf-8"

    def is_textual(self, url: str) -> bool:
        path_part = urlsplit(url).path
        return bool(_TEXTUAL_EXT.search(path_part))
