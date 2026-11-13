"""SQLite 持久化：源数值、分区结果、预览与运行记录。"""

from __future__ import annotations

import datetime as dt
import math
import os
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple


SCHEMA_VERSION = 1

_SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    name TEXT PRIMARY KEY,
    rev INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS source_values (
    source TEXT NOT NULL,
    date TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (source, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    date TEXT NOT NULL,
    old_value REAL,
    new_value REAL,
    changed_at TEXT NOT NULL,
    rev INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS partitions (
    node TEXT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL,           -- pending | done | blocked
    value REAL,
    rule_sig TEXT NOT NULL,
    deps_sig TEXT NOT NULL,         -- 祖先规则（含必要时的锚点）的快照签名
    anchor TEXT,
    reason TEXT,
    run_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (node, date)
) WITHOUT ROWID;

-- 计算分区时实际读取的输入快照。
--   ref_kind='source'    : ref=源序列名, ref_date=同一天, ref_value=当时源值
--   ref_kind='partition' : ref=上游节点名, ref_date=上游日期, ref_value=当时的汇总值
-- ref_value 为 NULL 表示当时该源日期没有数值。
CREATE TABLE IF NOT EXISTS partition_inputs (
    node TEXT NOT NULL,
    date TEXT NOT NULL,
    ref_kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    ref_date TEXT NOT NULL,
    ref_value REAL,
    PRIMARY KEY (node, date, ref_kind, ref, ref_date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS previews (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    config_path TEXT,
    config_sig TEXT NOT NULL,
    target TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    inputs_sig TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    plan_sig TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL,           -- ready | applied
    applied_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,           -- running | completed | failed | interrupted
    preview_id TEXT,
    config_sig TEXT,
    target TEXT,
    start_date TEXT,
    end_date TEXT,
    planned INTEGER NOT NULL DEFAULT 0,
    worked INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    reused INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_changes_source_date ON source_changes(source, date);
CREATE INDEX IF NOT EXISTS idx_parts_status ON partitions(status);
CREATE INDEX IF NOT EXISTS idx_inputs_ref ON partition_inputs(ref_kind, ref, ref_date);
"""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def fmt_num(value: Optional[float]) -> str:
    if value is None:
        return "空"
    value = float(value)
    if value.is_integer():
        return str(int(value))
    return ("%.6f" % value).rstrip("0").rstrip(".")


class StoreError(RuntimeError):
    """存储层错误。"""


@dataclass
class PartitionRow:
    node: str
    date: str
    status: str
    value: Optional[float]
    rule_sig: str
    deps_sig: str
    anchor: Optional[str]
    reason: Optional[str]
    run_id: Optional[str]
    updated_at: str


@dataclass(frozen=True)
class PartitionInput:
    """分区计算时实际读取的一个输入。"""

    ref_kind: str       # "source" | "partition"
    ref: str
    ref_date: str
    ref_value: Optional[float]

    def key(self) -> Tuple[str, str, str]:
        return (self.ref_kind, self.ref, self.ref_date)


def source_input(source: str, date: str, value: Optional[float]) -> PartitionInput:
    return PartitionInput("source", source, date, value)


def partition_input(node: str, date: str, value: Optional[float]) -> PartitionInput:
    return PartitionInput("partition", node, date, value)


def _check_value(value, source: str, date: str) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise StoreError("源数值必须是数字（%s@%s 收到 %r）" % (source, date, value))
    value = float(value)
    if not math.isfinite(value):
        raise StoreError("源数值必须是有限数字（%s@%s）" % (source, date))
    return value


def _validate_source_date(source: str, date: str) -> None:
    if not source:
        raise StoreError("源名称不能为空")
    try:
        dt.date.fromisoformat(date)
    except (ValueError, TypeError):
        raise StoreError("日期不是合法 YYYY-MM-DD：%r" % (date,)) from None


class Store:
    def __init__(self, path: str):
        self.path = path if path == ":memory:" else os.path.abspath(path)
        if path != ":memory:":
            parent = os.path.dirname(self.path)
            if parent and not os.path.isdir(parent):
                raise StoreError("存储目录不存在：%s" % parent)
        try:
            self.conn = sqlite3.connect(self.path)
        except sqlite3.Error as exc:
            raise StoreError("无法打开存储 %s：%s" % (path, exc)) from None
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_SCHEMA)
        version = self._meta_get("schema_version")
        if version is None:
            self._meta_set("schema_version", str(SCHEMA_VERSION))
        elif version != str(SCHEMA_VERSION):
            raise StoreError(
                "存储结构版本 %s 与工具期望的 %s 不一致" % (version, SCHEMA_VERSION)
            )
        self.conn.commit()
        self._value_cache: Dict[Tuple[str, str], Optional[float]] = {}

    # ---------- 基础 ----------

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _meta_get(self, key: str) -> Optional[str]:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def _meta_set(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self.conn
        except Exception:
            self.conn.rollback()
            raise
        else:
            self.conn.commit()

    # ---------- 源数值 ----------

    def source_rev(self, source: str) -> int:
        row = self.conn.execute("SELECT rev FROM sources WHERE name=?", (source,)).fetchone()
        return int(row["rev"]) if row else 0

    def get_source_value(self, source: str, date: str) -> Optional[float]:
        key = (source, date)
        if key in self._value_cache:
            return self._value_cache[key]
        row = self.conn.execute(
            "SELECT value FROM source_values WHERE source=? AND date=?", (source, date)
        ).fetchone()
        value = float(row["value"]) if row else None
        self._value_cache[key] = value
        return value

    def clear_source_cache(self) -> None:
        self._value_cache.clear()

    def _write_value(
        self,
        conn: sqlite3.Connection,
        source: str,
        date: str,
        value: Optional[float],
        now: str,
    ) -> bool:
        """写一个源值（内部，需在事务中调用）。返回是否真的变化。"""
        row = conn.execute(
            "SELECT value FROM source_values WHERE source=? AND date=?", (source, date)
        ).fetchone()
        old = float(row["value"]) if row else None
        if old == value:
            return False
        src = conn.execute("SELECT rev FROM sources WHERE name=?", (source,)).fetchone()
        new_rev = (int(src["rev"]) if src else 0) + 1
        conn.execute(
            "INSERT INTO sources(name,rev,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET rev=excluded.rev, updated_at=excluded.updated_at",
            (source, new_rev, now),
        )
        if value is None:
            conn.execute("DELETE FROM source_values WHERE source=? AND date=?", (source, date))
        else:
            conn.execute(
                "INSERT INTO source_values(source,date,value) VALUES(?,?,?) "
                "ON CONFLICT(source,date) DO UPDATE SET value=excluded.value",
                (source, date, value),
            )
        conn.execute(
            "INSERT INTO source_changes(source,date,old_value,new_value,changed_at,rev) "
            "VALUES(?,?,?,?,?,?)",
            (source, date, old, value, now, new_rev),
        )
        return True

    def set_source_value(self, source: str, date: str, value: Optional[float]) -> bool:
        """写入或删除一个源数值；仅在值实际变化时推进版本。返回是否发生变化。"""
        _validate_source_date(source, date)
        value = _check_value(value, source, date)
        with self.transaction() as conn:
            changed = self._write_value(conn, source, date, value, utc_now())
        if changed:
            self._value_cache[(source, date)] = value
        return changed

    def import_source_values(
        self, records: Sequence[Tuple[str, str, Optional[float]]]
    ) -> Tuple[int, List[str]]:
        """批量导入，单事务。返回 (实际变化的记录数, 变化的源名称列表)。"""
        changed = 0
        touched: List[str] = []
        with self.transaction() as conn:
            now = utc_now()
            for source, date, value in records:
                _validate_source_date(source, date)
                value = _check_value(value, source, date)
                if self._write_value(conn, source, date, value, now):
                    changed += 1
                    if source not in touched:
                        touched.append(source)
        self.clear_source_cache()
        return changed, touched

    def list_sources(self) -> List[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT s.name, s.rev, s.updated_at, "
                "       (SELECT COUNT(*) FROM source_values v WHERE v.source=s.name) AS n, "
                "       (SELECT MIN(date) FROM source_values v WHERE v.source=s.name) AS min_date, "
                "       (SELECT MAX(date) FROM source_values v WHERE v.source=s.name) AS max_date "
                "FROM sources s ORDER BY s.name"
            )
        )

    def source_changes(self, source: str, limit: int = 20) -> List[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT date, old_value, new_value, changed_at, rev FROM source_changes "
                "WHERE source=? ORDER BY id DESC LIMIT ?",
                (source, limit),
            )
        )

    # ---------- 分区 ----------

    def _part_row(self, row: sqlite3.Row) -> PartitionRow:
        return PartitionRow(
            node=row["node"], date=row["date"], status=row["status"], value=row["value"],
            rule_sig=row["rule_sig"], deps_sig=row["deps_sig"], anchor=row["anchor"],
            reason=row["reason"], run_id=row["run_id"], updated_at=row["updated_at"],
        )

    def get_partition(self, node: str, date: str) -> Optional[PartitionRow]:
        row = self.conn.execute(
            "SELECT node,date,status,value,rule_sig,deps_sig,anchor,reason,run_id,updated_at "
            "FROM partitions WHERE node=? AND date=?",
            (node, date),
        ).fetchone()
        return self._part_row(row) if row else None

    def get_partitions(self, node: str, start: str, end: str) -> List[PartitionRow]:
        rows = self.conn.execute(
            "SELECT node,date,status,value,rule_sig,deps_sig,anchor,reason,run_id,updated_at "
            "FROM partitions WHERE node=? AND date BETWEEN ? AND ? ORDER BY date",
            (node, start, end),
        )
        return [self._part_row(r) for r in rows]

    def get_inputs(self, node: str, date: str) -> List[PartitionInput]:
        rows = self.conn.execute(
            "SELECT ref_kind, ref, ref_date, ref_value FROM partition_inputs "
            "WHERE node=? AND date=? ORDER BY ref_kind, ref, ref_date",
            (node, date),
        )
        return [
            PartitionInput(r["ref_kind"], r["ref"], r["ref_date"], r["ref_value"]) for r in rows
        ]

    def get_inputs_range(
        self, node: str, start: str, end: str
    ) -> Dict[Tuple[str, str], List[PartitionInput]]:
        rows = self.conn.execute(
            "SELECT date, ref_kind, ref, ref_date, ref_value FROM partition_inputs "
            "WHERE node=? AND date BETWEEN ? AND ? ORDER BY date, ref_kind, ref, ref_date",
            (node, start, end),
        )
        grouped: Dict[Tuple[str, str], List[PartitionInput]] = {}
        for r in rows:
            grouped.setdefault((node, r["date"]), []).append(
                PartitionInput(r["ref_kind"], r["ref"], r["ref_date"], r["ref_value"])
            )
        return grouped

    def insert_pending(
        self,
        entries: Sequence[Tuple[str, str, str, str, Optional[str]]],
        run_id: str,
    ) -> None:
        """entries: (node, date, rule_sig, deps_sig, anchor)。清空旧输入，等待重算。"""
        now = utc_now()
        with self.transaction() as conn:
            conn.executemany(
                "DELETE FROM partition_inputs WHERE node=? AND date=?",
                [(node, date) for node, date, _, _, _ in entries],
            )
            conn.executemany(
                "INSERT INTO partitions(node,date,status,value,rule_sig,deps_sig,anchor,reason,run_id,updated_at) "
                "VALUES(?,?, 'pending', NULL, ?, ?, ?, NULL, ?, ?) "
                "ON CONFLICT(node,date) DO UPDATE SET status='pending', value=NULL, "
                "rule_sig=excluded.rule_sig, deps_sig=excluded.deps_sig, anchor=excluded.anchor, "
                "reason=NULL, run_id=excluded.run_id, updated_at=excluded.updated_at",
                [
                    (node, date, rule_sig, deps_sig, anchor, run_id, now)
                    for node, date, rule_sig, deps_sig, anchor in entries
                ],
            )

    def finish_partition(
        self,
        node: str,
        date: str,
        status: str,
        value: Optional[float],
        rule_sig: str,
        deps_sig: str,
        anchor: Optional[str],
        reason: Optional[str],
        inputs: Iterable[PartitionInput],
        run_id: str,
    ) -> None:
        if status not in ("done", "blocked"):
            raise StoreError("非法的分区状态：%s" % status)
        if status == "blocked" and value is not None:
            raise StoreError("阻塞分区不应有值")
        now = utc_now()
        inputs = list(inputs)
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO partitions(node,date,status,value,rule_sig,deps_sig,anchor,reason,run_id,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(node,date) DO UPDATE SET status=excluded.status, value=excluded.value, "
                "rule_sig=excluded.rule_sig, deps_sig=excluded.deps_sig, anchor=excluded.anchor, "
                "reason=excluded.reason, run_id=excluded.run_id, updated_at=excluded.updated_at",
                (node, date, status, value, rule_sig, deps_sig, anchor, reason, run_id, now),
            )
            conn.execute("DELETE FROM partition_inputs WHERE node=? AND date=?", (node, date))
            conn.executemany(
                "INSERT INTO partition_inputs(node,date,ref_kind,ref,ref_date,ref_value) "
                "VALUES(?,?,?,?,?,?)",
                [
                    (node, date, item.ref_kind, item.ref, item.ref_date, item.ref_value)
                    for item in inputs
                ],
            )

    def pending_partitions(self, limit: int = 20) -> List[PartitionRow]:
        rows = self.conn.execute(
            "SELECT node,date,status,value,rule_sig,deps_sig,anchor,reason,run_id,updated_at "
            "FROM partitions WHERE status='pending' ORDER BY node,date LIMIT ?", (limit,)
        )
        return [self._part_row(r) for r in rows]

    def pending_or_blocked(self, node: str, start: str, end: str) -> List[PartitionRow]:
        rows = self.conn.execute(
            "SELECT node,date,status,value,rule_sig,deps_sig,anchor,reason,run_id,updated_at "
            "FROM partitions WHERE node=? AND date BETWEEN ? AND ? "
            "  AND status IN ('pending','blocked') ORDER BY date",
            (node, start, end),
        )
        return [self._part_row(r) for r in rows]

    def partition_counts(self) -> Dict[str, int]:
        rows = self.conn.execute("SELECT status, COUNT(*) AS n FROM partitions GROUP BY status")
        return {r["status"]: int(r["n"]) for r in rows}

    # ---------- 预览与运行 ----------

    def create_preview(
        self,
        config_path: Optional[str],
        config_sig: str,
        target: str,
        start: str,
        end: str,
        inputs_sig: str,
        inputs_json: str,
        plan_sig: str,
        plan_json: str,
    ) -> str:
        preview_id = uuid.uuid4().hex[:12]
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO previews(id,created_at,config_path,config_sig,target,start_date,end_date,"
                "inputs_sig,inputs_json,plan_sig,plan_json,status) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?, 'ready')",
                (
                    preview_id, utc_now(), config_path, config_sig, target, start, end,
                    inputs_sig, inputs_json, plan_sig, plan_json,
                ),
            )
        return preview_id

    def get_preview(self, preview_id: str) -> Optional[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM previews WHERE id=?", (preview_id,)).fetchone()

    def mark_preview_applied(self, preview_id: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                "UPDATE previews SET status='applied', applied_at=? WHERE id=?",
                (utc_now(), preview_id),
            )

    def recent_previews(self, limit: int = 10) -> List[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT id,created_at,target,start_date,end_date,status FROM previews "
            "ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
        ))

    def create_run(
        self, preview_id: str, config_sig: str, target: str, start: str, end: str,
        planned: int, reused: int,
    ) -> str:
        run_id = uuid.uuid4().hex[:12]
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO runs(id,created_at,status,preview_id,config_sig,target,start_date,end_date,"
                "planned,worked,blocked,reused) VALUES(?,?,'running',?,?,?,?,?,?,0,0,?)",
                (run_id, utc_now(), preview_id, config_sig, target, start, end, planned, reused),
            )
        return run_id

    def finish_run(
        self, run_id: str, status: str, worked: int, blocked: int, reused: int,
        error: Optional[str] = None,
    ) -> None:
        if status not in ("completed", "failed", "interrupted"):
            raise StoreError("非法的运行状态：%s" % status)
        with self.transaction() as conn:
            conn.execute(
                "UPDATE runs SET finished_at=?, status=?, worked=?, blocked=?, reused=?, error=? "
                "WHERE id=?",
                (utc_now(), status, worked, blocked, reused, error, run_id),
            )

    def recent_runs(self, limit: int = 10) -> List[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT id,created_at,finished_at,status,target,start_date,end_date,planned,worked,"
            "blocked,reused,error FROM runs ORDER BY created_at DESC, id DESC LIMIT ?",
            (limit,),
        ))

    def mark_orphan_runs(self) -> int:
        """把之前进程遗留的 running 运行标记为中断（仅影响状态展示）。"""
        with self.transaction() as conn:
            cur = conn.execute(
                "UPDATE runs SET status='interrupted', finished_at=? WHERE status='running'",
                (utc_now(),),
            )
        return cur.rowcount
