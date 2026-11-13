"""SQLite 存储层：只负责数据存取，不含业务判定。

时间在库内统一存为归一化 UTC 文本（可直接字典序比较），
开放区间用 valid_to IS NULL 表示。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterable, Iterator, Optional, Sequence

from .io_utils import CalibrationRow, MeasurementRow
from .timeutil import INFINITY, now_utc

SCHEMA = """
CREATE TABLE IF NOT EXISTS batch (
    batch_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('calibration', 'measurement')),
    file_name   TEXT NOT NULL,
    row_count   INTEGER NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calibration (
    cal_id        TEXT PRIMARY KEY,           -- 校准编号（重导即覆盖）
    instrument    TEXT NOT NULL,
    registered_at TEXT NOT NULL,              -- 登记时间（系统录入时刻）
    valid_from    TEXT NOT NULL,              -- 生效区间起点，闭
    valid_to      TEXT,                       -- 生效区间终点，开；NULL=至今
    coefficient   TEXT NOT NULL,
    batch_id      INTEGER REFERENCES batch(batch_id)
);
CREATE INDEX IF NOT EXISTS idx_cal_lookup
    ON calibration(instrument, registered_at, valid_from);

CREATE TABLE IF NOT EXISTS measurement (
    measurement_id TEXT PRIMARY KEY,
    instrument     TEXT NOT NULL,
    measured_at    TEXT NOT NULL,
    raw_reading    REAL NOT NULL,
    batch_id       INTEGER REFERENCES batch(batch_id)
);
CREATE INDEX IF NOT EXISTS idx_meas_lookup
    ON measurement(instrument, measured_at);

-- 每次“按某截止时间查询”对应一次 run；同截止时间的 run 唯一，
-- 重查同一截止时间直接复用已冻结的快照（可复现当时的结果）。
CREATE TABLE IF NOT EXISTS run (
    run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    cutoff        TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    note          TEXT
);

-- 快照：每个 run 下每条测量当时的回算结果
CREATE TABLE IF NOT EXISTS result (
    run_id         INTEGER NOT NULL REFERENCES run(run_id),
    measurement_id TEXT NOT NULL REFERENCES measurement(measurement_id),
    instrument     TEXT NOT NULL,
    measured_at    TEXT NOT NULL,
    raw_reading    REAL NOT NULL,
    cal_id         TEXT,                      -- 实际采用的校准编号
    calibrated     REAL,                      -- 回算值；未校准时为 NULL
    status         TEXT NOT NULL CHECK (
                       status IN ('calibrated', 'uncalibrated', 'conflict')),
    conflict_cal_ids TEXT,                   -- 冲突涉及的校准编号（JSON 数组文本）
    PRIMARY KEY (run_id, measurement_id)
);
CREATE INDEX IF NOT EXISTS idx_result_mid ON result(measurement_id);

