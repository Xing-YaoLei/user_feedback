"""采集器端到端测试：轮转跟踪、坏行隔离、完成标记、重启精确一次。"""

import base64
import json
import os
import tempfile
import unittest

from collector.collector import Collector
from collector.checkpoint import load_checkpoint
from simulator.machine_sim import PaperRollMachine, Record


def make_record(seq: int) -> Record:
    return Record(seq, {"seq": seq, "msg": f"卷筒纸检测-{seq}号 缺陷=皱褶"})


def read_jsonl(path: str) -> list:
    if not os.path.exists(path):
        return []
    with open(path, "rb") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def run_collector(watch: str, result: str, block: int = 3) -> None:
    """采集器处理完当前所有在盘数据后退出（停止文件提前放好即可）。"""
    stop_file = os.path.join(result, ".stop")
    if os.path.exists(stop_file):
        os.unlink(stop_file)
    os.makedirs(result, exist_ok=True)
    open(stop_file, "wb").close()
    c = Collector(
        watch_dir=watch,
        active_name="inspection.log",
        result_dir=result,
        read_block=block,
        poll_interval=0.01,
        verbose=False,
    )
    c.run()


class TestCollectorFlow(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.watch = os.path.join(self.root, "watch")
        self.result = os.path.join(self.root, "result")
        self.machine = PaperRollMachine(self.watch)
        self.expected: list[dict] = []

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, seq: int) -> bytes:
        rec = make_record(seq)
        line = self.machine.write_record(rec)
        self.expected.append(rec.payload)
        return line

    def test_rotation_bad_line_marker_and_restart(self) -> None:
        # 活动文件：两条好记录 + 一条坏行
        self._write(1)
        self._write(2)
        self.machine.write_bad_line('{"seq": 99, "broken":'.encode("utf-8"))

        # 轮转：旧文件改名后又收到两条记录，随后放出完成标记
        old_path = self.machine.rotate()
        rec3 = make_record(3)
        rec4 = make_record(4)
        self.machine.append_to_rotated(old_path, rec3)
        self.machine.append_to_rotated(old_path, rec4)
        self.expected.extend([rec3.payload, rec4.payload])
        self.machine.release_marker(old_path)

        # 新活动文件再写两条
        self._write(5)
        self._write(6)

        run_collector(self.watch, self.result, block=3)

        # 两个源文件：轮转后的旧文件已完成，新活动文件仍在跟踪
        cp = load_checkpoint(os.path.join(self.result, "checkpoint.json"))
        states = list(cp.sources.values())
        self.assertEqual(len(states), 2)
        old_state = next(s for s in states if s.finished)
        active_state = next(s for s in states if not s.finished)

        good = []
        for st in states:
            good.extend(read_jsonl(os.path.join(self.result, "good", f"{st.source_id}.jsonl")))
        # 输出按源文件分组，顺序与时间线不同，比较内容多重集即可
        self.assertEqual(
            sorted(good, key=lambda r: r["seq"]),
            sorted(self.expected, key=lambda r: r["seq"]),
        )

        # 坏行写在轮转前的活动文件里，随改名成为旧文件（即已完成的那个源）
        bad_src_old = read_jsonl(
            os.path.join(self.result, "bad", f"{old_state.source_id}.jsonl")
        )
        bad_src_active = read_jsonl(
            os.path.join(self.result, "bad", f"{active_state.source_id}.jsonl")
        )
        self.assertEqual(len(bad_src_active), 0)
        self.assertEqual(len(bad_src_old), 1)
        entry = bad_src_old[0]
        self.assertEqual(entry["source_id"], old_state.source_id)
        self.assertIn("line_start_offset", entry)
        self.assertEqual(
            base64.b64decode(entry["raw_b64"]), b'{"seq": 99, "broken":'
        )

        # 没有残缺尾行
        self.assertFalse(any(os.scandir(os.path.join(self.result, "tails"))))

        # 再跑一次：无新增内容，结果保持不变（幂等重启）
        run_collector(self.watch, self.result, block=3)
        good2 = []
        cp = load_checkpoint(os.path.join(self.result, "checkpoint.json"))
        for st in cp.sources.values():
            good2.extend(
                read_jsonl(os.path.join(self.result, "good", f"{st.source_id}.jsonl"))
            )
        self.assertEqual(
            sorted(good2, key=lambda r: r["seq"]),
            sorted(self.expected, key=lambda r: r["seq"]),
        )

    def test_exactly_once_after_output_without_checkpoint(self) -> None:
        """模拟“记录已输出、检查点还没保存”的崩溃窗口。"""
        for seq in range(1, 5):
            self._write(seq)
        run_collector(self.watch, self.result, block=2)

        cp_path = os.path.join(self.result, "checkpoint.json")
        cp = load_checkpoint(cp_path)
        st = cp.sources["src-0001"]
        good_path = os.path.join(self.result, "good", "src-0001.jsonl")
        with open(good_path, "rb") as fh:
            content = fh.read()
        last_line = content.split(b"\n")[-2] + b"\n"

        # 回退检查点：假装最后一行的输出没有记账（崩溃发生在 fsync 输出之后、
        # 保存检查点之前）
        st.offset -= len(last_line)
        st.good_size -= len(last_line)
        from collector.checkpoint import save_checkpoint

        save_checkpoint(cp_path, cp)

        # 重启：输出先被截到 good_size（最后一行被移除），再从旧偏移重读
        run_collector(self.watch, self.result, block=2)
        good = read_jsonl(good_path)
        self.assertEqual(good, self.expected)  # 恰好一份，无重复

    def test_dangling_tail_recorded_on_marker(self) -> None:
        self._write(1)
        old_path = self.machine.rotate()
        self.machine.append_to_rotated(old_path, make_record(2))
        # 旧文件最后是一条没有换行的半行，且切在汉字中间
        partial = '{"seq":3,"msg":"半行卷筒'.encode("utf-8")
        self.machine.append_raw_to_rotated(old_path, partial[:-1])
        self.machine.release_marker(old_path)

        run_collector(self.watch, self.result, block=4)

        cp = load_checkpoint(os.path.join(self.result, "checkpoint.json"))
        finished = [s for s in cp.sources.values() if s.finished]
        self.assertEqual(len(finished), 1)
        st = finished[0]
        tail_files = os.listdir(os.path.join(self.result, "tails"))
        self.assertEqual(tail_files, [f"{st.source_id}.json"])
        with open(
            os.path.join(self.result, "tails", f"{st.source_id}.json"),
            encoding="utf-8",
        ) as fh:
            envelope = json.load(fh)
        self.assertEqual(base64.b64decode(envelope["raw_b64"]), partial[:-1])
        self.assertEqual(envelope["tail_start_offset"], st.offset - len(partial[:-1]))

    def test_half_line_survives_restart_in_active_file(self) -> None:
        self._write(1)
        # 活动文件里写半行（无换行），采集器读到后必须滞留等待
        self.machine.write_raw('{"seq":2,"msg":"等待补齐'.encode("utf-8"))
        run_collector(self.watch, self.result, block=5)
        good = read_jsonl(os.path.join(self.result, "good", "src-0001.jsonl"))
        self.assertEqual([r["seq"] for r in good], [1])

        # 重启后补齐剩余字节和换行，半行被还原成完整记录，且只有一份
        run_collector(self.watch, self.result, block=5)  # 重启时半行仍不完整
        self.machine.write_raw('的尾字"}\n'.encode("utf-8"))
        run_collector(self.watch, self.result, block=5)

        good = read_jsonl(os.path.join(self.result, "good", "src-0001.jsonl"))
        self.assertEqual([r["seq"] for r in good], [1, 2])
        self.assertEqual(good[1]["msg"], "等待补齐的尾字")

    def test_crash_injection_exits_and_recovery_is_exactly_once(self) -> None:
        """采集器内置故障注入：输出 fsync 后、检查点保存前 os._exit(9)。

        os._exit 会终结整个解释器，因此故障进程必须是子进程。
        """
        import subprocess
        import sys

        lines = [self._write(seq) for seq in range(1, 4)]
        crash_offset = len(lines[0]) + len(lines[1])
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cmd = [
            sys.executable, "-I", os.path.join(root, "run_collector.py"),
            "--watch-dir", self.watch,
            "--active-name", "inspection.log",
            "--result-dir", self.result,
            "--read-block", "2",
            "--poll-interval", "0.01",
            "--crash-source", "src-0001",
            "--crash-offset", str(crash_offset),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        self.assertEqual(proc.returncode, 9)

        # 检查点停在 seq=2 之前，但 good/ 已含 seq=1、seq=2 两行
        cp = load_checkpoint(os.path.join(self.result, "checkpoint.json"))
        st = cp.sources["src-0001"]
        self.assertEqual(st.offset, len(lines[0]))
        good_path = os.path.join(self.result, "good", "src-0001.jsonl")
        self.assertGreater(os.path.getsize(good_path), st.good_size)

        # 不带故障注入重启：截断 + 重读，三行各一份
        run_collector(self.watch, self.result, block=2)
        good = read_jsonl(good_path)
        self.assertEqual([r["seq"] for r in good], [1, 2, 3])
        cp = load_checkpoint(os.path.join(self.result, "checkpoint.json"))
        self.assertEqual(
            os.path.getsize(good_path), cp.sources["src-0001"].good_size
        )


if __name__ == "__main__":
    unittest.main()
