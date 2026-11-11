"""编码证据采集：响应头、BOM、HTML meta 声明。

只读取原始字节做声明解析，绝不修改数据。
"""
from __future__ import annotations

import codecs
import re

# (BOM 字节, 声明的编码名)；注意顺序：先长后短
_BOMS = [
    (codecs.BOM_UTF8, 'utf-8'),
    (b'\xff\xfe\x00\x00', 'utf-32-le'),
    (b'\x00\x00\xfe\xff', 'utf-32-be'),
    (codecs.BOM_UTF16_LE, 'utf-16-le'),
    (codecs.BOM_UTF16_BE, 'utf-16-be'),
]

_ALIASES = {
    'utf8': 'utf-8', 'utf-8': 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
    'gb2312': 'gb18030', 'gb-2312': 'gb18030', 'gbk': 'gb18030',
    'gb18030': 'gb18030', 'gb2312-80': 'gb18030', 'chinese': 'gb18030',
    'big5': 'big5', 'big-5': 'big5', 'big5-hkscs': 'big5',
    'latin-1': 'latin-1', 'latin1': 'latin-1', 'iso-8859-1': 'latin-1',
    'iso-ir-100': 'latin-1', 'ascii': 'ascii', 'us-ascii': 'ascii',
}

_META_CHARSET_RE = re.compile(
    r'<meta[^>]+charset\s*=\s*["\']?\s*([a-zA-Z0-9_\-]+)', re.I)
_HTTP_EQUIV_RE = re.compile(
    r'<meta[^>]+content\s*=\s*["\'][^"\']*?charset\s*=\s*([a-zA-Z0-9_\-]+)', re.I)
_HEADER_CHARSET_RE = re.compile(r'charset\s*=\s*"?([a-zA-Z0-9_\-]+)"?', re.I)


def normalize_encoding(name: str | None) -> str | None:
    """归一化编码名。gb2312/gbk 归到 gb18030（其超集），便于冲突判断与解码。"""
    if not name:
        return None
    n = name.strip().lower().replace('_', '-')
    return _ALIASES.get(n, n)


def sniff_bom(data: bytes) -> str | None:
    for bom, name in _BOMS:
        if data.startswith(bom):
            return name
    return None


def sniff_meta_charset(data: bytes, limit: int = 4096) -> str | None:
    """从原始字节头部解析 <meta> 声明。用 latin-1 做无损字节→字符映射以便正则。"""
    head = data[:limit].decode('latin-1')
    m = _META_CHARSET_RE.search(head) or _HTTP_EQUIV_RE.search(head)
    return m.group(1) if m else None


def parse_header_charset(headers: dict) -> str | None:
    content_type = None
    for k, v in headers.items():
        if k.lower() == 'content-type':
            content_type = v
            break
    if not content_type:
        return None
    m = _HEADER_CHARSET_RE.search(content_type)
    return m.group(1) if m else None


def collect_evidence(headers: dict, data: bytes) -> dict:
    """汇总三类证据来源，并检测声明冲突。"""
    declarations = []
    header_charset = parse_header_charset(headers)
    if header_charset:
        declarations.append({'source': 'http-header', 'encoding': header_charset})
    bom = sniff_bom(data)
    if bom:
        declarations.append({'source': 'bom', 'encoding': bom})
    meta = sniff_meta_charset(data)
    if meta:
        declarations.append({'source': 'html-meta', 'encoding': meta})

    normalized = sorted({normalize_encoding(d['encoding']) for d in declarations})
    return {
        'declarations': declarations,
        'normalized': normalized,
        'conflict': len(normalized) > 1,
        'content_type_header': next(
            (v for k, v in headers.items() if k.lower() == 'content-type'), None),
    }
