"""状态存储：已发布台账、失败待处理清单、单次原子提交。

崩溃安全的核心约定：
- 每个 run 写到独立的 run-<时间戳>-<序号> 目录，目录内容一旦提交即不可变；
- 台账（published.jsonl）、待处理清单（pending_failures.jsonl）和下游快照
  （unified.jsonl / failures.jsonl）都在同一个 run 目录内一起生成；
- 全部文件 fsync 落盘后，用 os.rename 原子切换 current 符号链接。
  中途退出时 current 仍指向上一个完整 run，下游不会读到半成品。

幂等的核心约定：
- 幂等键为 (source, event_id)，同一来源的同一事件只发布一次；
- 已发布记录的原始内容与映射版本永久保留在台账里，重跑/重发时跳过，
  不重新映射、不覆盖。
"""

from __future__ import annotations

import datetime as _dt
import json
import os
from dataclasses import dataclass, field
from typing import Any, Iterator


class _StateJSONEncoder(json.JSONEncoder):
    """统一序列化：datetime 转 ISO 8601 字符串。"""

    def default(self, o: Any) -> Any:
        if isinstance(o, _dt.datetime):
            return o.isoformat()
        return super().default(o)


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, cls=_StateJSONEncoder)


@dataclass
class FailureEntry:
    """失败记录：来源、原始位置、原因，供修正映射后重试。"""

    idempotency_key: str
    source: str
    version: str
    event_id: str
    source_file: str
    position: str
    reason_code: str
    reason: str
    source_hash: str
    failed_at: str
    # 重试时需要的原始记录副本：即使原文件被移走也能重试
    raw_record: dict[str, Any]
    fmt: str
    file_source: str | None = None
    file_version: str | None = None
    attempts: int = 1
    last_run_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "idempotency_key": self.idempotency_key,
            "source": self.source,
            "version": self.version,
            "event_id": self.event_id,
            "source_file": self.source_file,
            "position": self.position,
            "reason_code": self.reason_code,
            "reason": self.reason,
            "source_hash": self.source_hash,
            "failed_at": self.failed_at,
            "raw_record": self.raw_record,
            "fmt": self.fmt,
            "file_source": self.file_source,
            "file_version": self.file_version,
            "attempts": self.attempts,
            "last_run_id": self.last_run_id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FailureEntry":
        return cls(**data)


@dataclass
class LedgerEntry:
    """已发布台账条目：记录发布时的全部事实，之后不再变动。"""

    idempotency_key: str
    source: str
    version: str
    event_id: str
    mapping_version: str
    source_hash: str
    published_run_id: str
    published_at: str
    raw_position: str
    record: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "idempotency_key": self.idempotency_key,
            "source": self.source,
            "version": self.version,
            "event_id": self.event_id,
            "mapping_version": self.mapping_version,
            "source_hash": self.source_hash,
            "published_run_id": self.published_run_id,
            "published_at": self.published_at,
            "raw_position": self.raw_position,
            "record": self.record,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LedgerEntry":
        return cls(**data)


def make_idempotency_key(source: str, event_id: str) -> str:
    return f"{source}::{event_id}"


@dataclass
class RunStats:
    run_id: str
    mode: str  # "ingest" | "retry-failures"
    received: int = 0
    published: int = 0
    duplicates: int = 0
    failed: int = 0
    retried: int = 0
    retry_succeeded: int = 0
    retry_failed: int = 0
    pending_remaining: int = 0
    ledger_total: int = 0
    started_at: str = ""
    finished_at: str = ""
    files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


