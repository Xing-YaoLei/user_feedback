"""页面抓取与 URL 处理，支持 http(s) 与本地 file 地址。"""

from __future__ import annotations

import re
from urllib.parse import unquote, urldefrag, urljoin
from urllib.request import Request, urlopen

_CHARSET = re.compile(r'charset=["\']?([\w\-]+)', re.IGNORECASE)
DEFAULT_ENCODING = "utf-8"


def normalize_url(url, base=None):
    """处理相对地址与页内锚点：返回去掉 #fragment 后的绝对 URL。"""
    absolute = urljoin(base, url) if base else url
    clean, _ = urldefrag(absolute)
    return clean

def fetch(url, timeout=20):
    """抓取页面文本。file:// 走本地文件，http(s) 走 urllib。"""
    if url.startswith("file://"):
        path = unquote(url[7:])
        with open(path, "rb") as handle:
            raw = handle.read()
        content_type = ""
    else:
        request = Request(url, headers={"User-Agent": "water-outage-collector/1.0"})
        with urlopen(request, timeout=timeout) as response:  # noqa: S310
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")

    encoding = DEFAULT_ENCODING
    match = _CHARSET.search(content_type)
    if match:
        encoding = match.group(1)
    else:
        head = raw[:2048].decode("ascii", errors="ignore")
        match = _CHARSET.search(head)
        if match:
            encoding = match.group(1)
    try:
        return raw.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        return raw.decode(DEFAULT_ENCODING, errors="replace")
