"""列表页遍历：沿 rel="next" 翻页，收集带 data-notice 的详情链接。"""

from __future__ import annotations

from .fetch import fetch, normalize_url
from .html import parse_html


def _is_next(link):
    rel = (link.get("rel") or "").lower()
    return any(token == "next" for token in rel.split())


def _base_url(root, page_url):
    base = root.find("base")
    if base is not None and base.get("href"):
        return normalize_url(base.get("href"), page_url)
    return page_url


def crawl_list_pages(start_url, fetcher=fetch):
    """从列表页开始线性翻页。

    返回 (页面序列, 详情链接列表)。详情链接元素为 (绝对URL, data-notice 值)。
    遇到 rel="next" 指向已访问页面（含去掉锚点后相同）时立即结束遍历。
    """
    visited = []
    visited_set = set()
    details = []
    current = normalize_url(start_url)

    while current not in visited_set:
        visited_set.add(current)
        visited.append(current)

        root = parse_html(fetcher(current))
        base = _base_url(root, current)

        for link in root.find_all("a"):
            href = link.get("href")
            if href is None:
                continue
            absolute = normalize_url(href, base)
            if link.has_attr("data-notice"):
                details.append((absolute, link.get("data-notice"), current))

        next_link = next((node for node in root.find_all("a") if _is_next(node)), None)
        if next_link is None or not next_link.get("href"):
            break
        next_url = normalize_url(next_link.get("href"), base)
        if next_url in visited_set:
            # 回指已访问页面：结束遍历，不再抓取下一页
            break
        current = next_url

    return visited, details
