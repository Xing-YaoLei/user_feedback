"""SQLite 持久层。

去重依赖 measurements 上的 UNIQUE(device_id, boot_id, seq)：
三元组相同就是网络重复；boot_id 不同则 seq 再小也是新一轮测量。
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from dataclasses import dataclass

from .protocol import Measurement, to_canonical

SCHEMA = """
CREATE TABLE IF NOT EXISTS measurements (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id        TEXT NOT NULL,
    boot_id          TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    device_ts        REAL NOT NULL,          -- 设备上报的原始时钟（回拨也保留原值）
    value            REAL NOT NULL,          -- 设备上报的原始值（不做就地覆盖）
    unit             TEXT NOT NULL,          -- 设备上报的原始单位
    canonical_value  REAL NOT NULL,          -- 折算到标准单位后的值
    canonical_unit   TEXT NOT NULL,
    retained         INTEGER NOT NULL DEFAULT 0,
    dup_count        INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL,          -- ok / anomaly / retained_snapshot
    flags            TEXT NOT NULL DEFAULT '',
    explanation      TEXT NOT NULL DEFAULT '',
    topic            TEXT NOT NULL,
    raw              TEXT NOT NULL,
    received_ts      REAL NOT NULL,
    UNIQUE(device_id, boot_id, seq)
);

