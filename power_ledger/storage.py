"""账本存储：目录布局、原子写入、版本与预览、确认时的并发保护。

布局::

    ledger/
      meta.json            当前规则版本、计数器、数据源摘要
      versions/<id>.json   不可变规则版本（含 content_hash）
      readings/<day>.json  该业务日的原始读数（预览/确认的比较基线）
      ledger/<day>.json    已发布结果（确认后才替换）
      previews/<id>.json   预览（pending / confirmed / rejected）
"""

import hashlib
import os
import tempfile
from pathlib import Path

from .errors import LedgerError
from .jsonutil import content_hash, dump_json
from .timeutil import iso


# ---------------------------------------------------------------- 原子写入

def atomic_write(path, text):
    """临时文件 + 同目录 rename，中断不会留下半个结果文件。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def write_json(path, obj):
    atomic_write(path, dump_json(obj))


def read_json(path):
    import json

    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def file_sha256(path):
    """已落盘文件的字节哈希，用于确认时的并发保护比对。"""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


# ---------------------------------------------------------------- 账本对象

class Store:
    """以目录为单位的账本句柄。"""

    def __init__(self, root):
        self.root = Path(root)
        self.meta_path = self.root / "meta.json"
        self.versions_dir = self.root / "versions"
        self.readings_dir = self.root / "readings"
        self.ledger_dir = self.root / "ledger"
        self.previews_dir = self.root / "previews"

    # ---- 初始化 --------------------------------------------------------

    def init_empty(self, source_summary):
        if self.root.exists() and any(self.root.iterdir()):
            raise LedgerError(f"账本目录 {self.root} 已存在且非空，拒绝覆盖")
        for d in (self.versions_dir, self.readings_dir, self.ledger_dir, self.previews_dir):
            d.mkdir(parents=True, exist_ok=True)
        meta = {
            "current_version": None,
            "version_seq": 0,
            "preview_seq": 0,
            "source_summary": source_summary,
            "days": [],
        }
        write_json(self.meta_path, meta)
        return meta

    def exists(self):
        return self.meta_path.exists()

    def require_exists(self):
        if not self.exists():
            raise LedgerError(f"账本 {self.root} 尚未初始化，请先运行 init")

    # ---- meta ----------------------------------------------------------

    def meta(self):
        self.require_exists()
        return read_json(self.meta_path)

    def save_meta(self, meta):
        write_json(self.meta_path, meta)

    # ---- 规则版本 ------------------------------------------------------

    def version_path(self, version_id):
        return self.versions_dir / f"{version_id}.json"

    def write_version(self, version):
        path = self.version_path(version["version"])
        if path.exists():
            raise LedgerError(f"规则版本 {version['version']} 已存在，版本不可变")
        write_json(path, version)

    def load_version(self, version_id):
        path = self.version_path(version_id)
        if not path.exists():
            raise LedgerError(f"规则版本 {version_id} 不存在")
        return read_json(path)

    def list_versions(self):
        if not self.versions_dir.exists():
            return []
        items = []
        for p in sorted(self.versions_dir.glob("*.json")):
            items.append(read_json(p))
        items.sort(key=lambda v: v["version"])
        return items

    # ---- 原始读数（按业务日） ------------------------------------------

    def readings_path(self, day):
        return self.readings_dir / f"{day}.json"

    def ledger_path(self, day):
        return self.ledger_dir / f"{day}.json"

    def save_readings_day(self, day, payload):
        write_json(self.readings_path(day), payload)

    def load_readings_day(self, day):
        return read_json(self.readings_path(day))

    def save_ledger_day(self, day, payload):
        write_json(self.ledger_path(day), payload)

    def load_ledger_day(self, day):
        return read_json(self.ledger_path(day))

    # ---- 预览 ----------------------------------------------------------

    def preview_path(self, preview_id):
        return self.previews_dir / f"{preview_id}.json"

    def write_preview(self, preview):
        write_json(self.preview_path(preview["preview_id"]), preview)

    def load_preview(self, preview_id):
        path = self.preview_path(f"{preview_id}")
        if not path.exists():
            raise LedgerError(f"预览 {preview_id} 不存在")
        return read_json(path)

    def list_previews(self):
        if not self.previews_dir.exists():
            return []
        items = [read_json(p) for p in sorted(self.previews_dir.glob("*.json"))]
        items.sort(key=lambda p: p["preview_id"])
        return items

    # ---- 并发保护：记录与复核基线哈希 ----------------------------------

    def hash_day_inputs(self, day):
        """某业务日原始读数 + 已发布账本（若存在）的联合哈希。"""
        hashes = {"readings": file_sha256(self.readings_path(day))}
        ledger_path = self.ledger_path(day)
        hashes["ledger"] = file_sha256(ledger_path) if ledger_path.exists() else None
        return hashes

    def verify_day_hashes(self, days, baseline):
        """复核预览时记录的基线哈希；任何文件变化都返回差异明细。"""
        mismatches = []
        for day in days:
            current = self.hash_day_inputs(day)
            expected = baseline.get(day)
            if expected is None:
                mismatches.append({"day": day, "reason": "预览中没有该日期的基线哈希"})
                continue
            if current["readings"] != expected["readings"]:
                mismatches.append({"day": day, "reason": "原始读数在预览后发生变化"})
            if current["ledger"] != expected["ledger"]:
                mismatches.append({"day": day, "reason": "已发布结果在预览后发生变化"})
        return mismatches


def make_version(seq, attr_rules, tariff_rules, source_summary, created_from):
    """构造不可变规则版本对象。"""
    from .rules import hash_rules, rules_payload

    payload = rules_payload(attr_rules, tariff_rules)
    return {
        "version": seq,
        "created_from": created_from,
        "content_hash": hash_rules(attr_rules, tariff_rules),
        "rules": payload,
        "source_summary": source_summary,
    }


def source_summary(readings_path, attr_path, tariff_path, mode, readings):
    """数据源摘要，写入 meta 与版本，便于追溯输入文件。"""
    return {
        "readings_csv": str(readings_path),
        "attribution_csv": str(attr_path),
        "tariff_csv": str(tariff_path),
        "readings_mode": mode,
        "reading_rows": len(readings),
        "reading_time_range": [iso(min(r["ts"] for r in readings)), iso(max(r["ts"] for r in readings))],
        "meter_count": len({r["meter_id"] for r in readings}),
    }