-- 增量重算的变更清单
CREATE TABLE IF NOT EXISTS run_change (
    change_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES run(run_id),
    measurement_id  TEXT NOT NULL,
    instrument      TEXT NOT NULL,
    old_status      TEXT,
    old_cal_id      TEXT,
    old_calibrated  REAL,
    new_status      TEXT NOT NULL,
    new_cal_id      TEXT,
    new_calibrated  REAL
);
CREATE INDEX IF NOT EXISTS idx_change_run ON run_change(run_id);
"""


class Store:
    def __init__(self, path: str):
        # check_same_thread=False 不是必须的，保持单线程使用即可
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self.conn
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    # ---------- 批次导入 ----------

    def add_batch(self, kind: str, file_name: str, row_count: int) -> int:
        cur = self.conn.execute(
            "INSERT INTO batch(kind, file_name, row_count, imported_at) "
            "VALUES (?, ?, ?, ?)",
            (kind, file_name, row_count, now_utc()),
        )
        return int(cur.lastrowid)

    def upsert_calibrations(self, rows: Iterable[CalibrationRow],
                            batch_id: int) -> int:
        data = [(r.cal_id, r.instrument, r.registered_at, r.valid_from,
                 r.valid_to, r.coefficient, batch_id) for r in rows]
        self.conn.executemany(
            "INSERT INTO calibration(cal_id, instrument, registered_at, "
            "valid_from, valid_to, coefficient, batch_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(cal_id) DO UPDATE SET "
            "instrument=excluded.instrument, registered_at=excluded.registered_at, "
            "valid_from=excluded.valid_from, valid_to=excluded.valid_to, "
            "coefficient=excluded.coefficient, batch_id=excluded.batch_id",
            data,
        )
        return len(data)

    def upsert_measurements(self, rows: Iterable[MeasurementRow],
                            batch_id: int) -> int:
        data = [(r.measurement_id, r.instrument, r.measured_at,
                 r.raw_reading, batch_id) for r in rows]
        self.conn.executemany(
            "INSERT INTO measurement(measurement_id, instrument, measured_at, "
            "raw_reading, batch_id) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(measurement_id) DO UPDATE SET "
            "instrument=excluded.instrument, measured_at=excluded.measured_at, "
            "raw_reading=excluded.raw_reading, batch_id=excluded.batch_id",
            data,
        )
        return len(data)

    # ---------- 校准查询 ----------

    def calibrations_for_instrument(self, instrument: str,
                                    cutoff: Optional[str] = None) -> list[sqlite3.Row]:
        """取某仪器的校准记录；cutoff 给定时只含登记时间不晚于它的。"""
        if cutoff is None:
            cur = self.conn.execute(
                "SELECT * FROM calibration WHERE instrument = ? "
                "ORDER BY registered_at, cal_id",
                (instrument,),
            )
        else:
            cur = self.conn.execute(
                "SELECT * FROM calibration WHERE instrument = ? "
                "AND registered_at <= ? ORDER BY registered_at, cal_id",
                (instrument, cutoff),
            )
        return cur.fetchall()

    def instruments_with_new_calibrations(self, prev_cutoff: Optional[str],
                                          cutoff: str) -> list[str]:
        """prev_cutoff 之后新登记（或覆盖导入）校准记录的仪器。

        这些仪器的测量才可能因补录而改变来源。
        """
        if prev_cutoff is None:
            cur = self.conn.execute("SELECT DISTINCT instrument FROM calibration")
        else:
            cur = self.conn.execute(
                "SELECT DISTINCT instrument FROM calibration "
                "WHERE registered_at > ? AND registered_at <= ?",
                (prev_cutoff, cutoff),
            )
        return [r["instrument"] for r in cur.fetchall()]

    def overlapping_groups(self, cutoff: Optional[str] = None) -> list[sqlite3.Row]:
        """同仪器、同登记时刻、生效区间相互重叠的记录对。

        区间为左闭右开 [valid_from, valid_to)，NULL 终点按 +inf 处理。
        重叠条件：a.valid_from < b 的终点 且 b.valid_from < a 的终点。
        """
        cutoff_clause = ""
        params: list = []
        if cutoff is not None:
            cutoff_clause = "AND a.registered_at <= ?"
            params.append(cutoff)
        cur = self.conn.execute(
            f"""
            SELECT a.instrument AS instrument,
                   a.registered_at AS registered_at,
                   a.cal_id AS cal_id_a, b.cal_id AS cal_id_b,
                   a.valid_from AS a_from, a.valid_to AS a_to,
                   b.valid_from AS b_from, b.valid_to AS b_to
            FROM calibration a
            JOIN calibration b
              ON a.instrument = b.instrument
             AND a.registered_at = b.registered_at
             AND a.cal_id < b.cal_id
             AND a.valid_from < COALESCE(b.valid_to, '{INFINITY}')
             AND b.valid_from < COALESCE(a.valid_to, '{INFINITY}')
            WHERE 1=1 {cutoff_clause}
            ORDER BY a.instrument, a.registered_at, a.cal_id, b.cal_id
            """,
            params,
        )
        return cur.fetchall()

    # ---------- run / 快照 ----------

    def find_run(self, cutoff: str) -> Optional[sqlite3.Row]:
        cur = self.conn.execute("SELECT * FROM run WHERE cutoff = ?", (cutoff,))
        return cur.fetchone()

    def create_run(self, cutoff: str, note: Optional[str] = None) -> int:
        cur = self.conn.execute(
            "INSERT INTO run(cutoff, created_at, note) VALUES (?, ?, ?)",
            (cutoff, now_utc(), note),
        )
        return int(cur.lastrowid)

    def latest_run_before(self, cutoff: str) -> Optional[sqlite3.Row]:
        cur = self.conn.execute(
            "SELECT * FROM run WHERE cutoff < ? ORDER BY cutoff DESC LIMIT 1",
            (cutoff,),
        )
        return cur.fetchone()

    def copy_snapshot(self, src_run_id: int, dst_run_id: int) -> int:
        """把上一个 run 的快照整体复制到新 run（未受影响测量保持不变）。"""
        cur = self.conn.execute(
            "INSERT INTO result(run_id, measurement_id, instrument, measured_at, "
            "raw_reading, cal_id, calibrated, status, conflict_cal_ids) "
            "SELECT ?, measurement_id, instrument, measured_at, raw_reading, "
            "cal_id, calibrated, status, conflict_cal_ids FROM result "
            "WHERE run_id = ?",
            (dst_run_id, src_run_id),
        )
        return cur.rowcount

    def measurement_ids_for_instruments(self,
                                        instruments: Sequence[str]) -> list[str]:
        if not instruments:
            return []
        marks = ",".join("?" for _ in instruments)
        cur = self.conn.execute(
            f"SELECT measurement_id FROM measurement "
            f"WHERE instrument IN ({marks}) ORDER BY measurement_id",
            list(instruments),
        )
        return [r["measurement_id"] for r in cur.fetchall()]

    def measurement_ids_not_in_run(self, run_id: int) -> list[str]:
        """已导入但还没进入该 run 快照的测量（新批次补录的明细）。"""
        cur = self.conn.execute(
            "SELECT m.measurement_id FROM measurement m "
            "WHERE NOT EXISTS (SELECT 1 FROM result r "
            "WHERE r.run_id = ? AND r.measurement_id = m.measurement_id) "
            "ORDER BY m.measurement_id",
            (run_id,),
        )
        return [r["measurement_id"] for r in cur.fetchall()]

    def get_measurements(self, measurement_ids: Sequence[str]
                         ) -> list[sqlite3.Row]:
        if not measurement_ids:
            return []
        marks = ",".join("?" for _ in measurement_ids)
        cur = self.conn.execute(
            f"SELECT * FROM measurement WHERE measurement_id IN ({marks})",
            list(measurement_ids),
        )
        return cur.fetchall()

    def get_result(self, run_id: int, measurement_id: str
                   ) -> Optional[sqlite3.Row]:
        cur = self.conn.execute(
            "SELECT * FROM result WHERE run_id = ? AND measurement_id = ?",
            (run_id, measurement_id),
        )
        return cur.fetchone()

    def upsert_result(self, run_id: int, m: sqlite3.Row,
                      outcome: "Outcome") -> None:  # noqa: F821 (前向类型)
        self.conn.execute(
            "INSERT INTO result(run_id, measurement_id, instrument, measured_at, "
            "raw_reading, cal_id, calibrated, status, conflict_cal_ids) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(run_id, measurement_id) DO UPDATE SET "
            "instrument=excluded.instrument, measured_at=excluded.measured_at, "
            "raw_reading=excluded.raw_reading, cal_id=excluded.cal_id, "
            "calibrated=excluded.calibrated, status=excluded.status, "
            "conflict_cal_ids=excluded.conflict_cal_ids",
            (run_id, m["measurement_id"], m["instrument"], m["measured_at"],
             m["raw_reading"], outcome.cal_id, outcome.calibrated,
             outcome.status, outcome.conflict_cal_ids_json()),
        )

    def record_changes(self, run_id: int, changes: Iterable[sqlite3.Row | dict]
                       ) -> int:
        payload = []
        for ch in changes:
            payload.append((
                run_id, ch["measurement_id"], ch["instrument"],
                ch["old_status"], ch["old_cal_id"], ch["old_calibrated"],
                ch["new_status"], ch["new_cal_id"], ch["new_calibrated"],
            ))
        if not payload:
            return 0
        self.conn.executemany(
            "INSERT INTO run_change(run_id, measurement_id, instrument, "
            "old_status, old_cal_id, old_calibrated, "
            "new_status, new_cal_id, new_calibrated) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            payload,
        )
        return len(payload)

    def list_changes(self, run_id: int) -> list[sqlite3.Row]:
        cur = self.conn.execute(
            "SELECT * FROM run_change WHERE run_id = ? ORDER BY measurement_id",
            (run_id,),
        )
        return cur.fetchall()

    def list_results(self, run_id: int,
                     instrument: Optional[str] = None) -> list[sqlite3.Row]:
        if instrument is None:
            cur = self.conn.execute(
                "SELECT * FROM result WHERE run_id = ? "
                "ORDER BY measurement_id", (run_id,))
        else:
            cur = self.conn.execute(
                "SELECT * FROM result WHERE run_id = ? AND instrument = ? "
                "ORDER BY measurement_id", (run_id, instrument))
        return cur.fetchall()

    def count_measurements(self) -> int:
        return int(self.conn.execute(
            "SELECT COUNT(*) FROM measurement").fetchone()[0])
