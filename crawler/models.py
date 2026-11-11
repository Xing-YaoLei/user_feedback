"""爬虫数据模型与持久化（断点续跑的状态载体）。

状态目录下四个文件：
  state.json           组合状态 + 设备实体（原子替换写入）
  coverage_tree.json   分支覆盖树（嵌套结构，便于人工核查覆盖情况）
  devices.json         去重后的设备实体与归属组合
  events.jsonl         事件流（发现 / 采集 / 空分支 / 失败 / 重试 / 暂停）
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

COMBO_SEP = "|"


def combo_key(region: str, institution: str, dev_type: str) -> str:
    return COMBO_SEP.join((region, institution, dev_type))


def split_key(key: str) -> tuple[str, str, str]:
    region, institution, dev_type = key.split(COMBO_SEP)
    return region, institution, dev_type


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class ComboState:
    status: str = "pending"          # pending | done | empty | failed
    attempts: int = 0
    device_ids: list[str] = field(default_factory=list)
    last_error: str | None = None

    def is_finished(self) -> bool:
        return self.status in ("done", "empty")


@dataclass
class Device:
    id: str
    name: str
    model: str
    manufacturer: str
    sources: list[str] = field(default_factory=list)

    def to_record(self) -> dict[str, Any]:
        return asdict(self)


class CrawlState:
    """内存状态 + 落盘。每个组合处理完立即原子保存，保证可恢复。"""

    def __init__(self, base_url: str, state_dir: str | Path) -> None:
        self.base_url = base_url
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.combos: dict[str, ComboState] = {}
        self.devices: dict[str, Device] = {}
        self.status: str = "running"     # running | paused | done | failed
        self.event_path = self.state_dir / "events.jsonl"

    # -- 事件流（只追加，崩溃也保留历史） ----------------------------------
    def log_event(self, kind: str, **fields: Any) -> None:
        record = {"ts": utc_now(), "kind": kind, **fields}
        with self.event_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    # -- 组合状态 ---------------------------------------------------------
    def ensure_combo(self, key: str) -> ComboState:
        if key not in self.combos:
            self.combos[key] = ComboState()
        return self.combos[key]

    def pending_combos(self) -> list[str]:
        return [k for k, v in self.combos.items() if not v.is_finished()]

    # -- 实体去重 + 归属保留 ----------------------------------------------
    def upsert_device(self, raw: dict[str, Any], source_combo: str) -> Device:
        dev = self.devices.get(raw["id"])
        if dev is None:
            dev = Device(
                id=raw["id"],
                name=raw["name"],
                model=raw["model"],
                manufacturer=raw["manufacturer"],
            )
            self.devices[dev.id] = dev
        if source_combo not in dev.sources:
            dev.sources.append(source_combo)
        return dev

    # -- 覆盖树 -----------------------------------------------------------
    def coverage_tree(self) -> dict[str, Any]:
        tree: dict[str, Any] = {}
        for key, combo in sorted(self.combos.items()):
            region, institution, dev_type = split_key(key)
            region_node = tree.setdefault(region, {})
            inst_node = region_node.setdefault(institution, {})
            inst_node[dev_type] = {
                "status": combo.status,
                "attempts": combo.attempts,
                "device_count": len(combo.device_ids),
                "last_error": combo.last_error,
            }
        return tree

    # -- 持久化 -----------------------------------------------------------
    def save(self) -> None:
        payload = {
            "version": 1,
            "base_url": self.base_url,
            "status": self.status,
            "saved_at": utc_now(),
            "combos": {k: asdict(v) for k, v in sorted(self.combos.items())},
            "devices": {k: v.to_record() for k, v in sorted(self.devices.items())},
        }
        self._atomic_write("state.json", payload)
        self._atomic_write(
            "devices.json",
            {
                "generated_at": utc_now(),
                "device_count": len(self.devices),
                "devices": [v.to_record() for _, v in sorted(self.devices.items())],
            },
        )
        self._atomic_write(
            "coverage_tree.json",
            {"generated_at": utc_now(), "status": self.status,
             "tree": self.coverage_tree()},
        )

    def _atomic_write(self, name: str, payload: Any) -> None:
        target = self.state_dir / name
        fd, tmp_name = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp",
                                        dir=self.state_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)
            os.replace(tmp_name, target)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise

    @classmethod
    def load(cls, state_dir: str | Path) -> "CrawlState | None":
        path = Path(state_dir) / "state.json"
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        state = cls(payload["base_url"], state_dir)
        state.status = "running"   # 重新启动后回到 running；结束时再更新
        for key, raw in payload.get("combos", {}).items():
            state.combos[key] = ComboState(**raw)
        for dev_id, raw in payload.get("devices", {}).items():
            state.devices[dev_id] = Device(**raw)
        return state

    def finished_combo_count(self) -> int:
        return sum(1 for c in self.combos.values() if c.is_finished())
