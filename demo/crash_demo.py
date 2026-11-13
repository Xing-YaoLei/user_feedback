"""验证崩溃安全：提交前注入异常，确认 current 不指向半成品 run。"""

import os
import shutil

from ingest.config import PipelineConfig
from ingest.pipeline import ingest_batch
from ingest.state import StateStore, iter_jsonl

shutil.rmtree("state_crash", ignore_errors=True)

config = PipelineConfig.load("config_fixed")
store = StateStore("state_crash")

before = store.current_run_dir()
print("崩溃前 current:", before)

# 第一次正常导入，建立一个完整 run
result1 = ingest_batch("examples/batch1/manifest.json", config, store)
after_first = store.current_run_dir()
print("首次导入后 current:", os.path.basename(after_first))

# 在 OpenRun.commit 内部、原子切换 current 之前注入异常，
# 真实模拟「文件已部分写入但尚未发布」的中途退出
from ingest import state as state_mod

real_commit = state_mod.OpenRun.commit

def crashing_commit(self):  # noqa: ANN001
    # 先写出一个部分文件，模拟提交进行到一半的状态
    partial = os.path.join(self.run_dir, "unified.jsonl")
    with open(partial, "w", encoding="utf-8") as fh:
        fh.write('{"partial": true}\n')
    raise KeyboardInterrupt("模拟进程在提交前被中断")

state_mod.OpenRun.commit = crashing_commit
try:
    ingest_batch("examples/batch2/manifest.json", config, store)
except KeyboardInterrupt as exc:
    print("捕获到模拟中断:", exc)
finally:
    state_mod.OpenRun.commit = real_commit

after_crash = store.current_run_dir()
print("崩溃后 current:", os.path.basename(after_crash))
assert after_crash == after_first, "current 被半成品 run 改动了！"
assert os.path.realpath(store.current_link) == after_first

# 半成品 run 目录应带 ABORTED 标记，且不被 current 引用
runs = store.list_run_dirs()
aborted = [r for r in runs if os.path.exists(os.path.join(r, "ABORTED"))]
print("带 ABORTED 标记的半成品 run:", [os.path.basename(r) for r in aborted])
assert aborted, "半成品 run 没有留下 ABORTED 标记"

# 下游仍能完整读到上一个 run 的台账
ledger_rows = list(
    iter_jsonl(os.path.join(after_crash, "published.jsonl"))
)
print("下游仍可读到上一完整 run 的台账条数:", len(ledger_rows))
print("\n崩溃安全验证通过 ✓")
