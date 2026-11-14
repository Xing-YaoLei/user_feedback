"""纸卷检测机日志写入端模拟。

行为与题目描述一致：

* 日志始终写到固定路径 ``<dir>/<active_name>``；
* 轮转时先把旧文件改名（``<name>.1``、``<name>.2`` …），再在原路径建新文件；
* 改名后的旧文件可能继续收到几条记录；
* 设备关闭旧文件后，放出同名完成标记 ``<旧文件名><suffix>``。

另提供 :meth:`write_raw`，允许按任意字节片段写入，用来制造
“读块切在汉字中间”和“半行”场景。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Record:
    seq: int
    payload: dict


class PaperRollMachine:
    def __init__(
        self,
        directory: str,
        active_name: str = "inspection.log",
        marker_suffix: str = ".done",
    ) -> None:
        self.directory = os.path.abspath(directory)
        self.active_name = active_name
        self.marker_suffix = marker_suffix
        os.makedirs(self.directory, exist_ok=True)
        self.active_path = os.path.join(self.directory, active_name)
        self._rotation = 0
        self._fh = open(self.active_path, "ab", buffering=0)  # 无缓冲，fsync 可控

    # ------------------------------------------------------------------ #
    def _active_fh(self):
        if self._fh is None:
            self._fh = open(self.active_path, "ab", buffering=0)
        return self._fh

    def write_record(self, record: Record) -> bytes:
        """追加一条完整 JSONL 记录，返回写入的 UTF-8 字节。"""
        line = (json.dumps(record.payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.write_raw(line)
        return line

    def write_raw(self, data: bytes) -> None:
        """按给定字节原样写入活动文件（可切开汉字、可只写半行）。"""
        fh = self._active_fh()
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())

    # ------------------------------------------------------------------ #
    def rotate(self) -> str:
        """先改名旧文件，再在原路径创建新文件，返回旧文件的新路径。"""
        self._fh.flush()
        os.fsync(self._fh.fileno())
        self._fh.close()
        self._fh = None
        self._rotation += 1
        renamed = f"{self.active_name}.{self._rotation}"
        old_path = os.path.join(self.directory, renamed)
        os.rename(self.active_path, old_path)
        # 原路径立刻出现一个全新的 inode
        self._fh = open(self.active_path, "ab", buffering=0)
        return old_path

    def append_to_rotated(self, path: str, record: Record) -> bytes:
        """改名后的旧文件在关闭前又收到几条记录。"""
        line = (json.dumps(record.payload, ensure_ascii=False) + "\n").encode("utf-8")
        with open(path, "ab", buffering=0) as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
        return line

    def append_raw_to_rotated(self, path: str, data: bytes) -> None:
        with open(path, "ab", buffering=0) as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())

    def release_marker(self, path: str) -> str:
        """设备关闭旧文件后放出同名完成标记。"""
        marker = path + self.marker_suffix
        with open(marker, "wb", buffering=0) as fh:
            fh.write(b"closed\n")
            fh.flush()
            os.fsync(fh.fileno())
        return marker

    def write_bad_line(self, raw: bytes) -> None:
        """写一条有换行结尾但无法解析的行。"""
        if not raw.endswith(b"\n"):
            raw += b"\n"
        self.write_raw(raw)

    def close(self) -> None:
        if self._fh is not None:
            self._fh.flush()
            os.fsync(self._fh.fileno())
            self._fh.close()
            self._fh = None