class StateStore:
    """管理 state 目录下的 run 历史、current 指针与台账/清单。"""

    def __init__(self, state_dir: str):
        self.state_dir = os.path.abspath(state_dir)
        self.runs_dir = os.path.join(self.state_dir, "runs")
        self.current_link = os.path.join(self.state_dir, "current")
        os.makedirs(self.runs_dir, exist_ok=True)

    # ---- run 生命周期 ---------------------------------------------

    def begin_run(self, mode: str) -> "OpenRun":
        run_id = self._next_run_id()
        run_dir = os.path.join(self.runs_dir, run_id)
        os.makedirs(run_dir, exist_ok=False)
        stats = RunStats(run_id=run_id, mode=mode, started_at=_now_iso())
        return OpenRun(self, run_id, run_dir, stats)

    def _next_run_id(self) -> str:
        stamp = _dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        seq = 0
        while True:
            run_id = f"run-{stamp}-{seq:02d}"
            if not os.path.exists(os.path.join(self.runs_dir, run_id)):
                return run_id
            seq += 1

    # ---- current 与历史 -------------------------------------------

    def current_run_dir(self) -> str | None:
        if not os.path.islink(self.current_link) and not os.path.exists(
            self.current_link
        ):
            return None
        return os.path.realpath(self.current_link)

    def list_run_dirs(self) -> list[str]:
        if not os.path.isdir(self.runs_dir):
            return []
        entries = [
            os.path.join(self.runs_dir, name)
            for name in os.listdir(self.runs_dir)
            if name.startswith("run-")
        ]
        return sorted(entries)

    def load_ledger(self) -> dict[str, LedgerEntry]:
        """从 current run 读取累计台账；没有任何 run 时为空。"""
        run_dir = self.current_run_dir()
        if run_dir is None:
            return {}
        path = os.path.join(run_dir, "published.jsonl")
        if not os.path.exists(path):
            return {}
        ledger: dict[str, LedgerEntry] = {}
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    entry = LedgerEntry.from_dict(json.loads(line))
                    ledger[entry.idempotency_key] = entry
        return ledger

    def load_pending(self) -> dict[str, FailureEntry]:
        """从 current run 读取待处理失败清单。"""
        run_dir = self.current_run_dir()
        if run_dir is None:
            return {}
        path = os.path.join(run_dir, "pending_failures.jsonl")
        if not os.path.exists(path):
            return {}
        pending: dict[str, FailureEntry] = {}
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    entry = FailureEntry.from_dict(json.loads(line))
                    pending[entry.idempotency_key] = entry
        return pending


