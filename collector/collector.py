"""采集器主体：同时跟踪固定路径上的新旧日志文件，逐条精确一次落盘。

目录约定（均位于结果目录下）：

* ``checkpoint.json``        原子写入的进度检查点
* ``good/<source_id>.jsonl`` 解析成功的记录，按源文件分别追加
* ``bad/<source_id>.jsonl``  完整但无法解析的行，带文件身份和字节偏移
* ``tails/<source_id>.json`` 收到完成标记时仍缺换行的残缺尾行

正确性要点：

1. 按字节读取、按 ``\\n`` 切行；半行留在 :class:`LineReader` 缓冲里等待，
   即使读块切在汉字中间也能由后续字节还原。
2. 每处理完一行：先写输出并 ``fsync``，再把新偏移原子写入检查点。
   崩溃若发生在两者之间，重启时按检查点里记录的输出长度截断输出文件，
   再从旧偏移重读——同一条记录在结果目录里只会保留一份。
3. 轮转期间旧文件仍按其文件身份（dev+inode）跟踪，完成标记到达后
   读出剩余数据、记录残缺尾行并结束跟踪。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import time
from typing import BinaryIO

from .checkpoint import Checkpoint, SourceState, load_checkpoint, save_checkpoint
from .line_reader import LineReader

CHECKPOINT_NAME = "checkpoint.json"
GOOD_DIR = "good"
BAD_DIR = "bad"
TAIL_DIR = "tails"


class Collector:
    def __init__(
        self,
        watch_dir: str,
        active_name: str,
        result_dir: str,
        *,
        marker_suffix: str = ".done",
        poll_interval: float = 0.05,
        read_block: int = 8,
        idle_scans_to_stop: int | None = None,
        crash_after: tuple[str, int] | None = None,
        verbose: bool = True,
    ) -> None:
        self.watch_dir = os.path.abspath(watch_dir)
        self.active_path = os.path.join(self.watch_dir, active_name)
        self.active_name = active_name
        self.result_dir = os.path.abspath(result_dir)
        self.marker_suffix = marker_suffix
        self.poll_interval = poll_interval
        self.read_block = read_block
        self.idle_scans_to_stop = idle_scans_to_stop
        # crash_after = (source_id, 处理该行后的偏移)，用于演示崩溃恢复
        self.crash_after = crash_after
        self.verbose = verbose

        self.good_dir = os.path.join(self.result_dir, GOOD_DIR)
        self.bad_dir = os.path.join(self.result_dir, BAD_DIR)
        self.tail_dir = os.path.join(self.result_dir, TAIL_DIR)
        for d in (self.result_dir, self.good_dir, self.bad_dir, self.tail_dir):
            os.makedirs(d, exist_ok=True)

        self.checkpoint_path = os.path.join(self.result_dir, CHECKPOINT_NAME)
        self.cp: Checkpoint = load_checkpoint(self.checkpoint_path)
        self._readers: dict[str, LineReader] = {}
        self._fds: dict[str, BinaryIO] = {}
        self._stop = False

    # ------------------------------------------------------------------ #
    # 日志
    # ------------------------------------------------------------------ #
    def log(self, msg: str) -> None:
        if self.verbose:
            print(f"[collector] {msg}", flush=True)

    # ------------------------------------------------------------------ #
    # 输出文件：按检查点长度截断后追加，保证精确一次
    # ------------------------------------------------------------------ #
    def _output_path(self, state: SourceState, kind: str) -> str:
        base = {
            "good": self.good_dir,
            "bad": self.bad_dir,
            "tail": self.tail_dir,
        }[kind]
        ext = ".json" if kind == "tail" else ".jsonl"
        return os.path.join(base, f"{state.source_id}{ext}")

    def _repair_output(self, state: SourceState) -> None:
        """重启后把 good/bad 输出截到检查点记录的长度。"""
        good = self._output_path(state, "good")
        if os.path.exists(good):
            self._truncate_to(good, state.good_size)
        bad = self._output_path(state, "bad")
        if os.path.exists(bad):
            self._truncate_to(bad, state.bad_size)

    @staticmethod
    def _truncate_to(path: str, size: int) -> None:
        actual = os.path.getsize(path)
        if actual > size:
            with open(path, "r+b") as fh:
                fh.truncate(size)
                fh.flush()
                os.fsync(fh.fileno())

    def _append_fsync(self, path: str, payload: bytes) -> None:
        with open(path, "ab") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())

    def _save(self) -> None:
        save_checkpoint(self.checkpoint_path, self.cp)

    # ------------------------------------------------------------------ #
    # 目录扫描：按 dev+inode 识别文件身份，登记/更新被跟踪的源
    # ------------------------------------------------------------------ #
    def _scan(self) -> None:
        if not os.path.isdir(self.watch_dir):
            return
        entries: list[os.DirEntry] = list(os.scandir(self.watch_dir))
        seen_keys: set[tuple[int, int]] = set()

        for entry in entries:
            if not entry.is_file(follow_symlinks=False):
                continue
            if entry.name.endswith(self.marker_suffix):
                continue
            st = entry.stat(follow_symlinks=False)
            key = (st.st_dev, st.st_ino)
            seen_keys.add(key)
            existing = self._find_by_key(key)
            full_path = os.path.abspath(entry.path)
            if existing is None:
                sid = self.cp.allocate_source_id()
                state = SourceState(
                    source_id=sid, path=full_path, dev=st.st_dev, inode=st.st_ino
                )
                self.cp.sources[sid] = state
                self._save()
                self.log(f"发现新文件 {entry.name} -> {sid} (inode={st.st_ino})")
            elif existing.path != full_path:
                self.log(f"{existing.source_id} 路径变更: {existing.path} -> {full_path}")
                existing.path = full_path
                self._save()

        # 磁盘上已不存在且未完成的源：关闭句柄，状态保留，等文件重新出现
        for state in list(self.cp.sources.values()):
            if state.finished:
                continue
            key = (state.dev, state.inode)
            if key not in seen_keys:
                self._close_source(state.source_id)

        # 完成标记：旧文件（非当前活动路径）收到标记即结束跟踪
        for entry in entries:
            if not entry.name.endswith(self.marker_suffix):
                continue
            data_name = entry.name[: -len(self.marker_suffix)]
            data_path = os.path.join(self.watch_dir, data_name)
            if os.path.abspath(data_path) == os.path.abspath(self.active_path):
                continue
            target = next(
                (s for s in self.cp.sources.values()
                 if not s.finished and os.path.abspath(s.path) == os.path.abspath(data_path)),
                None,
            )
            if target is not None:
                self._finish_source(target)

    def _find_by_key(self, key: tuple[int, int]) -> SourceState | None:
        for state in self.cp.sources.values():
            if (state.dev, state.inode) == key:
                return state
        return None

    # ------------------------------------------------------------------ #
    # 读取与行处理
    # ------------------------------------------------------------------ #
    def _open_source(self, state: SourceState) -> LineReader:
        sid = state.source_id
        if sid in self._readers:
            return self._readers[sid]
        # 重启恢复：先把可能“已输出但未记账”的字节截掉
        self._repair_output(state)
        fh = open(state.path, "rb")
        fh.seek(state.offset)
        self._fds[sid] = fh
        reader = LineReader(base_offset=state.offset)
        self._readers[sid] = reader
        self.log(
            f"{sid} 打开 {os.path.basename(state.path)}，从偏移 {state.offset} 续读"
        )
        return reader

    def _close_source(self, sid: str) -> None:
        fh = self._fds.pop(sid, None)
        if fh is not None:
            fh.close()
        self._readers.pop(sid, None)

    def _process_source(self, state: SourceState) -> bool:
        """读一轮并处理新数据，返回是否读到了内容。"""
        if not os.path.exists(state.path):
            return False
        reader = self._open_source(state)
        fh = self._fds[state.source_id]
        chunk = fh.read(self.read_block)
        if not chunk:
            return False
        for line, start, end in reader.feed(chunk):
            self._handle_line(state, line, start, end)
        return True

    def _handle_line(
        self, state: SourceState, line: bytes, start: int, end: int
    ) -> None:
        try:
            text = line.decode("utf-8")
            record = json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            envelope = {
                "source_id": state.source_id,
                "path": state.path,
                "line_start_offset": start,
                "line_end_offset": end,
                "raw_b64": _b64(line),
                "error": f"{type(exc).__name__}: {exc}",
            }
            payload = (
                json.dumps(envelope, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            bad_path = self._output_path(state, "bad")
            self._append_fsync(bad_path, payload)
            state.bad_size += len(payload)
            self.log(
                f"{state.source_id} 偏移 {start}-{end} 行无法解析，"
                f"身份与偏移已保留到 bad/（{type(exc).__name__}）"
            )
        else:
            payload = (
                json.dumps(record, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            good_path = self._output_path(state, "good")
            self._append_fsync(good_path, payload)
            state.good_size += len(payload)
            self.log(
                f"{state.source_id} 偏移 {start}-{end} 采集成功: "
                f"{_preview(text)}"
            )

        # 故障注入点：输出已 fsync，但检查点尚未保存（崩溃窗口）
        if self.crash_after is not None:
            sid, offset = self.crash_after
            if state.source_id == sid and end == offset:
                self.log(
                    f"!! 故障注入：{sid} 偏移 {end} 的记录已输出落盘、"
                    "检查点尚未更新，进程退出"
                )
                os._exit(9)

        # 输出落盘之后再推进检查点；offset 始终落在行边界上
        state.offset = end
        self._save()

    def _finish_source(self, state: SourceState) -> None:
        self.log(f"{state.source_id} 收到完成标记 {os.path.basename(state.path)}"
                 f"{self.marker_suffix}")
        # 先把标记到达前最后的字节读完
        while self._process_source(state):
            pass
        reader = self._readers[state.source_id]
        tail = reader.pending
        if tail:
            envelope = {
                "source_id": state.source_id,
                "path": state.path,
                "tail_start_offset": reader.pending_offset,
                "raw_b64": _b64(tail),
                "preview": reader.decode_tail(),
                "note": "完成标记到达时仍缺少换行结尾的残缺尾行",
            }
            tail_path = self._output_path(state, "tail")
            payload = (
                json.dumps(envelope, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
            self._append_fsync(tail_path, payload)
            state.tail_written = True
            self.log(
                f"{state.source_id} 残缺尾行 {len(tail)} 字节 "
                f"(偏移 {reader.pending_offset}) 已记录到 tails/"
            )
        state.offset = reader.pending_offset + len(tail)
        state.finished = True
        self._save()
        self._close_source(state.source_id)
        self.log(f"{state.source_id} 跟踪结束")

    # ------------------------------------------------------------------ #
    # 主循环
    # ------------------------------------------------------------------ #
    def request_stop(self, *_args: object) -> None:
        self._stop = True

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)
        idle_scans = 0
        stop_file = os.path.join(self.result_dir, ".stop")
        while not self._stop:
            self._scan()
            did_work = False
            for state in list(self.cp.sources.values()):
                if state.finished:
                    continue
                if self._process_source(state):
                    did_work = True
                    idle_scans = 0
            if self._stop:
                break
            if did_work:
                idle_scans = 0
            else:
                # 一轮扫描没有读到任何新字节
                idle_scans += 1
                if (
                    self.idle_scans_to_stop is not None
                    and idle_scans >= self.idle_scans_to_stop
                ):
                    self.log("空闲达到阈值，正常退出")
                    break
                if os.path.exists(stop_file):
                    # 停止文件存在时，也要先确认本轮没有任何新数据未处理
                    self.log("检测到停止文件且数据已全部处理，正常退出")
                    break
            time.sleep(self.poll_interval)
        return 0


def _b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode("ascii")


def _preview(text: str, limit: int = 48) -> str:
    text = text.replace("\n", "\\n")
    return text if len(text) <= limit else text[:limit] + "…"


# ---------------------------------------------------------------------- #
# 命令行入口
# ---------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="纸卷检测机 JSONL 日志采集器")
    p.add_argument("--watch-dir", required=True, help="设备日志所在目录")
    p.add_argument("--active-name", required=True, help="固定路径上的活动日志文件名")
    p.add_argument("--result-dir", required=True, help="本地结果目录")
    p.add_argument("--marker-suffix", default=".done", help="完成标记后缀")
    p.add_argument("--poll-interval", type=float, default=0.05)
    p.add_argument("--read-block", type=int, default=65536,
                   help="单次读取块大小（字节），演示时可调小制造切分")
    p.add_argument("--idle-scans-to-stop", type=int, default=None,
                   help="无任何被跟踪文件时连续多少轮扫描后退出")
    p.add_argument("--crash-source", default=None,
                   help="故障注入：在该 source 处理到 --crash-offset 后立即退出")
    p.add_argument("--crash-offset", type=int, default=None,
                   help="故障注入：处理完该行后的字节偏移")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    crash = None
    if args.crash_source and args.crash_offset is not None:
        crash = (args.crash_source, args.crash_offset)
    collector = Collector(
        watch_dir=args.watch_dir,
        active_name=args.active_name,
        result_dir=args.result_dir,
        marker_suffix=args.marker_suffix,
        poll_interval=args.poll_interval,
        read_block=args.read_block,
        idle_scans_to_stop=args.idle_scans_to_stop,
        crash_after=crash,
    )
    return collector.run()


if __name__ == "__main__":
    raise SystemExit(main())
