# -*- coding: utf-8 -*-
"""敏感状态遮盖。

隐藏状态字段（viewstate/nonce）、会话 Cookie 等在写入任何证据/日志前统一遮盖，
同一值在同一次运行里遮盖结果保持稳定（短哈希后缀），便于关联又不泄露原文。
"""

import hashlib
import re

# 命中即视为敏感的字段名（小写包含匹配）
SENSITIVE_NAME_HINTS = (
    "viewstate",
    "nonce",
    "cookie",
    "token",
    "auth",
    "session",
    "secret",
    "password",
)

# 长十六进制/长令牌形态的字符串（如 viewstate: 32 位 hex、nonce: 16 位 hex）
_LONG_TOKEN_RE = re.compile(r"(?<![0-9a-fA-F])[0-9a-fA-F]{16,}(?![0-9a-fA-F])")
# Cookie 头：key=value; ...
_COOKIE_RE = re.compile(r"([^=;\s]+=)[^;]+")

_MASK_PREFIX = "***REDACTED"


class Redactor:
    def __init__(self):
        self._digest_cache = {}

    def _digest(self, value: str) -> str:
        cached = self._digest_cache.get(value)
        if cached is None:
            cached = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
            self._digest_cache[value] = cached
        return cached

    def mask_value(self, value: str) -> str:
        value = str(value)
        return f"{_MASK_PREFIX}-{self._digest(value)}***"

    def is_sensitive_name(self, name: str) -> bool:
        low = (name or "").lower()
        return any(hint in low for hint in SENSITIVE_NAME_HINTS)

    def redact_mapping(self, mapping: dict) -> dict:
        """遮盖字典中的敏感项，非敏感项原样保留。"""
        out = {}
        for key, val in mapping.items():
            if self.is_sensitive_name(key):
                out[key] = self.mask_value(str(val))
            else:
                out[key] = val
        return out

    def redact_text(self, text: str) -> str:
        """遮盖任意文本中的长令牌与 Cookie 值。"""
        if not text:
            return text

        def _sub(match):
            return self.mask_value(match.group(0))

        text = _COOKIE_RE.sub(
            lambda m: m.group(1) + self.mask_value(m.group(0).split("=", 1)[1]),
            text,
        )
        text = _LONG_TOKEN_RE.sub(_sub, text)
        return text