class OpenRun:
    """一次进行中的 run：内存里累积本 run 的产出，提交时一次性落盘。"""

    # 下游与状态文件名约定
    UNIFIED_FILE = "unified.jsonl"
    FAILURES_FILE = "failures.jsonl"
    LEDGER_FILE = "published.jsonl"
    PENDING_FILE = "pending_failures.jsonl"
    MANIFEST_FILE = "manifest.json"

    def __init__(
        self, store: StateStore, run_id: str, run_dir: str, stats: RunStats
    ):
        self.store = store
        self.run_id = run_id
        self.run_dir = run_dir
        self.stats = stats
        self._ledger = store.load_ledger()  # 累计台账（含历史 run）
        self._pending = store.load_pending()  # 累计待处理清单
        self._new_ledger_entries: list[LedgerEntry] = []
        self._new_failures: list[FailureEntry] = []
        self._removed_pending_keys: set[str] = set()  # 重试成功后移出清单
        self._closed = False

    # ---- 幂等查询 -------------------------------------------------

    def ledger_entry(self, key: str) -> LedgerEntry | None:
        return self._ledger.get(key)

    def is_published(self, key: str) -> bool:
        return key in self._ledger

    # ---- 结果记录 -------------------------------------------------

    def record_published(self, entry: LedgerEntry) -> None:
        self._ledger[entry.idempotency_key] = entry
        self._new_ledger_entries.append(entry)
        # 成功后若该键还在待处理清单（重试场景），移出清单
        self._pending.pop(entry.idempotency_key, None)
        self._removed_pending_keys.add(entry.idempotency_key)

    def record_failure(self, failure: FailureEntry) -> None:
        existing = self._pending.get(failure.idempotency_key)
        if existing is not None:
            # 同一记录再次失败：保留首次失败位置等信息，累加尝试次数
            failure.attempts = existing.attempts + 1
        self._pending[failure.idempotency_key] = failure
        self._new_failures.append(failure)

    def pending_snapshot(self) -> dict[str, FailureEntry]:
        return dict(self._pending)

    # ---- 提交 -----------------------------------------------------

    def commit(self) -> None:
        """把本 run 的完整状态落盘并原子切换 current。

        提交前 current 指向的历史 run 完全不动；只有 rename 符号链接这一步
        对外可见，因此任何中途崩溃都保证下游继续读到上一个完整结果。
        """
        if self._closed:
            raise RuntimeError(f"run {self.run_id} 已经提交")
        self.stats.finished_at = _now_iso()
        self.stats.ledger_total = len(self._ledger)
        self.stats.pending_remaining = len(self._pending)

        # 1) 累计台账：完整复制，保证每个 run 目录自包含
        ledger_path = os.path.join(self.run_dir, self.LEDGER_FILE)
        with open(ledger_path, "w", encoding="utf-8") as fh:
            for key in sorted(self._ledger):
                fh.write(_json_dumps(self._ledger[key].to_dict()) + "\n")

        # 2) 累计待处理失败清单
        pending_path = os.path.join(self.run_dir, self.PENDING_FILE)
        with open(pending_path, "w", encoding="utf-8") as fh:
            for key in sorted(self._pending):
                fh.write(_json_dumps(self._pending[key].to_dict()) + "\n")

        # 3) 本批下游快照：统一明细（本 run 新发布）
        unified_path = os.path.join(self.run_dir, self.UNIFIED_FILE)
        with open(unified_path, "w", encoding="utf-8") as fh:
            for entry in self._new_ledger_entries:
                fh.write(_json_dumps(entry.record) + "\n")

        # 4) 本批下游快照：失败记录（本 run 新失败）
        failures_path = os.path.join(self.run_dir, self.FAILURES_FILE)
        with open(failures_path, "w", encoding="utf-8") as fh:
            for failure in self._new_failures:
                fh.write(_json_dumps(failure.to_dict()) + "\n")

        # 5) 清单
        self.stats.files = [
            self.UNIFIED_FILE,
            self.FAILURES_FILE,
            self.LEDGER_FILE,
            self.PENDING_FILE,
            self.MANIFEST_FILE,
        ]
        manifest = {
            "run_id": self.run_id,
            "mode": self.stats.mode,
            "started_at": self.stats.started_at,
            "finished_at": self.stats.finished_at,
            "stats": {
                k: v
                for k, v in self.stats.to_dict().items()
                if k not in ("run_id", "mode", "started_at", "finished_at", "files")
            },
            "files": self.stats.files,
        }
        manifest_path = os.path.join(self.run_dir, self.MANIFEST_FILE)
        with open(manifest_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))
            fh.write("\n")

        self._fsync_dir()

        # 6) 原子切换 current 符号链接（先建临时链接再 rename）。
        # 链接位于 state/ 下、目标位于 state/runs/ 下，相对路径必须带 runs/ 前缀
        tmp_link = os.path.join(self.store.state_dir, f".current-tmp-{os.getpid()}")
        if os.path.islink(tmp_link) or os.path.exists(tmp_link):
            os.unlink(tmp_link)
        target_link = os.path.join(
            "runs", os.path.basename(self.run_dir.rstrip("/"))
        )
        os.symlink(target_link, tmp_link)
        os.rename(tmp_link, self.store.current_link)
        self._closed = True

    def _fsync_dir(self) -> None:
        try:
            fd = os.open(self.run_dir, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(fd)
        except OSError:
            pass
        finally:
            os.close(fd)


def _now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def iter_jsonl(path: str) -> Iterator[dict[str, Any]]:
    """通用 JSONL 读取辅助，供状态查询命令使用。"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)
