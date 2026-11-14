"""命令行入口：采集停水公告并输出 JSONL 与异常清单。

示例：
  python -m water_outage.cli file:///path/to/sample_site/list/page1.html
  python -m water_outage.cli http://127.0.0.1:8000/list/page1.html --region 朝阳区
"""

from __future__ import annotations

import argparse
import json
import sys

from .pipeline import collect, query_by_region


def _write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="停水公告采集与解析")
    parser.add_argument("start_url", help="起始列表页 URL（支持 http(s) 与 file://）")
    parser.add_argument("-o", "--output", default="outages.jsonl",
                        help="停水时段 JSONL 输出路径（默认 outages.jsonl）")
    parser.add_argument("-a", "--anomalies", default="anomalies.jsonl",
                        help="异常清单输出路径（默认 anomalies.jsonl）")
    parser.add_argument("--region", help="只输出区域名包含该关键字的记录")
    args = parser.parse_args(argv)

    records, anomalies, stats = collect(args.start_url)

    if args.region:
        records = query_by_region(records, args.region)

    _write_jsonl(args.output, records)
    _write_jsonl(args.anomalies, anomalies)

    print(f"访问列表页 {len(stats['list_pages_visited'])} 个:")
    for url in stats["list_pages_visited"]:
        print(f"  - {url}")
    print(f"候选详情链接 {stats['detail_links_seen']} 条，"
          f"去重后详情页 {stats['detail_urls_unique']} 个，"
          f"公告 {stats['notices']} 则")
    print(f"输出停水时段 {len(records)} 条 -> {args.output}")
    print(f"异常 {len(anomalies)} 条 -> {args.anomalies}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
