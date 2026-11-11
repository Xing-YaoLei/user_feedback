"""SQLite 持久化层。

核心保证:
- 原始报文(raw_events)、结构化记录(events)、恢复游标(cursor)在**同一个事务**里提交;
- 采集器只有在 commit 成功返回后才推进内存中的游标,因此"已确认的事件"绝不会丢;
- 带 id 的事件靠 UNIQUE(source, event_id) 去重(重放/重传安全);
- 不带 id 的事件没有可靠去重依据,仅用内容哈希做**有限窗口内的尽力去重**,
  不构成 exactly-once 承诺(见 README「去重边界」)。
"""
from __future__ import annotations

import hashlib
import sqlite3
import threading
import time

from .sse_parser import SSEMessage

SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- event | heartbeat
  raw         TEXT NOT NULL,
  received_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  event_id    TEXT,                     -- 无 id 事件为 NULL
  event_type  TEXT NOT NULL,
  data        TEXT NOT NULL,
  retry_ms    INTEGER,
  dedup_key   TEXT,                     -- 仅无 id 事件使用:内容哈希
  raw_seq     INTEGER NOT NULL REFERENCES raw_events(seq),
  received_at REAL NOT NULL,
  UNIQUE (source, event_id)             -- NULL 不参与唯一约束
);
-- 无 id 事件的尽力去重表:同一 source 下相同内容哈希只首次生效。
-- 这是"尽力而为":哈希窗口会被定期裁剪,窗口外的重复无法识别,
-- 且内容本就相同的两条合法事件也会被误伤 —— 因此不构成 exactly-once 承诺。
CREATE TABLE IF NOT EXISTS idless_dedup (
  source    TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  UNIQUE (source, dedup_key)
);
CREATE TABLE IF NOT EXISTS cursor (
  source        TEXT PRIMARY KEY,
  last_event_id TEXT,
  contiguous    INTEGER NOT NULL DEFAULT 1,  -- 0 = 存在不可补齐缺口,禁止声称连续
  updated_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS gaps (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  from_id     TEXT,
  to_id       TEXT,
  reason      TEXT NOT NULL,            -- retention_exhausted | sequence_gap
  detected_at REAL NOT NULL
);
"""

_IDLESS_HASH_KEEP = 1000  # 每个 source 保留的无 id 去重哈希条数(窗口)


class Store:
    def __init__(self, path: str) -> None:
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---------------------------------------------------------------- 游标

    def get_cursor(self, source: str) -> tuple[str | None, bool] | None:
        """返回 (last_event_id, contiguous);从未采集过返回 None。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT last_event_id, contiguous FROM cursor WHERE source=?",
                (source,),
            ).fetchone()
        if row is None:
            return None
        return row["last_event_id"], bool(row["contiguous"])

    def set_cursor(self, source: str, last_event_id: str | None, contiguous: bool = True) -> None:
        """显式设置游标(测试预置 / 控制页重置用)。"""
        with self._lock:
            self._conn.execute(
                """INSERT INTO cursor(source, last_event_id, contiguous, updated_at)
                   VALUES(?,?,?,?)
                   ON CONFLICT(source) DO UPDATE SET
                     last_event_id=excluded.last_event_id,
                     contiguous=excluded.contiguous,
                     updated_at=excluded.updated_at""",
                (source, last_event_id, 1 if contiguous else 0, time.time()),
            )
            self._conn.commit()

    def clear_cursor_position(self, source: str) -> None:
        """放弃续传位置(保留期耗尽且策略为 jump 时):从头重拉,但 contiguous 保持 0,
        绝不因为跳到了最新位置就声称连续。"""
        with self._lock:
            self._conn.execute(
                "UPDATE cursor SET last_event_id=NULL, updated_at=? WHERE source=?",
                (time.time(), source),
            )
            self._conn.commit()

    def reset_cursor(self, source: str) -> None:
        """控制页「重置游标」:删除游标与缺口记录,事件数据保留(重放时靠唯一约束去重)。"""
        with self._lock:
            self._conn.execute("DELETE FROM cursor WHERE source=?", (source,))
            self._conn.execute("DELETE FROM gaps WHERE source=?", (source,))
            self._conn.commit()

    # ---------------------------------------------------------------- 提交

    def commit_event(
        self,
        source: str,
        msg: SSEMessage,
        *,
        before_commit=None,
        after_commit=None,
    ) -> bool:
        """把一条消息(事件或心跳)落库。返回是否为新事件(非重复)。

        原始报文、结构化记录、游标推进在同一事务内完成。
        before_commit / after_commit 是崩溃注入钩子(仅测试与演练使用)。
        """
        with self._lock:
            inserted = True
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                now = time.time()
                cur = self._conn.execute(
                    "INSERT INTO raw_events(source, kind, raw, received_at) VALUES(?,?,?,?)",
                    (source, msg.kind, msg.raw, now),
                )
                raw_seq = cur.lastrowid
                if msg.kind == "event":
                    dedup_key = None
                    if msg.event_id is None:
                        dedup_key = hashlib.sha256(
                            f"{msg.event}\n{msg.data}".encode("utf-8")
                        ).hexdigest()
                        cur = self._conn.execute(
                            "INSERT OR IGNORE INTO idless_dedup(source, dedup_key, first_seq)"
                            " VALUES(?,?,?)",
                            (source, dedup_key, raw_seq),
                        )
                        inserted = cur.rowcount > 0  # 哈希已存在 -> 窗口内判重
                    if inserted:
                        cur = self._conn.execute(
                            """INSERT OR IGNORE INTO events
                               (source, event_id, event_type, data, retry_ms, dedup_key, raw_seq, received_at)
                               VALUES(?,?,?,?,?,?,?,?)""",
                            (source, msg.event_id, msg.event, msg.data,
                             msg.retry, dedup_key, raw_seq, now),
                        )
                        # 带 id 事件可能因 UNIQUE(source, event_id) 冲突而未插入
                        if msg.event_id is not None:
                            inserted = cur.rowcount > 0
                    # 只有真正插入的新事件才推进游标:重复事件不得把游标往回带
                    if inserted and msg.event_id is not None:
                        self._conn.execute(
                            """INSERT INTO cursor(source, last_event_id, contiguous, updated_at)
                               VALUES(?,?,1,?)
                               ON CONFLICT(source) DO UPDATE SET
                                 last_event_id=excluded.last_event_id,
                                 updated_at=excluded.updated_at""",
                            (source, msg.event_id, now),
                        )
                    self._prune_idless_hashes_locked(source)
                if before_commit is not None:
                    before_commit()
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            if after_commit is not None:
                after_commit()
            return inserted

    def _prune_idless_hashes_locked(self, source: str) -> None:
        """裁剪无 id 去重哈希窗口(保留最近 _IDLESS_HASH_KEEP 条,只删哈希不删事件)。"""
        self._conn.execute(
            """DELETE FROM idless_dedup WHERE source=? AND first_seq NOT IN
               (SELECT first_seq FROM idless_dedup WHERE source=?
                ORDER BY first_seq DESC LIMIT ?)""",
            (source, source, _IDLESS_HASH_KEEP),
        )

    # ---------------------------------------------------------------- 缺口

    def record_gap(
        self,
        source: str,
        from_id: str | None,
        to_id: str | None,
        reason: str,
    ) -> None:
        """记录一个不可补齐的缺口,并把游标标记为非连续。"""
        with self._lock:
            self._conn.execute(
                "INSERT INTO gaps(source, from_id, to_id, reason, detected_at) VALUES(?,?,?,?,?)",
                (source, from_id, to_id, reason, time.time()),
            )
            self._conn.execute(
                """INSERT INTO cursor(source, last_event_id, contiguous, updated_at)
                   VALUES(?,NULL,0,?)
                   ON CONFLICT(source) DO UPDATE SET contiguous=0, updated_at=excluded.updated_at""",
                (source, time.time()),
            )
            self._conn.commit()

    # ---------------------------------------------------------------- 查询

    def stats(self, source: str) -> dict:
        with self._lock:
            q = lambda sql: self._conn.execute(sql, (source,)).fetchone()[0]
            raw_events = q("SELECT COUNT(*) FROM raw_events WHERE source=? AND kind='event'")
            heartbeats = q("SELECT COUNT(*) FROM raw_events WHERE source=? AND kind='heartbeat'")
            events = q("SELECT COUNT(*) FROM events WHERE source=?")
            gaps = q("SELECT COUNT(*) FROM gaps WHERE source=?")
        return {
            "raw_events": raw_events,
            "heartbeats": heartbeats,
            "events": events,
            "duplicates_dropped": raw_events - events,
            "gaps": gaps,
        }

    def timeline(self, source: str, after_seq: int = 0, limit: int = 200) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """SELECT seq, event_id, event_type, data, retry_ms, received_at
                   FROM events WHERE source=? AND seq>? ORDER BY seq LIMIT ?""",
                (source, after_seq, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def list_gaps(self, source: str) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM gaps WHERE source=? ORDER BY seq", (source,)
            ).fetchall()
        return [dict(r) for r in rows]
