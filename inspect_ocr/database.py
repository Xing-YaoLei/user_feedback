"""SQLite 持久层：页面、字段结果、人工修订历史、来源坐标。"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from . import config
from .models import FieldResult, PageResult, Revision, STATUS_CONFIRMED

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (
    page_id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    template_id TEXT,
    template_name TEXT,
    rotate_angle REAL DEFAULT 0,
    homography TEXT,
    page_corners TEXT,
    created_at REAL,
    reprocessed_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS fields (
    page_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    label TEXT,
    ftype TEXT,
    value TEXT,
    raw_text TEXT,
    confidence REAL,
    status TEXT,
    review_reasons TEXT,
    region_norm TEXT,
    source_polygon TEXT,
    unit TEXT,
    detected_unit TEXT,
    manual INTEGER DEFAULT 0,
    updated_at REAL,
    PRIMARY KEY (page_id, field_key),
    FOREIGN KEY (page_id) REFERENCES pages(page_id)
);
CREATE TABLE IF NOT EXISTS revisions (
    rev_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    old_status TEXT,
    new_status TEXT,
    editor TEXT,
    note TEXT,
    ts REAL
);
"""


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    path = Path(db_path or config.DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Optional[Path] = None) -> None:
    with connect(db_path) as conn:
        conn.executescript(_SCHEMA)


# ---------------------------------------------------------------------------
# 写入 / 读取
# ---------------------------------------------------------------------------

def _dumps(v: Any) -> Optional[str]:
    return None if v is None else json.dumps(v, ensure_ascii=False)


def save_page(page: PageResult, db_path: Optional[Path] = None) -> None:
    init_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?,?,?,?,?)",
            (page.page_id, page.source_path, page.template_id,
             page.template_name, page.rotate_angle,
             _dumps(page.homography), _dumps(page.page_corners),
             page.created_at, page.reprocessed_count),
        )
        conn.execute("DELETE FROM fields WHERE page_id=?", (page.page_id,))
        for key, f in page.fields.items():
            conn.execute(
                "INSERT OR REPLACE INTO fields VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (page.page_id, key, f.label, f.ftype, _dumps(f.value),
                 f.raw_text, f.confidence, f.status, _dumps(f.review_reasons),
                 _dumps(f.region_norm), _dumps(f.source_polygon),
                 f.unit, f.detected_unit, int(f.manual), f.updated_at),
            )


def _row_to_field(row: sqlite3.Row) -> FieldResult:
    return FieldResult(
        key=row["field_key"], label=row["label"], ftype=row["ftype"],
        value=json.loads(row["value"]) if row["value"] is not None else None,
        raw_text=row["raw_text"] or "",
        confidence=row["confidence"],
        status=row["status"],
        review_reasons=json.loads(row["review_reasons"] or "[]"),
        region_norm=tuple(json.loads(row["region_norm"] or "[]")),
        source_polygon=json.loads(row["source_polygon"] or "[]"),
        unit=row["unit"], detected_unit=row["detected_unit"],
        manual=bool(row["manual"]), updated_at=row["updated_at"],
    )


def load_page(page_id: str, db_path: Optional[Path] = None) -> Optional[PageResult]:
    init_db(db_path)
    with connect(db_path) as conn:
        prow = conn.execute(
            "SELECT * FROM pages WHERE page_id=?", (page_id,)).fetchone()
        if prow is None:
            return None
        fields = {}
        for frow in conn.execute(
                "SELECT * FROM fields WHERE page_id=? ORDER BY field_key",
                (page_id,)):
            fr = _row_to_field(frow)
            fields[fr.key] = fr
        return PageResult(
            page_id=prow["page_id"], source_path=prow["source_path"],
            template_id=prow["template_id"], template_name=prow["template_name"],
            rotate_angle=prow["rotate_angle"] or 0.0,
            homography=json.loads(prow["homography"]) if prow["homography"] else None,
            page_corners=json.loads(prow["page_corners"] or "[]"),
            fields=fields, created_at=prow["created_at"],
            reprocessed_count=prow["reprocessed_count"] or 0,
        )