CREATE TABLE IF NOT EXISTS device_states (
    device_id      TEXT PRIMARY KEY,
    boot_id        TEXT NOT NULL,
    last_seq       INTEGER NOT NULL,
    last_unit      TEXT NOT NULL,
    last_device_ts REAL NOT NULL,
    seen_count     INTEGER NOT NULL DEFAULT 0,
    updated_ts     REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS gap_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     TEXT NOT NULL,
    boot_id       TEXT NOT NULL,
    expected_seq  INTEGER NOT NULL,
    observed_seq  INTEGER NOT NULL,
    missing_count INTEGER NOT NULL,
    reason        TEXT NOT NULL,             -- seq_gap / overload_drop
    detail        TEXT NOT NULL DEFAULT '',
    created_ts    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS overload_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_size INTEGER NOT NULL,
    identity   TEXT NOT NULL DEFAULT '',
    created_ts REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meas_device ON measurements(device_id, boot_id, seq);
CREATE INDEX IF NOT EXISTS idx_gap_device ON gap_events(device_id);
"""


@dataclass
class IngestResult:
    kind: str  # new / duplicate_network / retained_snapshot
    measurement: Measurement
    flags: list
    explanation: str
    gap_missing: int = 0


class Storage:
    def __init__(self, db_path: str):
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)
        self._lock = threading.RLock()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ ingest
    def ingest(self, m: Measurement, received_ts: float | None = None) -> IngestResult:
        received_ts = received_ts if received_ts is not None else time.time()
        canonical_value, canonical_unit = to_canonical(m.value, m.unit)
        with self._lock:
            cur = self._conn.execute(
                "SELECT id, dup_count, status FROM measurements "
                "WHERE device_id=? AND boot_id=? AND seq=?",
                (m.device_id, m.boot_id, m.seq),
            )
            existing = cur.fetchone()
            promoted_snapshot = False
            if existing is not None:
                if existing["status"] == "retained_snapshot":
                    # 同身份在线消息到达：删除占位快照行，转走完整入账状态机。
                    # 这样重启/单位/回拨/缺口判定都能正常执行，快照来源用 flag 保留。
                    self._conn.execute(
                        "DELETE FROM measurements WHERE id=?", (existing["id"],))
                    promoted_snapshot = True
                else:
                    # 三元组完全一致：网络层重复（broker 重投/持久会话排队/QoS1 重发）
                    self._conn.execute(
                        "UPDATE measurements SET dup_count=dup_count+1 WHERE id=?",
                        (existing["id"],),
                    )
                    self._conn.commit()
                    return IngestResult(
                        kind="duplicate_network",
                        measurement=m,
                        flags=["duplicate_network"]
                        + (["retained"] if m.retained else []),
                        explanation=(
                            f"身份 {m.identity} 已存在，判定为网络重复投递"
                            + ("（消息带 retained 标记）" if m.retained else "")
                        ),
                    )

            state = self._conn.execute(
                "SELECT * FROM device_states WHERE device_id=?", (m.device_id,)
            ).fetchone()

            # Retained 快照：设备从未出现过、身份又是新的 -> 这是订阅时 broker 推送的
            # 保留消息（最近状态快照）。只存测量行，不写 device_states：
            # 快照不代表设备在线，也不参与重启/序号/时钟判定。
            if m.retained and state is None:
                self._insert_measurement(
                    m, canonical_value, canonical_unit, received_ts,
                    status="retained_snapshot",
                    flags=["retained_snapshot"],
                    explanation=(
                        "retained 保留消息且本设备无在线记录，作为状态快照保存，"
                        "不计入新测量统计"
                    ),
                )
                self._conn.commit()
                return IngestResult(
                    kind="retained_snapshot", measurement=m,
                    flags=["retained_snapshot"],
                    explanation="retained 快照，不计为新测量",
                )

            flags: list[str] = []
            explanations: list[str] = []
            gap_missing = 0

            if promoted_snapshot:
                flags.append("retained_snapshot_promoted")
                explanations.append(
                    "同身份在线消息到达，此前的 retained 占位快照转为正式测量"
                )

            if m.retained:
                flags.append("retained_redelivery")
                explanations.append(
                    "消息带 retained 标记，但身份为新且设备已有在线记录，"
                    "按新测量入账并单独标记"
                )

            if state is not None and state["boot_id"] != m.boot_id:
                flags.append("device_restart")
                explanations.append(
                    f"设备重启：boot_id {state['boot_id']} -> {m.boot_id}；"
                    f"上一周期最后 seq={state['last_seq']}，本周期 seq 从 {m.seq} "
                    "重新开始属于合法重用，不按重复处理"
                )
            elif state is not None and m.seq > state["last_seq"] + 1:
                gap_missing = m.seq - state["last_seq"] - 1
                self._conn.execute(
                    "INSERT INTO gap_events(device_id, boot_id, expected_seq, "
                    "observed_seq, missing_count, reason, detail, created_ts) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (m.device_id, m.boot_id, state["last_seq"] + 1, m.seq,
                     gap_missing, "seq_gap",
                     f"收到 seq={m.seq}，期望 {state['last_seq'] + 1}", received_ts),
                )
                explanations.append(
                    f"序号缺口：期望 seq={state['last_seq'] + 1}，实际 {m.seq}，"
                    f"丢失 {gap_missing} 条"
                )

            if state is not None and state["last_unit"] != m.unit:
                flags.append("unit_switched")
                explanations.append(
                    f"单位切换：{state['last_unit']} -> {m.unit}；上报原值 "
                    f"{m.value} {m.unit} 原样保留，同时折算标准值 "
                    f"{canonical_value:.4f} {canonical_unit} 便于统一比较"
                )

            if state is not None and m.device_ts < state["last_device_ts"]:
                flags.append("clock_skew")
                delta = state["last_device_ts"] - m.device_ts
                explanations.append(
                    f"时钟回拨（clock_skew）：设备时间 {m.device_ts:.3f} 早于 "
                    f"上一条 {state['last_device_ts']:.3f}，回拨 {delta:.3f}s；"
                    "原始 device_ts 保留不改，排序以接收时间为准"
                )

            self._insert_measurement(
                m, canonical_value, canonical_unit, received_ts,
                status="anomaly" if flags else "ok",
                flags=flags,
                explanation="；".join(explanations),
            )
            self._upsert_state(m, received_ts)
            self._conn.commit()
            return IngestResult(
                kind="new", measurement=m, flags=flags,
                explanation="；".join(explanations), gap_missing=gap_missing,
            )

    def record_overload(self, queue_size: int, identity: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO overload_events(queue_size, identity, created_ts) "
                "VALUES (?,?,?)", (queue_size, identity, time.time())
            )
            self._conn.commit()

    # ----------------------------------------------------------------- internal
    def _insert_measurement(self, m: Measurement, canonical_value: float,
                            canonical_unit: str, received_ts: float,
                            status: str, flags: list[str], explanation: str) -> None:
        self._conn.execute(
            "INSERT INTO measurements(device_id, boot_id, seq, device_ts, value, "
            "unit, canonical_value, canonical_unit, retained, status, flags, "
            "explanation, topic, raw, received_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (m.device_id, m.boot_id, m.seq, m.device_ts, m.value, m.unit,
             canonical_value, canonical_unit, int(m.retained), status,
             ",".join(flags), explanation, m.topic, m.raw, received_ts),
        )

    def _upsert_state(self, m: Measurement, received_ts: float) -> None:
        self._conn.execute(
            "INSERT INTO device_states(device_id, boot_id, last_seq, last_unit, "
            "last_device_ts, seen_count, updated_ts) VALUES (?,?,?,?,?,1,?) "
            "ON CONFLICT(device_id) DO UPDATE SET boot_id=excluded.boot_id, "
            "last_seq=excluded.last_seq, last_unit=excluded.last_unit, "
            "last_device_ts=excluded.last_device_ts, "
            "seen_count=seen_count+1, updated_ts=excluded.updated_ts",
            (m.device_id, m.boot_id, m.seq, m.unit, m.device_ts, received_ts),
        )

    # ---------------------------------------------------------------- dashboard
    def stats(self) -> dict:
        with self._lock:
            def scalar(sql: str) -> int:
                return self._conn.execute(sql).fetchone()[0]
            gap_row = self._conn.execute(
                "SELECT COUNT(*) c, COALESCE(SUM(missing_count),0) s FROM gap_events"
            ).fetchone()
            return {
                "measurements_total": scalar(
                    "SELECT COUNT(*) FROM measurements WHERE status!='retained_snapshot'"),
                "snapshots": scalar(
                    "SELECT COUNT(*) FROM measurements WHERE status='retained_snapshot'"),
                "duplicates": scalar("SELECT COALESCE(SUM(dup_count),0) FROM measurements"),
                "anomalies": scalar(
                    "SELECT COUNT(*) FROM measurements WHERE status='anomaly'"),
                "overload_events": scalar("SELECT COUNT(*) FROM overload_events"),
                "gap_events": gap_row["c"],
                "gap_missing_total": gap_row["s"],
                "devices": scalar("SELECT COUNT(*) FROM device_states"),
            }

    def devices(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM device_states ORDER BY device_id"
            ).fetchall()
            return [dict(r) for r in rows]

    def recent_measurements(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM measurements ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    def gaps(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM gap_events ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    def overloads(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM overload_events ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    def identity_exists(self, device_id: str, boot_id: str, seq: int) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM measurements WHERE device_id=? AND boot_id=? AND seq=?",
                (device_id, boot_id, seq),
            ).fetchone()
            return row is not None
