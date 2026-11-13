"""命令行入口：python -m helpcenter_diff compare -r rules.json -o out/

子命令：
  compare   完整流程：采集两版 -> 提取文章 -> 比对 -> 输出 JSON/Markdown
  crawl     只采集单版，输出原始采集结果（调试规则用）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import ConfigError, DiffConfig
from .crawler import Crawler
from .differ import Differ
from .extractor import Extractor
from .report import write_json, write_markdown


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="helpcenter_diff",
        description="帮助中心新旧站点副本比对工具",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_compare = sub.add_parser("compare", help="完整比对流程")
    p_compare.add_argument("-r", "--rules", required=True, help="规则 JSON 文件")
    p_compare.add_argument("-o", "--out-dir", default="diff_out", help="报告输出目录")
    p_compare.add_argument("--json-name", default="report.json")
    p_compare.add_argument("--md-name", default="report.md")

    p_crawl = sub.add_parser("crawl", help="只采集一个版本（调试用）")
    p_crawl.add_argument("-r", "--rules", required=True)
    p_crawl.add_argument("-s", "--site", choices=("old", "new"), required=True)
    p_crawl.add_argument("-o", "--out", required=True, help="采集结果 JSON 输出路径")

    args = parser.parse_args(argv)
    try:
        if args.command == "compare":
            return _cmd_compare(args)
        return _cmd_crawl(args)
    except ConfigError as exc:
        print(f"规则错误：{exc}", file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"文件不存在：{exc}", file=sys.stderr)
        return 2


def _cmd_compare(args) -> int:
    config = DiffConfig.load(args.rules)
    old_crawl, old_extract = _run_site(config.old)
    new_crawl, new_extract = _run_site(config.new)

    report = Differ(old_extract, new_extract, old_crawl, new_crawl).build()
    out_dir = Path(args.out_dir)
    json_path = out_dir / args.json_name
    md_path = out_dir / args.md_name
    write_json(report, json_path)
    write_markdown(report, md_path)

    s = report.summary
    print("比对完成：")
    print(f"  对齐文章（编号×语言）：{s['articles_aligned']}")
    for cat, n in sorted(s["by_category"].items()):
        print(f"  - {cat}: {n}")
    print(f"  断链：{s['broken_links_total']} 条；失效附件：{s['dead_attachments_total']} 个")
    print(f"报告：{json_path}")
    print(f"      {md_path}")
    return 0


def _cmd_crawl(args) -> int:
    config = DiffConfig.load(args.rules)
    rule = config.old if args.site == "old" else config.new
    crawl, extract = _run_site(rule)
    payload = {
        "site": rule.name,
        "pages": [
            {
                "url": p.url,
                "rel_path": p.rel_path,
                "depth": p.depth,
                "is_textual": p.is_textual,
                "read_error": p.read_error,
                "parse_error": p.parse_error,
                "in_links": [
                    {"source": e.source_url, "text": e.link_text}
                    for e in p.in_edges
                ],
            }
            for p in crawl.pages.values()
        ],
        "articles": [
            {
                "key": list(key),
                "title": rec.title,
                "entries": [e.url for e in rec.entries],
                "attachments": [
                    {"url": a.url, "exists": a.exists} for a in rec.attachments
                ],
                "errors": rec.extraction_errors,
                "orphan": rec.orphan,
            }
            for key, rec in sorted(extract.articles.items())
        ],
        "broken_links": [vars(link) for link in crawl.broken_links],
        "orphans": extract.orphans,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"采集完成：{len(crawl.pages)} 个页面，{len(extract.articles)} 篇文章 -> {out}")
    return 0


def _run_site(rule):
    crawl = Crawler(rule).run()
    extract = Extractor(rule, crawl).run()
    return crawl, extract
