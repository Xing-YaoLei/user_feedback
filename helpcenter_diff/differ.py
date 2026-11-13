"""两版提取结果对齐与差异分类。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from urllib.parse import urlsplit

from .crawler import CrawlResult
from .extractor import ArticleRecord, Attachment, ExtractionResult


# 差异类别（报告里的固定标签）
MISSING_IN_NEW = "missing_in_new"          # 新版页面缺失
MISSING_IN_OLD = "missing_in_old"          # 新增文章
BODY_CHANGED = "body_changed"              # 正文变化
TITLE_CHANGED = "title_changed"            # 标题变化
ATTACHMENT_LOST = "attachment_lost"        # 附件丢失（失效或不再引用）
ORPHAN = "orphan"                          # 页面存在但无入口
EXTRACT_FAILED = "extract_failed"          # 正文提取失败
BROKEN_LINK = "broken_link"                # 链接断开


@dataclass
class AttachmentDiff:
    url: str
    status_old: str          # ok | missing | absent
    status_new: str          # ok | missing | absent
    referenced_by_old: list[str]
    referenced_by_new: list[str]


@dataclass
class ArticleDiff:
    article_id: str
    language: str
    categories: list[str]
    title_old: str | None
    title_new: str | None
    body_changed: bool
    title_changed: bool
    entries_old: list[dict]
    entries_new: list[dict]
    pages_old: list[str]
    pages_new: list[str]
    attachments: list[AttachmentDiff]
    errors_old: list[str]
    errors_new: list[str]
    orphan_old: bool
    orphan_new: bool


@dataclass
class BrokenLinkRow:
    site: str
    source_url: str
    target_url: str
    link_text: str
    depth: int


@dataclass
class DeadAttachmentRow:
    site: str
    url: str
    article_id: str
    language: str
    referrer_pages: list[str]


@dataclass
class SiteStats:
    article_records: int = 0
    orphan_pages: int = 0
    broken_links: int = 0
    dead_attachments: int = 0
    extract_failed: int = 0
    read_failed: int = 0
    parse_failed: int = 0
    pages_crawled: int = 0
    truncated: bool = False


@dataclass
class DiffReport:
    old_stats: SiteStats
    new_stats: SiteStats
    article_diffs: list[ArticleDiff]
    broken_links: list[BrokenLinkRow]
    dead_attachments: list[DeadAttachmentRow]
    summary: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return asdict(self)


class Differ:
    def __init__(self, old_extract: ExtractionResult, new_extract: ExtractionResult,
                 old_crawl: CrawlResult, new_crawl: CrawlResult):
        self.old = old_extract
        self.new = new_extract
        self.old_crawl = old_crawl
        self.new_crawl = new_crawl

    def build(self) -> DiffReport:
        keys = sorted(set(self.old.articles) | set(self.new.articles))
        diffs = [self._diff_one(key) for key in keys]

        broken = []
        for site, crawl in (("old", self.old_crawl), ("new", self.new_crawl)):
            for link in crawl.broken_links:
                broken.append(BrokenLinkRow(
                    site=site,
                    source_url=_display(link.source_url),
                    target_url=_display(link.target_url),
                    link_text=link.link_text,
                    depth=link.depth,
                ))

        dead = []
        for site, extract in (("old", self.old), ("new", self.new)):
            for (article_id, language), record in sorted(extract.articles.items()):
                for att in record.attachments:
                    if not att.exists:
                        dead.append(DeadAttachmentRow(
                            site=site,
                            url=_display(att.url),
                            article_id=article_id,
                            language=language,
                            referrer_pages=[_display(u) for u in att.referenced_by],
                        ))

        report = DiffReport(
            old_stats=self._stats(self.old, self.old_crawl),
            new_stats=self._stats(self.new, self.new_crawl),
            article_diffs=diffs,
            broken_links=broken,
            dead_attachments=dead,
        )
        report.summary = self._summary(report)
        return report

    # ---------- 单篇 ----------
    def _diff_one(self, key: tuple[str, str]) -> ArticleDiff:
        article_id, language = key
        old_rec = self.old.articles.get(key)
        new_rec = self.new.articles.get(key)
        categories: list[str] = []

        if old_rec is None:
            categories.append(MISSING_IN_OLD)
        if new_rec is None:
            categories.append(MISSING_IN_NEW)

        title_changed = bool(
            old_rec and new_rec
            and old_rec.title_hash is not None and new_rec.title_hash is not None
            and old_rec.title_hash != new_rec.title_hash
        )
        if title_changed:
            categories.append(TITLE_CHANGED)

        body_changed = False
        if old_rec and new_rec:
            if old_rec.body_hash is None or new_rec.body_hash is None:
                if old_rec.body_hash != new_rec.body_hash:
                    body_changed = True
            elif old_rec.body_hash != new_rec.body_hash:
                body_changed = True
        if body_changed:
            categories.append(BODY_CHANGED)

        attachment_diffs = self._diff_attachments(old_rec, new_rec)
        if any(_attachment_lost(diff) for diff in attachment_diffs):
            categories.append(ATTACHMENT_LOST)

        if (old_rec and old_rec.orphan) or (new_rec and new_rec.orphan):
            categories.append(ORPHAN)

        errors_old = old_rec.extraction_errors if old_rec else []
        errors_new = new_rec.extraction_errors if new_rec else []
        if errors_old or errors_new:
            categories.append(EXTRACT_FAILED)

        return ArticleDiff(
            article_id=article_id,
            language=language,
            categories=categories,
            title_old=old_rec.title if old_rec else None,
            title_new=new_rec.title if new_rec else None,
            body_changed=body_changed,
            title_changed=title_changed,
            entries_old=[_entry_dict(e) for e in old_rec.entries] if old_rec else [],
            entries_new=[_entry_dict(e) for e in new_rec.entries] if new_rec else [],
            pages_old=[_display(u) for u in old_rec.page_urls] if old_rec else [],
            pages_new=[_display(u) for u in new_rec.page_urls] if new_rec else [],
            attachments=[asdict(d) for d in attachment_diffs],
            errors_old=list(errors_old),
            errors_new=list(errors_new),
            orphan_old=bool(old_rec and old_rec.orphan),
            orphan_new=bool(new_rec and new_rec.orphan),
        )

    def _diff_attachments(self, old_rec: ArticleRecord | None,
                          new_rec: ArticleRecord | None) -> list[AttachmentDiff]:
        old_map = {a.url: a for a in old_rec.attachments} if old_rec else {}
        new_map = {a.url: a for a in new_rec.attachments} if new_rec else {}
        out = []
        for url in sorted(set(old_map) | set(new_map)):
            old_att = old_map.get(url)
            new_att = new_map.get(url)
            out.append(AttachmentDiff(
                url=_display(url),
                status_old=_att_status(old_att),
                status_new=_att_status(new_att),
                referenced_by_old=[_display(u) for u in old_att.referenced_by]
                if old_att else [],
                referenced_by_new=[_display(u) for u in new_att.referenced_by]
                if new_att else [],
            ))
        return out

    # ---------- 统计 ----------
    def _stats(self, extract: ExtractionResult, crawl: CrawlResult) -> SiteStats:
        failed = sum(1 for r in extract.articles.values() if r.extraction_errors)
        dead = sum(
            1 for record in extract.articles.values()
            for att in record.attachments if not att.exists
        )
        return SiteStats(
            article_records=len(extract.articles),
            orphan_pages=len(extract.orphans),
            broken_links=len(crawl.broken_links),
            dead_attachments=dead,
            extract_failed=failed,
            read_failed=len(extract.read_failed_pages),
            parse_failed=len(extract.parse_failed_pages),
            pages_crawled=len(crawl.pages),
            truncated=crawl.truncated,
        )

    def _summary(self, report: DiffReport) -> dict:
        counts: dict[str, int] = {}
        for diff in report.article_diffs:
            for cat in diff.categories:
                counts[cat] = counts.get(cat, 0) + 1
        return {
            "articles_aligned": len(report.article_diffs),
            "by_category": counts,
            "broken_links_total": len(report.broken_links),
            "dead_attachments_total": len(report.dead_attachments),
        }


def _att_status(att: Attachment | None) -> str:
    if att is None:
        return "absent"
    return "ok" if att.exists else "missing"


def _attachment_lost(diff: AttachmentDiff) -> bool:
    # 旧版可用，新版失效（missing）或不再引用（absent）
    return diff.status_old == "ok" and diff.status_new in ("missing", "absent")


def _entry_dict(entry) -> dict:
    return {
        "url": _display(entry.url),
        "depth": entry.depth,
        "source_pages": [_display(u) for u in entry.source_pages],
        "link_texts": list(entry.link_texts),
    }


def _display(url: str) -> str:
    """把内部绝对 URL 收敛成站点相对路径，报告里更短更好读。"""
    parts = urlsplit(url)
    if parts.netloc:
        return parts.path.lstrip("/")
    return url.lstrip("/")
