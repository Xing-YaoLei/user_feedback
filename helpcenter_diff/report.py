"""报告输出：机器可读 JSON + 人工可读 Markdown。"""

from __future__ import annotations

import json
from pathlib import Path

from .differ import (
    ATTACHMENT_LOST,
    BODY_CHANGED,
    BROKEN_LINK,
    EXTRACT_FAILED,
    MISSING_IN_NEW,
    MISSING_IN_OLD,
    ORPHAN,
    TITLE_CHANGED,
    DiffReport,
)

CATEGORY_LABELS = {
    MISSING_IN_NEW: "新版页面缺失",
    MISSING_IN_OLD: "新版新增文章",
    BODY_CHANGED: "正文变化",
    TITLE_CHANGED: "标题变化",
    ATTACHMENT_LOST: "附件丢失",
    ORPHAN: "存在但无入口",
    EXTRACT_FAILED: "正文提取失败",
    BROKEN_LINK: "链接断开",
}

# Markdown 各章节的排列顺序
_CATEGORY_ORDER = (
    MISSING_IN_NEW,
    MISSING_IN_OLD,
    BODY_CHANGED,
    TITLE_CHANGED,
    ATTACHMENT_LOST,
    ORPHAN,
    EXTRACT_FAILED,
)


def write_json(report: DiffReport, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(report.to_json(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_markdown(report: DiffReport, path: Path) -> None:
    lines: list[str] = []
    lines.append("# 帮助中心新旧版本比对报告")
    lines.append("")
    _append_summary(lines, report)
    _append_category_sections(lines, report)
    _append_broken_links(lines, report)
    _append_dead_attachments(lines, report)
    _append_failures(lines, report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------- 各章节 ----------------
def _append_summary(lines: list[str], report: DiffReport) -> None:
    lines.append("## 总览")
    lines.append("")
    lines.append("| 指标 | 旧版 | 新版 |")
    lines.append("|---|---:|---:|")
    pairs = [
        ("采集页面数", "pages_crawled"),
        ("文章记录数（编号×语言）", "article_records"),
        ("无入口文章页", "orphan_pages"),
        ("断开的链接", "broken_links"),
        ("失效附件", "dead_attachments"),
        ("提取失败文章", "extract_failed"),
        ("页面读取失败", "read_failed"),
        ("页面解析失败", "parse_failed"),
    ]
    for label, attr in pairs:
        lines.append(
            f"| {label} | {getattr(report.old_stats, attr)} "
            f"| {getattr(report.new_stats, attr)} |"
        )
    lines.append("")
    counts = report.summary.get("by_category", {})
    if counts:
        lines.append("差异分类计数：")
        lines.append("")
        for cat in _CATEGORY_ORDER:
            if cat in counts:
                lines.append(f"- {CATEGORY_LABELS[cat]}（{cat}）：{counts[cat]}")
        for cat, n in sorted(counts.items()):
            if cat not in _CATEGORY_ORDER:
                lines.append(f"- {cat}：{n}")
        lines.append("")
    for stats, label in ((report.old_stats, "旧版"), (report.new_stats, "新版")):
        if stats.truncated:
            lines.append(f"> ⚠️ {label}采集触发 max_pages 上限，结果不完整。")
            lines.append("")


def _append_category_sections(lines: list[str], report: DiffReport) -> None:
    grouped: dict[str, list] = {}
    for diff in report.article_diffs:
        for cat in diff.categories:
            grouped.setdefault(cat, []).append(diff)

    for cat in _CATEGORY_ORDER:
        rows = grouped.get(cat)
        if not rows:
            continue
        lines.append(f"## {CATEGORY_LABELS[cat]}（{cat}）— {len(rows)} 篇")
        lines.append("")
        for diff in sorted(rows, key=lambda d: (d.article_id, d.language)):
            lines.append(f"### 文章 {diff.article_id} · 语言 {diff.language}")
            lines.append("")
            lines.append(f"- 分类标签：{', '.join(CATEGORY_LABELS.get(c, c) for c in diff.categories)}")
            _append_titles(lines, diff, cat)
            _append_entries(lines, diff)
            _append_attachments(lines, diff, cat)
            _append_errors(lines, diff)
            lines.append("")


def _append_titles(lines: list[str], diff, cat: str) -> None:
    if cat not in (TITLE_CHANGED, MISSING_IN_NEW, MISSING_IN_OLD):
        return
    lines.append(f"- 标题（旧）：{diff.title_old or '—'}")
    lines.append(f"- 标题（新）：{diff.title_new or '—'}")


def _append_entries(lines: list[str], diff) -> None:
    for side, entries in (("旧", diff.entries_old), ("新", diff.entries_new)):
        if not entries:
            lines.append(f"- 入口（{side}）：无")
            continue
        rendered = []
        for entry in entries:
            if entry["depth"] == -1:
                rendered.append(f"`{entry['url']}`（无入链，全站扫描发现）")
                continue
            sources = "、".join(entry["source_pages"]) if entry["source_pages"] else "（种子页）"
            texts = f"，链接文本：{'/'.join(entry['link_texts'])}" if entry["link_texts"] else ""
            rendered.append(f"`{entry['url']}`（来源页：{sources}{texts}）")
        lines.append(f"- 入口（{side}，共 {len(entries)} 个）：" + "；".join(rendered))


def _append_attachments(lines: list[str], diff, cat: str) -> None:
    if cat != ATTACHMENT_LOST:
        return
    lost = [a for a in diff.attachments
            if a["status_old"] == "ok" and a["status_new"] in ("missing", "absent")]
    if not lost:
        return
    lines.append("- 丢失/失效附件：")
    for att in lost:
        reason = "文件失效" if att["status_new"] == "missing" else "新版不再引用"
        refs = "、".join(att["referenced_by_old"]) or "—"
        lines.append(f"  - `{att['url']}`（{reason}；旧版引用页：{refs}）")


def _append_errors(lines: list[str], diff) -> None:
    for side, errors in (("旧", diff.errors_old), ("新", diff.errors_new)):
        for msg in errors:
            lines.append(f"- ⚠️ {side}版提取失败：{msg}")


def _append_broken_links(lines: list[str], report: DiffReport) -> None:
    if not report.broken_links:
        return
    lines.append(f"## 链接断开（{len(report.broken_links)} 条）")
    lines.append("")
    lines.append("| 版本 | 来源页面 | 断开的目标 | 链接文本 |")
    lines.append("|---|---|---|---|")
    for row in report.broken_links:
        lines.append(
            f"| {row.site} | `{row.source_url}` | `{row.target_url}` "
            f"| {_md_escape(row.link_text) or '—'} |"
        )
    lines.append("")


def _append_dead_attachments(lines: list[str], report: DiffReport) -> None:
    if not report.dead_attachments:
        return
    lines.append(f"## 失效附件及引用文章（{len(report.dead_attachments)} 个）")
    lines.append("")
    lines.append("| 版本 | 附件地址 | 引用文章 | 语言 | 引用页面 |")
    lines.append("|---|---|---|---|---|")
    for row in report.dead_attachments:
        refs = "、".join(f"`{u}`" for u in row.referrer_pages) or "—"
        lines.append(
            f"| {row.site} | `{row.url}` | {row.article_id} | {row.language} | {refs} |"
        )
    lines.append("")


def _append_failures(lines: list[str], report: DiffReport) -> None:
    blocks = []
    for stats, label in ((report.old_stats, "旧版"), (report.new_stats, "新版")):
        if stats.read_failed or stats.parse_failed:
            blocks.append(
                f"- {label}：读取失败 {stats.read_failed} 页，解析失败 {stats.parse_failed} 页"
            )
    if blocks:
        lines.append("## 采集异常页面")
        lines.append("")
        lines.extend(blocks)
        lines.append("")
        lines.append("> 具体页面见 JSON 报告中的 read_failed_pages / parse_failed_pages。")
        lines.append("")


def _md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")