def list_pages(db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    init_db(db_path)
    out = []
    with connect(db_path) as conn:
        for row in conn.execute("SELECT * FROM pages ORDER BY created_at DESC"):
            n_total = conn.execute(
                "SELECT COUNT(*) c FROM fields WHERE page_id=?",
                (row["page_id"],)).fetchone()["c"]
            n_review = conn.execute(
                "SELECT COUNT(*) c FROM fields WHERE page_id=? AND status=?",
                (row["page_id"], "needs_review")).fetchone()["c"]
            n_manual = conn.execute(
                "SELECT COUNT(*) c FROM fields WHERE page_id=? AND manual=1",
                (row["page_id"],)).fetchone()["c"]
            out.append({
                "page_id": row["page_id"],
                "source_path": row["source_path"],
                "template_id": row["template_id"],
                "template_name": row["template_name"],
                "n_fields": n_total,
                "n_needs_review": n_review,
                "n_manual": n_manual,
                "reprocessed_count": row["reprocessed_count"],
                "created_at": row["created_at"],
            })
    return out


# ---------------------------------------------------------------------------
# 人工修订
# ---------------------------------------------------------------------------

def update_field(page_id: str, field_key: str, new_value: Any,
                 *, editor: str = "operator", note: str = "",
                 source_polygon: Optional[list] = None,
                 db_path: Optional[Path] = None) -> Optional[Revision]:
    """人工修改字段：记录历史、置 manual/confirmed，可同时保存来源坐标。"""
    page = load_page(page_id, db_path)
    if page is None or field_key not in page.fields:
        return None
    f = page.fields[field_key]
    old_value, old_status = f.value, f.status
    rev = Revision.create(
        page_id=page_id, field_key=field_key,
        old_value=old_value, new_value=new_value,
        old_status=old_status, new_status=STATUS_CONFIRMED,
        editor=editor, note=note or "人工核对修改",
    )
    f.value = new_value
    f.status = STATUS_CONFIRMED
    f.manual = True
    f.updated_at = time.time()
    f.review_reasons = [r for r in f.review_reasons if r != "blank_field"]
    if source_polygon is not None:
        f.source_polygon = source_polygon
    save_page(page, db_path)
    add_revision(rev, db_path)
    return rev


def confirm_field(page_id: str, field_key: str, *, editor: str = "operator",
                  note: str = "人工确认",
                  db_path: Optional[Path] = None) -> Optional[Revision]:
    """人工确认当前值（值不变，状态转 confirmed）。"""
    page = load_page(page_id, db_path)
    if page is None or field_key not in page.fields:
        return None
    f = page.fields[field_key]
    rev = Revision.create(
        page_id=page_id, field_key=field_key,
        old_value=f.value, new_value=f.value,
        old_status=f.status, new_status=STATUS_CONFIRMED,
        editor=editor, note=note,
    )
    f.status = STATUS_CONFIRMED
    f.manual = True
    f.updated_at = time.time()
    save_page(page, db_path)
    add_revision(rev, db_path)
    return rev


def add_revision(rev: Revision, db_path: Optional[Path] = None) -> None:
    init_db(db_path)
    with connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO revisions VALUES (?,?,?,?,?,?,?,?,?,?)",
            (rev.rev_id, rev.page_id, rev.field_key,
             _dumps(rev.old_value), _dumps(rev.new_value),
             rev.old_status, rev.new_status, rev.editor, rev.note, rev.ts),
        )


def list_revisions(page_id: str, db_path: Optional[Path] = None
                   ) -> list[dict[str, Any]]:
    init_db(db_path)
    with connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM revisions WHERE page_id=? ORDER BY ts",
            (page_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            for k in ("old_value", "new_value"):
                d[k] = json.loads(d[k]) if d[k] is not None else None
            out.append(d)
        return out
