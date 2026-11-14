#!/usr/bin/env python3
"""可重复的本地演示：轮转、半行、故障注入崩溃与重启续读。

用法：python3 -I demo.py

脚本在系统临时目录下建立一套全新的 watch/result 目录，按固定剧本驱动
设备模拟器和采集器子进程，最后自动断言所有正确性要求并打印结果。
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from collector.checkpoint import load_checkpoint  # noqa: E402
from simulator.machine_sim import PaperRollMachine, Record  # noqa: E402

ACTIVE_NAME = "inspection.log"
MARKER = ".done"
BLOCK = 4  # 极小读块，制造“读块切在汉字中间”的场景


def banner(title: str) -> None:
    print("\n" + "=" * 72)
    print(f"  {title}")
    print("=" * 72, flush=True)


def start_collector(watch: str, result: str, *,
                    crash: tuple[str, int] | None = None) -> subprocess.Popen:
    cmd = [
        sys.executable, "-I", os.path.join(ROOT, "run_collector.py"),
        "--watch-dir", watch,
        "--active-name", ACTIVE_NAME,
        "--result-dir", result,
        "--read-block", str(BLOCK),
        "--poll-interval", "0.02",
    ]
    if crash:
        cmd += ["--crash-source", crash[0], "--crash-offset", str(crash[1])]
    # 每次启动都是新的生命周期：清掉上一次的停止文件
    stop_file = os.path.join(result, ".stop")
    if os.path.exists(stop_file):
        os.unlink(stop_file)
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )

    def _pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            print("    " + line.rstrip())

    threading.Thread(target=_pump, daemon=True).start()
    return proc


def wait_for(predicate, desc: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise TimeoutError(f"等待条件超时: {desc}")


def good_records(result: str) -> list[dict]:
    out: list[dict] = []
    good_dir = os.path.join(result, "good")
    if not os.path.isdir(good_dir):
        return out
    for name in sorted(os.listdir(good_dir)):
        with open(os.path.join(good_dir, name), "rb") as fh:
            out.extend(json.loads(line) for line in fh if line.strip())
    return out


def bad_entries(result: str) -> list[dict]:
    out: list[dict] = []
    bad_dir = os.path.join(result, "bad")
    if not os.path.isdir(bad_dir):
        return out
    for name in sorted(os.listdir(bad_dir)):
        with open(os.path.join(bad_dir, name), "rb") as fh:
            out.extend(json.loads(line) for line in fh if line.strip())
    return out


def tail_files(result: str) -> list[str]:
    tail_dir = os.path.join(result, "tails")
    return sorted(os.listdir(tail_dir)) if os.path.isdir(tail_dir) else []


def stop_collector(proc: subprocess.Popen, result: str) -> None:
    """通过停止文件让采集器处理完在盘数据后干净退出。"""
    with open(os.path.join(result, ".stop"), "wb"):
        pass
    proc.wait(timeout=15)


def main() -> int:
    work = tempfile.mkdtemp(prefix="pro38-demo-")
    watch = os.path.join(work, "watch")
    result = os.path.join(work, "result")
    print(f"演示工作目录: {work}")

    machine = PaperRollMachine(watch, active_name=ACTIVE_NAME, marker_suffix=MARKER)
    expected: list[dict] = []
    expected_bad = 0

    def emit(seq: int, msg: str) -> bytes:
        rec = Record(seq, {"seq": seq, "msg": msg, "device": "纸卷检测机A"})
        line = machine.write_record(rec)
        expected.append(rec.payload)
        return line

    # --------------------------------------------------------------- #
    banner("阶段 1：启动采集器，写正常记录（含中文，读块仅 4 字节）")
    proc = start_collector(watch, result)
    time.sleep(0.3)
    emit(1, "卷筒纸表面正常")
    emit(2, "卷筒纸边缘皱褶-轻微")
    wait_for(
        lambda: len(good_records(result)) == 2,
        "前两条记录被采集",
    )
    print(f"  -> 已采集 {len(good_records(result))} 条，检查点已逐行落盘")

    # --------------------------------------------------------------- #
    banner("阶段 2：轮转——旧文件改名，原路径建新文件，旧文件继续写入")
    old1 = machine.rotate()
    rec3 = Record(3, {"seq": 3, "msg": "改名后旧文件又写入", "device": "纸卷检测机A"})
    machine.append_to_rotated(old1, rec3)
    rec4 = Record(4, {"seq": 4, "msg": "旧文件关闭前最后一条", "device": "纸卷检测机A"})
    machine.append_to_rotated(old1, rec4)
    expected.extend([rec3.payload, rec4.payload])
    # 新活动文件（新 inode）立刻开始写
    emit(5, "新活动文件首条记录")
    wait_for(lambda: len(good_records(result)) == 5, "新旧两个文件同时被跟踪采集")

    # --------------------------------------------------------------- #
    banner("阶段 3：坏行——有换行结尾但无法解析，保留身份与偏移，后续照常")
    bad_line = '{"seq": 42, "defect": "撕裂", "broken":'.encode("utf-8")
    machine.write_bad_line(bad_line)
    expected_bad += 1
    emit(6, "坏行之后的正常记录仍被采集")
    wait_for(lambda: len(bad_entries(result)) == 1, "坏行进入 bad/")
    wait_for(lambda: len(good_records(result)) == 6, "坏行后的好记录照常进入 good/")
    bad = bad_entries(result)[0]
    print(f"  -> 坏行来源 {bad['source_id']}，行偏移 {bad['line_start_offset']}-"
          f"{bad['line_end_offset']}，错误: {bad['error'].split(':')[0]}")

    # --------------------------------------------------------------- #
    banner("阶段 4：旧文件放出完成标记，残缺尾行（切在汉字中间）被记录")
    partial_text = '{"seq":7,"msg":"残缺尾行卷筒'
    partial = partial_text.encode("utf-8")
    machine.append_raw_to_rotated(old1, partial[:-1])  # 故意切掉“筒”字最后一个字节
    marker = machine.release_marker(old1)
    wait_for(lambda: len(tail_files(result)) == 1, "完成标记触发尾行落盘")
    tf = tail_files(result)[0]
    with open(os.path.join(result, "tails", tf), encoding="utf-8") as fh:
        envelope = json.load(fh)
    recovered_preview = envelope["preview"]
    print(f"  -> 标记文件: {os.path.basename(marker)}")
    print(f"  -> 残缺尾行 {len(base64.b64decode(envelope['raw_b64']))} 字节，"
          f"起始偏移 {envelope['tail_start_offset']}，预览: {recovered_preview!r}")

    # --------------------------------------------------------------- #
    banner("阶段 5：SIGTERM 优雅重启——从检查点续读，无重复无丢失")
    stop_collector(proc, result)
    cp_before = load_checkpoint(os.path.join(result, "checkpoint.json"))
    before = good_records(result)
    print(f"  -> 重启前 good/ 共 {len(before)} 条")
    proc = start_collector(watch, result)
    time.sleep(0.3)
    emit(7, "重启之后的新记录")
    wait_for(lambda: len(good_records(result)) == len(before) + 1, "重启后续读成功")
    after = good_records(result)
    assert before == after[: len(before)], "重启后旧记录发生变化！"
    print(f"  -> 重启后旧的 {len(before)} 条原样保留，新增第 {len(after)} 条")

    # --------------------------------------------------------------- #
    banner("阶段 6：故障注入——记录已输出、检查点未保存时硬崩溃")
    # 先干净停掉，拿到一致的检查点基线
    stop_collector(proc, result)
    cp = load_checkpoint(os.path.join(result, "checkpoint.json"))
    active_sources = [s for s in cp.sources.values() if not s.finished]
    assert len(active_sources) == 1
    active = active_sources[0]
    good_path = os.path.join(result, "good", f"{active.source_id}.jsonl")
    size_before_crash = os.path.getsize(good_path)

    # 写一条尚未被采集的新记录，崩溃点设在该行结束偏移
    line8 = emit(8, "崩溃窗口目标记录")
    crash_offset = active.offset + len(line8)
    proc = start_collector(
        watch, result, crash=(active.source_id, crash_offset)
    )
    rc = proc.wait(timeout=15)
    assert rc == 9, f"故障注入进程退出码应为 9，实际 {rc}"

    cp_crash = load_checkpoint(os.path.join(result, "checkpoint.json"))
    crashed_state = cp_crash.sources[active.source_id]
    actual_good_size = os.path.getsize(good_path)
    print(f"  -> 进程以退出码 {rc} 硬退出")
    print(f"  -> good/ 实际长度 {actual_good_size} B，检查点 good_size 仍为 "
          f"{crashed_state.good_size} B，偏移停在 {crashed_state.offset}")
    assert actual_good_size == size_before_crash + len(line8)
    assert crashed_state.good_size == size_before_crash  # 检查点没来得及更新
    assert crashed_state.offset == crash_offset - len(line8)

    # --------------------------------------------------------------- #
    banner("阶段 7：重跑——按检查点截断后续读，崩溃窗口记录只保留一份")
    emit(9, "崩溃恢复后的新记录")
    proc = start_collector(watch, result)
    wait_for(lambda: len(good_records(result)) == 9, "重跑后采集继续推进")
    stop_collector(proc, result)
    final = good_records(result)
    seqs = [r["seq"] for r in final]
    # 关键断言：seq=8 恰好一份
    assert seqs.count(8) == 1, f"seq=8 出现了 {seqs.count(8)} 份！"
    cp_recovered = load_checkpoint(os.path.join(result, "checkpoint.json"))
    recovered = cp_recovered.sources[active.source_id]
    assert os.path.getsize(good_path) == recovered.good_size
    print(f"  -> 重启时先按检查点把输出截到 {crashed_state.good_size} B，"
          f"再从偏移 {crashed_state.offset} 重读")
    print(f"  -> seq=8 在结果目录中仅 1 份，最终共 {len(final)} 条记录")

    # --------------------------------------------------------------- #
    banner("阶段 8：最终自动校验")
    checks: list[tuple[str, bool]] = []
    checks.append(("好记录恰好一份（seq 1-9，无重复无丢失）",
                   sorted(seqs) == list(range(1, 10)) and len(seqs) == 9))
    checks.append((f"坏行隔离 {expected_bad} 条且带文件身份/字节偏移",
                   len(bad_entries(result)) == expected_bad
                   and all("line_start_offset" in e for e in bad_entries(result))))
    checks.append(("完成标记产生 1 个残缺尾行文件", len(tail_files(result)) == 1))
    cp_final = load_checkpoint(os.path.join(result, "checkpoint.json"))
    finished = [s for s in cp_final.sources.values() if s.finished]
    checks.append(("轮转后的旧文件已结束跟踪", len(finished) == 1 and finished[0].tail_written))
    checks.append(("每条好记录都是合法 UTF-8 JSON 且中文完整",
                   all(r.get("msg") and isinstance(r["msg"], str) for r in final)))
    # 验证输出文件长度与检查点记录一致
    length_ok = True
    for st in cp_final.sources.values():
        gp = os.path.join(result, "good", f"{st.source_id}.jsonl")
        if os.path.exists(gp) and os.path.getsize(gp) != st.good_size:
            length_ok = False
    checks.append(("输出文件长度与检查点 good_size 完全一致", length_ok))
    # 半行还原验证：活动文件中曾经半行写入的 seq=2 中文完整
    checks.append(("多字节切分还原（中文消息无替换符）",
                   all("�" not in r["msg"] for r in final)))

    width = max(len(name) for name, _ in checks)
    all_ok = True
    for name, ok in checks:
        all_ok &= ok
        print(f"  [{'PASS' if ok else 'FAIL'}] {name.ljust(width)}")

    print("\n结果目录结构:")
    for dirpath, dirnames, filenames in os.walk(result):
        rel = os.path.relpath(dirpath, result)
        indent = "" if rel == "." else "  " * rel.count(os.sep) + "  "
        if rel != ".":
            print(f"{indent}{os.path.basename(dirpath)}/")
        for fn in sorted(filenames):
            if fn == ".stop":
                continue
            size = os.path.getsize(os.path.join(dirpath, fn))
            print(f"{indent}  {fn} ({size} B)")

    print(f"\n演示目录保留在: {work}")
    if "CLEAN" in os.environ:
        shutil.rmtree(work)
        print("(CLEAN 已设置，目录已删除)")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
