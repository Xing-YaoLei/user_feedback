"""采集编排：翻页 -> 详情去重 -> 按最高版次取详情 -> 解析与校验。"""

from __future__ import annotations

from .crawl import crawl_list_pages
from .fetch import fetch
from .notice import build_output_records, extract_notice_id, extract_version, parse_notice
from .html import parse_html


def _version_number(version):
    if version is None:
        return -1
    try:
        return int(version)
    except (TypeError, ValueError):
        return -1


def collect(start_url, fetcher=fetch):
    """执行完整采集流程。

    返回 (records, anomalies, stats)：
    - records: JSONL 风格的停水时段记录
    - anomalies: 异常清单
    - stats: 过程统计（访问列表页、候选详情、去重后公告等）
    """
    list_pages, detail_links = crawl_list_pages(start_url, fetcher=fetcher)

    # 同一详情链接在多个列表页/锚点下重复出现时，按去锚点 URL 去重
    candidate_urls = []
    seen_urls = set()
    link_attr_notice = {}
    for url, data_notice, _list_page in detail_links:
        if url not in seen_urls:
            seen_urls.add(url)
            candidate_urls.append(url)
        link_attr_notice.setdefault(url, data_notice)

    # 按公告编号聚合各版本详情，编号以详情页自身标注为准
    versions_by_notice = {}  # notice_id -> {version: url}
    url_cache = {}
    parse_cache = {}

    for url in candidate_urls:
        markup = fetcher(url)
        url_cache[url] = markup
        root = parse_html(markup)
        notice_id = extract_notice_id(root, link_attr_notice.get(url) or url)
        version = extract_version(root)
        parse_cache[url] = (notice_id, version)
        versions_by_notice.setdefault(notice_id, {})[version] = url

    records = []
    anomalies = []
    for notice_id, version_map in versions_by_notice.items():
        # 以详情页上的最高数字版次为准
        highest_version = max(version_map, key=_version_number)
        chosen_url = version_map[highest_version]
        page_records, page_anomalies = parse_notice(
            url_cache[chosen_url],
            chosen_url,
            fallback_notice_id=notice_id,
            fallback_version=highest_version,
        )
        if page_anomalies:
            anomalies.extend(page_anomalies)
        if not page_records:
            continue  # 异常公告跳过全部时段
        records.extend(build_output_records(
            page_records, notice_id,
            _version_number(highest_version) if highest_version is not None else None,
            chosen_url,
        ))

    records.sort(key=lambda item: (item["region"], item["start_time"], item["notice_id"]))
    stats = {
        "list_pages_visited": list_pages,
        "detail_links_seen": len(detail_links),
        "detail_urls_unique": len(candidate_urls),
        "notices": len(versions_by_notice),
        "records": len(records),
        "anomalies": len(anomalies),
    }
    return records, anomalies, stats


def query_by_region(records, region):
    """按区域关键字查询停水时段。"""
    keyword = region.strip()
    return [row for row in records if keyword and keyword in row["region"]]
