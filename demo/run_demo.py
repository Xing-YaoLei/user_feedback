#!/usr/bin/env python3
"""端到端演示脚本：从零跑通预检、导入、幂等去重、失败重试全流程。

运行方式（在项目根目录）：
    python3 demo/run_demo.py

脚本只使用标准库，会在项目下创建临时的 state_demo 状态目录，
不影响 examples/ 与 config*/ 里的任何输入文件。
"""

from __future__ import annotations

import os
import shutil
import sys

# 保证可以 import 到项目根目录下的 ingest 包
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from ingest.config import PipelineConfig  # noqa: E402
from ingest.pipeline import ingest_batch, retry_failures  # noqa: E402
from ingest.precheck import run_precheck  # noqa: E402
from ingest.state import StateStore  # noqa: E402

STATE = os.path.join(ROOT, "state_demo")


def banner(title: str) -> None:
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72)


def main() -> int:
    shutil.rmtree(STATE, ignore_errors=True)

    banner("步骤 1：导入前预检（原始配置：content 不可空，存在不兼容）")
    config_orig = PipelineConfig.load(os.path.join(ROOT, "config"))
    report = run_precheck(config_orig)
    for key in sorted(report.pair_reports):
        pair = report.pair_reports[key]
        print(f"  {pair.source}/{pair.version}: "
              f"错误 {len(pair.errors)}，警告 {len(pair.warnings)}")
        for issue in pair.issues:
            if issue.severity == "error":
                print(f"    - [{issue.reason_code}] {issue.message}")
    print(f"  预检结论：{'通过' if report.ok else '不通过（需先修配置）'}")

    banner("步骤 2：用修正后的配置重新预检")
    config = PipelineConfig.load(os.path.join(ROOT, "config_fixed"))
    report = run_precheck(config)
    print(f"  预检结论：{'通过' if report.ok else '不通过'}")
    for key in sorted(report.pair_reports):
        pair = report.pair_reports[key]
        for issue in pair.warnings:
            print(f"    - 警告 [{issue.reason_code}] {issue.message}")

    store = StateStore(STATE)

    banner("步骤 3：导入第一批（客服 JSONL v1/v2 + 订单 CSV v1）")
    r1 = ingest_batch(
        os.path.join(ROOT, "examples/batch1/manifest.json"), config, store
    )
    print(f"  收到 {r1.stats['received']}，发布 {r1.stats['published']}，"
          f"失败 {r1.stats['failed']}")

    banner("步骤 4：导入第二批（订单 CSV v2 + 重复发送 + 未知版本 v9）")
    r2 = ingest_batch(
        os.path.join(ROOT, "examples/batch2/manifest.json"), config, store
    )
    print(f"  收到 {r2.stats['received']}，新发布 {r2.stats['published']}，"
          f"重复跳过 {r2.stats['duplicates']}，失败 {r2.stats['failed']}")
    for drift in r2.content_drift:
        print(f"  - 内容漂移：{drift['idempotency_key']} "
              f"（已保留首次发布内容）")

    banner("步骤 5：映射修正后只重试失败记录（rating 容错 set_null）")
    config_revised = PipelineConfig.load(os.path.join(ROOT, "config_fixed2"))
    r3 = retry_failures(config_revised, store)
    print(f"  重试 {r3.stats['retried']}，成功 {r3.stats['retry_succeeded']}，"
          f"仍失败 {r3.stats['retry_failed']}")
    print("  剩余失败（属于数据本身问题，无法靠配置修复）：")
    import json
    pending_path = os.path.join(
        store.current_run_dir(), "pending_failures.jsonl"
    )
    for line in open(pending_path, encoding="utf-8"):
        d = json.loads(line)
        print(f"    - {d['idempotency_key']} [{d['reason_code']}] {d['reason']}")

    banner("步骤 6：幂等性复核（再次整批重跑，不应产生新发布）")
    r4 = ingest_batch(
        os.path.join(ROOT, "examples/batch1/manifest.json"), config, store
    )
    print(f"  收到 {r4.stats['received']}，新发布 {r4.stats['published']}，"
          f"重复跳过 {r4.stats['duplicates']}，失败 {r4.stats['failed']}")

    banner("下游读取入口")
    print(f"  current 符号链接：{os.path.join(STATE, 'current')}")
    print(f"  指向 run：{os.path.basename(store.current_run_dir())}")
    print("  - unified.jsonl           本批新发布的统一明细")
    print("  - failures.jsonl          本批失败记录")
    print("  - published.jsonl         累计已发布台账（幂等依据）")
    print("  - pending_failures.jsonl  待处理失败清单（重试来源）")
    print("  - manifest.json           本 run 统计与文件清单")
    print("\n演示完成 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
