"""SQLite 关系库：对象、引用边、缺口、抓取日志、采集运行。

设计要点：
- objects 以 (type, id, version) 为主键 —— 同一对象不同版本是不同行，绝不混用。
- edges 记录每一条引用边（含角色 role），同一对对象之间允许不同 role 的边并存。
- gaps 记录未解析引用：not_found / deleted / fetch_failed / version_mismatch。
- runs.status 只有 'complete' 与 'partial'：只要存在任何缺口或失败，一律 partial，
  绝不把局部失败误报为完整采集。
"""
import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS objects(
  type TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
  payload TEXT NOT NULL, fetched_run INTEGER NOT NULL, fetched_at REAL NOT NULL,
  PRIMARY KEY(type, id, version)
);
CREATE TABLE IF NOT EXISTS edges(
  from_type TEXT NOT NULL, from_id TEXT NOT NULL, from_version INTEGER NOT NULL,
  to_type TEXT NOT NULL, to_id TEXT NOT NULL, to_version INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY(from_type, from_id, from_version, to_type, to_id, to_version, role)
);
CREATE TABLE IF NOT EXISTS roots(
  run_id INTEGER NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY(run_id, type, id, version)
);
CREATE TABLE IF NOT EXISTS gaps(
  gap_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  from_type TEXT, from_id TEXT, from_version INTEGER,
  to_type TEXT NOT NULL, to_id TEXT NOT NULL, to_version INTEGER NOT NULL,
  reason TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS fetch_log(
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
  attempt INTEGER NOT NULL, status INTEGER, error TEXT, ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs(
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at REAL NOT NULL, finished_at REAL,
  status TEXT NOT NULL DEFAULT 'running', stats TEXT
);
"""


class DB:
    def __init__(self, path=":memory:"):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def close(self):
        self.conn.close()

    # ---- 运行 ----
    def start_run(self):
        cur = self.conn.execute(
            "INSERT INTO runs(started_at, status) VALUES(?, 'running')", (time.time(),))
        self.conn.commit()
        return cur.lastrowid

    def finish_run(self, run_id, status, stats):
        self.conn.execute(
            "UPDATE runs SET finished_at=?, status=?, stats=? WHERE run_id=?",
            (time.time(), status, json.dumps(stats, ensure_ascii=False), run_id))
        self.conn.commit()

    def add_root(self, run_id, ref):
        self.conn.execute(
            "INSERT OR IGNORE INTO roots(run_id, type, id, version) VALUES(?,?,?,?)",
            (run_id, ref.type, ref.id, ref.version))
        self.conn.commit()

    # ---- 对象与边 ----
    def put_object(self, ref, payload, run_id):
        self.conn.execute(
            "INSERT OR REPLACE INTO objects(type,id,version,payload,fetched_run,fetched_at)"
            " VALUES(?,?,?,?,?,?)",
            (ref.type, ref.id, ref.version, json.dumps(payload, ensure_ascii=False),
             run_id, time.time()))
        self.conn.commit()

    def has_object(self, ref):
        return self.conn.execute(
            "SELECT 1 FROM objects WHERE type=? AND id=? AND version=?",
            (ref.type, ref.id, ref.version)).fetchone() is not None

    def add_edge(self, from_ref, to_ref, role):
        self.conn.execute(
            "INSERT OR IGNORE INTO edges VALUES(?,?,?,?,?,?,?)",
            (from_ref.type, from_ref.id, from_ref.version,
             to_ref.type, to_ref.id, to_ref.version, role))
        self.conn.commit()

    # ---- 缺口与日志 ----
    def add_gap(self, run_id, from_ref, to_ref, reason, detail=None):
        self.conn.execute(
            "INSERT INTO gaps(run_id,from_type,from_id,from_version,"
            " to_type,to_id,to_version,reason,detail) VALUES(?,?,?,?,?,?,?,?,?)",
            (run_id,
             from_ref.type if from_ref else None,
             from_ref.id if from_ref else None,
             from_ref.version if from_ref else None,
             to_ref.type, to_ref.id, to_ref.version, reason, detail))
        self.conn.commit()

    def log_fetch(self, run_id, ref, attempt, status=None, error=None):
        self.conn.execute(
            "INSERT INTO fetch_log(run_id,type,id,version,attempt,status,error,ts)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (run_id, ref.type, ref.id, ref.version, attempt, status, error, time.time()))
        self.conn.commit()

    # ---- 查询辅助 ----
    def gaps_of_run(self, run_id):
        return self.conn.execute(
            "SELECT * FROM gaps WHERE run_id=? ORDER BY gap_id", (run_id,)).fetchall()

    def fetch_count(self, ref):
        return self.conn.execute(
            "SELECT COUNT(*) c FROM fetch_log WHERE type=? AND id=? AND version=?",
            (ref.type, ref.id, ref.version)).fetchone()["c"]

    def run(self, run_id):
        return self.conn.execute(
            "SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
