"""采集进度检查点：每个被跟踪文件一条状态，整文件原子替换。

输出文件（good / bad / tail）的已落盘长度也记录在这里。重启时先按记录长度
截断输出文件，再从记录的读取偏移继续，从而保证“即使记录已输出、进度还没
保存”也不会产生重复记录。
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from typing import Any

CHECKPOINT_VERSION = 1
CHECKPOINT_NAME = "checkpoint.json"


@dataclass
class SourceState:
    """单个被跟踪日志文件的状态。"""

    source_id: str                 # 采集器分配的稳定编号 src-0001
    path: str                      # 当前路径（轮转改名后更新）
    dev: int                       # 设备号 + inode 共同标识文件身份
    inode: int
    offset: int = 0                # 已确认处理到的字节偏移（始终在行边界上）
    finished: bool = False         # 是否已收到完成标记并结束跟踪
    good_size: int = 0             # good 输出文件已落盘字节数
    bad_size: int = 0              # bad 输出文件已落盘字节数
    tail_written: bool = False     # 残缺尾行是否已落盘（完成时一次性写入）

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SourceState":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Checkpoint:
    sources: dict[str, SourceState] = field(default_factory=dict)  # key = source_id
    next_seq: int = 1
    version: int = CHECKPOINT_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "next_seq": self.next_seq,
            "sources": [s.to_dict() for s in self.sources.values()],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Checkpoint":
        cp = cls()
        cp.version = int(data.get("version", CHECKPOINT_VERSION))
        cp.next_seq = int(data.get("next_seq", 1))
        for item in data.get("sources", []):
            st = SourceState.from_dict(item)
            cp.sources[st.source_id] = st
        return cp

    def allocate_source_id(self) -> str:
        sid = f"src-{self.next_seq:04d}"
        self.next_seq += 1
        return sid


def load_checkpoint(path: str) -> Checkpoint:
    if not os.path.exists(path):
        return Checkpoint()
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return Checkpoint.from_dict(data)


def save_checkpoint(path: str, cp: Checkpoint) -> None:
    """同目录临时文件 + fsync + os.replace 原子落盘。"""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".checkpoint.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(cp.to_dict(), fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(directory)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _fsync_dir(directory: str) -> None:
    """fsync 目录，保证 rename 元数据落盘（macOS / Linux 均支持）。"""
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
